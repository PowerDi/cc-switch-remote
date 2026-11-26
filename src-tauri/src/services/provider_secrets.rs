use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use toml_edit::{visit_mut::VisitMut, DocumentMut, Item, KeyMut, TableLike};

use crate::app_config::AppType;
use crate::provider::Provider;

pub const REDACTED_SECRET_SENTINEL: &str = "[redacted]";

pub fn is_model_fetch_header_placeholder(name: &str, value: &str) -> bool {
    value.trim() == REDACTED_SECRET_SENTINEL || (value.is_empty() && is_secret_key(name))
}

pub fn restore_model_fetch_headers(
    provider: &Provider,
    app: &AppType,
    headers: &mut BTreeMap<String, String>,
) {
    let native_path = match app {
        AppType::OpenCode | AppType::Mcode => Some("/options/headers"),
        AppType::Pi | AppType::Omp => Some("/headers"),
        _ => None,
    };
    let native = native_path
        .and_then(|path| provider.settings_config.pointer(path))
        .and_then(Value::as_object);
    let proxy = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.local_proxy_request_overrides.as_ref());
    for (name, value) in headers {
        if !is_model_fetch_header_placeholder(name, value) {
            continue;
        }
        let saved = if native_path.is_some() {
            native
                .and_then(|headers| {
                    headers
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case(name))
                })
                .and_then(|(_, value)| value.as_str())
        } else {
            proxy
                .and_then(|overrides| {
                    overrides
                        .headers
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case(name))
                })
                .map(|(_, value)| value.as_str())
        };
        if let Some(saved) = saved {
            *value = saved.to_string();
        }
    }
}

pub fn redact_provider_map_secret_values(value: &mut Value, app: Option<&AppType>) {
    match value {
        Value::Object(providers) => {
            for provider in providers.values_mut() {
                if let Some((app, settings)) = app.zip(provider.get_mut("settingsConfig")) {
                    redact_provider_toml(app, settings);
                }
                redact_secret_values(provider);
            }
        }
        _ => redact_secret_values(value),
    }
}

pub fn redact_secret_values(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if should_redact(key, child) {
                    *child = Value::String(REDACTED_SECRET_SENTINEL.to_string());
                } else {
                    redact_secret_values(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_secret_values(item);
            }
        }
        _ => {}
    }
}

pub fn uses_provider_toml(app: &AppType) -> bool {
    matches!(app, AppType::Codex | AppType::GrokBuild)
}

pub fn redact_provider_toml(app: &AppType, settings: &mut Value) {
    if uses_provider_toml(app) {
        if let Some(config) = settings.get_mut("config") {
            if let Some(text) = config.as_str() {
                *config = Value::String(redact_config_toml(text));
            }
        }
    }
}

pub fn redact_inactive_provider_field(path: &[String], value: &mut Value, toml_fragment: bool) {
    if toml_fragment && value.is_string() {
        *value = Value::String(redact_config_toml(value.as_str().unwrap_or_default()));
    } else if path.last().is_some_and(|key| should_redact(key, value)) {
        *value = Value::String(REDACTED_SECRET_SENTINEL.to_string());
    } else {
        redact_secret_values(value);
    }
}

fn should_redact(key: &str, value: &Value) -> bool {
    is_secret_key(key) && !value.is_null() && value.as_str() != Some("")
}

struct TomlSecretMask;

impl VisitMut for TomlSecretMask {
    fn visit_table_like_kv_mut(&mut self, key: KeyMut<'_>, item: &mut Item) {
        if is_secret_key(key.get()) && item.as_str().is_some_and(|value| !value.is_empty()) {
            replace_toml_string(item, REDACTED_SECRET_SENTINEL);
        } else {
            self.visit_item_mut(item);
        }
    }
}

#[derive(Default)]
struct TomlPlaceholderCheck(bool);

impl VisitMut for TomlPlaceholderCheck {
    fn visit_value_mut(&mut self, value: &mut toml_edit::Value) {
        self.0 |= value.as_str() == Some(REDACTED_SECRET_SENTINEL);
        toml_edit::visit_mut::visit_value_mut(self, value);
    }
}

fn has_toml_placeholder(doc: &mut DocumentMut) -> bool {
    let mut check = TomlPlaceholderCheck::default();
    check.visit_document_mut(doc);
    check.0 || doc.contains_key("redacted")
}

fn replace_toml_string(item: &mut Item, text: &str) {
    if let Some(value) = item.as_value_mut() {
        let decor = value.decor().clone();
        *value = toml_edit::Value::from(text);
        *value.decor_mut() = decor;
    }
}

fn restore_toml_table(previous: &dyn TableLike, incoming: &mut dyn TableLike) {
    for (key, item) in incoming.iter_mut() {
        let Some(saved) = previous.get(key.get()) else {
            continue;
        };
        if is_secret_key(key.get()) && item.as_str() == Some(REDACTED_SECRET_SENTINEL) {
            if let Some(original) = saved.as_str().filter(|text| !text.is_empty()) {
                replace_toml_string(item, original);
            }
        } else if let (Some(saved), Some(item)) = (saved.as_table_like(), item.as_table_like_mut())
        {
            restore_toml_table(saved, item);
        } else if let (Some(saved), Some(item)) =
            (saved.as_array_of_tables(), item.as_array_of_tables_mut())
        {
            for (saved, item) in saved.iter().zip(item.iter_mut()) {
                restore_toml_array_table(saved, item);
            }
        } else if let (Some(saved), Some(item)) = (saved.as_array(), item.as_array_mut()) {
            restore_toml_array(saved, item);
        }
    }
}

fn restore_toml_array(previous: &toml_edit::Array, incoming: &mut toml_edit::Array) {
    for (saved, item) in previous.iter().zip(incoming.iter_mut()) {
        match (saved, item) {
            (toml_edit::Value::InlineTable(saved), toml_edit::Value::InlineTable(item)) => {
                restore_toml_array_table(saved, item);
            }
            (toml_edit::Value::Array(saved), toml_edit::Value::Array(item)) => {
                restore_toml_array(saved, item);
            }
            _ => {}
        }
    }
}

fn restore_toml_array_table(previous: &dyn TableLike, incoming: &mut dyn TableLike) {
    if ["name", "id"].iter().all(|key| {
        previous.get(key).and_then(Item::as_str) == incoming.get(key).and_then(Item::as_str)
    }) {
        restore_toml_table(previous, incoming);
    }
}

fn redact_config_toml(text: &str) -> String {
    let Ok(mut doc) = text.parse::<DocumentMut>() else {
        return REDACTED_SECRET_SENTINEL.to_string();
    };
    TomlSecretMask.visit_document_mut(&mut doc);
    doc.to_string()
}

fn restore_codex_legacy_bearer(existing: &str, incoming: &mut DocumentMut) {
    let route_id = crate::live::project::codex::ROUTE_ID;
    if incoming.get("model_provider").and_then(Item::as_str) == Some(route_id) {
        if let Some(token) = incoming
            .get_mut("model_providers")
            .and_then(Item::as_table_like_mut)
            .and_then(|providers| providers.get_mut(route_id))
            .and_then(Item::as_table_like_mut)
            .and_then(|route| route.get_mut("experimental_bearer_token"))
            .filter(|token| token.as_str() == Some(REDACTED_SECRET_SENTINEL))
        {
            if let Some(saved) =
                crate::codex_config::extract_codex_experimental_bearer_token(existing)
            {
                replace_toml_string(token, &saved);
            }
        }
    }
}

pub fn has_provider_toml_placeholder(app: &AppType, settings: &Value) -> bool {
    uses_provider_toml(app)
        && settings["config"]
            .as_str()
            .is_some_and(|text| text.contains(REDACTED_SECRET_SENTINEL))
}

pub fn restore_provider_toml(
    app: &AppType,
    existing: Option<&Value>,
    incoming: &mut Value,
) -> Result<(), String> {
    if !has_provider_toml_placeholder(app, incoming) {
        return Ok(());
    }
    let source = existing
        .and_then(|settings| settings["config"].as_str())
        .unwrap_or_default();
    let text = incoming["config"].as_str().unwrap_or_default();
    let unresolved = || {
        "Remote provider TOML contains a credential that could not be restored; reopen the editor or replace the placeholder".to_string()
    };
    let mut doc = text.parse::<DocumentMut>().map_err(|_| unresolved())?;
    if !has_toml_placeholder(&mut doc) {
        return Ok(());
    }
    let previous = source.parse::<DocumentMut>().map_err(|_| unresolved())?;
    restore_toml_table(previous.as_table(), doc.as_table_mut());
    if app == &AppType::Codex {
        restore_codex_legacy_bearer(source, &mut doc);
    }
    if has_toml_placeholder(&mut doc) {
        return Err(unresolved());
    }
    incoming["config"] = Value::String(doc.to_string());
    Ok(())
}

pub fn restore_redacted_secret_values(
    existing_provider: &Provider,
    provider: &mut Provider,
) -> Result<(), serde_json::Error> {
    restore_redacted_secret_values_for(existing_provider, provider)
}

pub fn restore_redacted_secret_values_for<T>(
    existing: &T,
    incoming: &mut T,
) -> Result<(), serde_json::Error>
where
    T: Serialize + DeserializeOwned,
{
    let existing = serde_json::to_value(existing)?;
    let mut incoming_value = serde_json::to_value(&incoming)?;
    merge_redacted_secret_values(&existing, &mut incoming_value);
    *incoming = serde_json::from_value(incoming_value)?;
    Ok(())
}

fn merge_redacted_secret_values(existing: &Value, incoming: &mut Value) {
    match (existing, incoming) {
        (Value::Object(existing_map), Value::Object(incoming_map)) => {
            for (key, incoming_child) in incoming_map.iter_mut() {
                if is_secret_key(key) && is_redacted_sentinel(incoming_child) {
                    if let Some(existing_child) = existing_map.get(key) {
                        *incoming_child = existing_child.clone();
                    }
                } else if let Some(existing_child) = existing_map.get(key) {
                    merge_redacted_secret_values(existing_child, incoming_child);
                }
            }
        }
        (Value::Array(existing_items), Value::Array(incoming_items)) => {
            for (existing_child, incoming_child) in existing_items.iter().zip(incoming_items) {
                merge_redacted_secret_values(existing_child, incoming_child);
            }
        }
        _ => {}
    }
}

pub(crate) fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    if matches!(
        normalized.replace('_', "").as_str(),
        "maxtokens"
            | "maxoutputtokens"
            | "maxinputtokens"
            | "maxcompletiontokens"
            | "modelmaxoutputtokens"
            | "maxtokensfield"
    ) {
        return false;
    }
    let normalized = normalized.replace('-', "");
    normalized == "key"
        || normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.ends_with("authorization")
}

fn is_redacted_sentinel(value: &Value) -> bool {
    value.as_str() == Some(REDACTED_SECRET_SENTINEL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_output_redacts_nested_secret_values() {
        let mut value = json!({
            "provider": {
                "settingsConfig": {
                    "env": {
                        "ANTHROPIC_AUTH_TOKEN": "sk-secret",
                        "ANTHROPIC_BASE_URL": "https://example.com",
                        "OPENAI_API_KEY": "sk-openai"
                    }
                },
                "meta": {
                    "usage_script": {
                        "accessToken": "user-token",
                        "baseUrl": "https://usage.example.com"
                    }
                }
            }
        });

        redact_secret_values(&mut value);

        assert_eq!(
            value["provider"]["settingsConfig"]["env"]["ANTHROPIC_AUTH_TOKEN"],
            REDACTED_SECRET_SENTINEL
        );
        assert_eq!(
            value["provider"]["settingsConfig"]["env"]["OPENAI_API_KEY"],
            REDACTED_SECRET_SENTINEL
        );
        assert_eq!(
            value["provider"]["meta"]["usage_script"]["accessToken"],
            REDACTED_SECRET_SENTINEL
        );
        assert_eq!(
            value["provider"]["settingsConfig"]["env"]["ANTHROPIC_BASE_URL"],
            "https://example.com"
        );
    }

    #[test]
    fn provider_roundtrip_preserves_model_output_limits_and_masks_credentials() {
        let mut provider = Provider::with_id(
            "existing".into(),
            "Existing".into(),
            json!({
                "apiKey": "fixture-key",
                "models": [{
                    "id": "historical-model",
                    "maxTokens": 16384,
                    "compat": { "maxTokensField": "max_completion_tokens" }
                }],
                "modelCatalog": { "max_output_tokens": 32768 }
            }),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            max_output_tokens: Some(65536),
            ..Default::default()
        });
        let mut wire = serde_json::to_value(&provider).unwrap();
        redact_secret_values(&mut wire);
        assert_eq!(wire["settingsConfig"]["apiKey"], REDACTED_SECRET_SENTINEL);
        assert_eq!(wire["settingsConfig"]["models"][0]["maxTokens"], 16384);
        assert_eq!(
            wire["settingsConfig"]["models"][0]["compat"]["maxTokensField"],
            "max_completion_tokens"
        );
        assert_eq!(
            wire["settingsConfig"]["modelCatalog"]["max_output_tokens"],
            32768
        );
        assert_eq!(wire["meta"]["maxOutputTokens"], 65536);

        wire["settingsConfig"]["models"][0]["maxTokens"] = json!(32000);
        let mut edited: Provider = serde_json::from_value(wire).unwrap();
        restore_redacted_secret_values(&provider, &mut edited).unwrap();
        assert_eq!(edited.settings_config["apiKey"], "fixture-key");
        assert_eq!(edited.settings_config["models"][0]["maxTokens"], 32000);
        let mut reopened = serde_json::to_value(edited).unwrap();
        redact_secret_values(&mut reopened);
        assert_eq!(reopened["settingsConfig"]["models"][0]["maxTokens"], 32000);
    }

    #[test]
    fn embedded_config_masks_and_restores_secrets_without_overwriting_edits() {
        let saved = json!({
            "config": "model_provider = 'proxy'\n[model_providers.proxy]\nbase_url = 'https://fixture.example/v1'\nexperimental_bearer_token = 'fixture-codex'\n[model.grok]\napi_key = 'fixture-grok'\nmax_tokens = 16384\n",
            "env": { "ANTHROPIC_AUTH_TOKEN": "" },
            "headers": { "x-api-key": "fixture-header", "cf-aig-authorization": "fixture-auth" }
        });
        let mut wire = saved.clone();
        redact_provider_toml(&AppType::Codex, &mut wire);
        redact_secret_values(&mut wire);
        let text = wire["config"].as_str().unwrap();
        assert!(!text.contains("fixture-codex"));
        assert!(!text.contains("fixture-grok"));
        let config = text.parse::<toml::Value>().unwrap();
        assert_eq!(
            config["model"]["grok"]["max_tokens"].as_integer(),
            Some(16384)
        );
        assert_eq!(wire["env"]["ANTHROPIC_AUTH_TOKEN"], "");
        assert_eq!(wire["headers"]["x-api-key"], REDACTED_SECRET_SENTINEL);
        assert_eq!(
            wire["headers"]["cf-aig-authorization"],
            REDACTED_SECRET_SENTINEL
        );

        let mut draft = text.parse::<DocumentMut>().unwrap();
        draft["model"]["grok"]["api_key"] = toml_edit::value("draft-grok");
        wire["config"] = json!(draft.to_string());
        restore_provider_toml(&AppType::Codex, Some(&saved), &mut wire).unwrap();
        restore_redacted_secret_values_for(&saved, &mut wire).unwrap();
        let restored = wire["config"]
            .as_str()
            .unwrap()
            .parse::<toml::Value>()
            .unwrap();
        assert_eq!(
            restored["model_providers"]["proxy"]["experimental_bearer_token"].as_str(),
            Some("fixture-codex")
        );
        assert_eq!(
            restored["model"]["grok"]["api_key"].as_str(),
            Some("draft-grok")
        );

        let mut inactive = json!("[custom]\napi_key = 'fixture-inactive'\n");
        redact_inactive_provider_field(&["custom".into()], &mut inactive, true);
        assert!(!inactive.as_str().unwrap().contains("fixture-inactive"));
    }

    #[test]
    fn embedded_toml_restores_secret_fields_inside_arrays_and_inline_headers() {
        let saved = r#"
servers = [{ name = "fixture", headers = { Authorization = "fixture-inline-array" } }]
[model_providers.custom]
http_headers = { Authorization = "fixture-inline-header", Accept = "application/json" }
[[accounts]]
name = "first"
token = "fixture-account-one"
[[accounts]]
name = "second"
token = "fixture-account-two"
[[mcp_servers.gateway.oauth_headers]]
X-Api-Key = "fixture-gateway"
"#;
        let masked = redact_config_toml(saved);
        for secret in [
            "fixture-inline-array",
            "fixture-inline-header",
            "fixture-account-one",
            "fixture-account-two",
            "fixture-gateway",
        ] {
            assert!(!masked.contains(secret));
        }
        let mut draft = json!({"config": masked});
        restore_provider_toml(&AppType::Codex, Some(&json!({"config": saved})), &mut draft)
            .unwrap();
        let restored = draft["config"].as_str().unwrap();
        assert_eq!(
            restored.parse::<toml::Value>().unwrap(),
            saved.parse::<toml::Value>().unwrap()
        );
    }

    #[test]
    fn codex_projection_can_restore_a_legacy_bearer_in_the_normalized_route() {
        let saved = json!({
            "config": "model_provider = 'legacy'\n[model_providers.legacy]\nexperimental_bearer_token = 'fixture-legacy'\n"
        });
        let mut projected = json!({
            "config": "model_provider = 'custom'\n[model_providers.custom]\nexperimental_bearer_token = '[redacted]'\n"
        });

        restore_provider_toml(&AppType::Codex, Some(&saved), &mut projected).unwrap();

        assert_eq!(
            crate::codex_config::extract_codex_experimental_bearer_token(
                projected["config"].as_str().unwrap(),
            )
            .as_deref(),
            Some("fixture-legacy")
        );
    }

    #[test]
    fn provider_map_redaction_does_not_treat_provider_ids_as_secret_keys() {
        let mut value = json!({
            "secret-provider": {
                "id": "secret-provider",
                "settingsConfig": {
                    "env": {
                        "ANTHROPIC_AUTH_TOKEN": "sk-secret",
                        "ANTHROPIC_BASE_URL": "https://example.com"
                    }
                }
            }
        });

        redact_provider_map_secret_values(&mut value, Some(&AppType::Claude));

        assert_eq!(value["secret-provider"]["id"], "secret-provider");
        assert_eq!(
            value["secret-provider"]["settingsConfig"]["env"]["ANTHROPIC_AUTH_TOKEN"],
            REDACTED_SECRET_SENTINEL
        );
        assert_eq!(
            value["secret-provider"]["settingsConfig"]["env"]["ANTHROPIC_BASE_URL"],
            "https://example.com"
        );
    }

    #[test]
    fn toml_scope_does_not_mask_other_apps_or_nested_config_strings() {
        let saved = json!({"config": "client specific data", "options": {"config": "not TOML"}});
        let mut non_toml = saved.clone();
        redact_provider_toml(&AppType::OpenCode, &mut non_toml);
        redact_secret_values(&mut non_toml);
        assert_eq!(non_toml, saved);

        let mut invalid_toml = saved.clone();
        redact_provider_toml(&AppType::GrokBuild, &mut invalid_toml);
        assert_eq!(invalid_toml["config"], REDACTED_SECRET_SENTINEL);
        assert_eq!(invalid_toml["options"], saved["options"]);
        assert!(
            restore_provider_toml(&AppType::GrokBuild, Some(&saved), &mut invalid_toml).is_err()
        );
        assert_eq!(invalid_toml["config"], REDACTED_SECRET_SENTINEL);
    }

    #[test]
    fn unmatched_toml_placeholders_fail_without_restoring_secrets_to_other_array_rows() {
        let saved = json!({"config": "[[accounts]]\nname = 'original'\ntoken = 'fixture-token'\n"});
        let mut draft =
            json!({"config": "[[accounts]]\nname = 'different'\ntoken = '[redacted]'\n"});
        let before = draft.clone();
        assert!(restore_provider_toml(&AppType::Codex, Some(&saved), &mut draft).is_err());
        assert!(restore_provider_toml(&AppType::Codex, None, &mut draft).is_err());
        assert_eq!(draft, before);
        draft["config"] = json!("unexpected_field = ['[redacted]']\n");
        assert!(restore_provider_toml(&AppType::Codex, Some(&saved), &mut draft).is_err());
        draft["config"] = json!("[redacted]\nmodel = 'generated'\n");
        assert!(restore_provider_toml(&AppType::Codex, Some(&saved), &mut draft).is_err());
        draft["config"] = json!("[[accounts]]\nname = 'different'\ntoken = 'explicit-new-key'\n");
        assert!(restore_provider_toml(&AppType::Codex, Some(&saved), &mut draft).is_ok());
    }

    #[derive(Debug, serde::Deserialize, serde::Serialize, PartialEq)]
    struct UniversalLike {
        #[serde(rename = "apiKey")]
        api_key: String,
        base_url: String,
    }

    #[test]
    fn generic_restore_preserves_redacted_universal_provider_api_key() {
        let existing = UniversalLike {
            api_key: "sk-existing".to_string(),
            base_url: "https://old.example.com".to_string(),
        };
        let mut incoming = UniversalLike {
            api_key: REDACTED_SECRET_SENTINEL.to_string(),
            base_url: "https://new.example.com".to_string(),
        };

        restore_redacted_secret_values_for(&existing, &mut incoming)
            .expect("restore redacted universal provider secret");

        assert_eq!(incoming.api_key, "sk-existing");
        assert_eq!(incoming.base_url, "https://new.example.com");
    }
}
