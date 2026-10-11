pub const REMOTE_HELPER_CAPABILITIES: &[&str] = &[
    "providers",
    // v4 editor projection: helper `providers editor-view` / `add-editor` /
    // `update-editor` reuse the desktop EditorSave path (redacted view,
    // restored base, row rollback when the live write fails).
    "provider-editor",
    "profiles",
    // The legacy TOML patch command was retired upstream.
    "omo",
    "provider-official-seed",
    "provider-model-fetch",
    "opencode-runtime-models",
    "universal-providers",
    "routing-config",
    #[cfg(feature = "proxy-runtime")]
    "routing-runtime",
    #[cfg(feature = "proxy-runtime")]
    "routing-daemon",
    "openclaw",
    "mcp",
    "prompts",
    "skills",
    "sessions",
    "hermes-memory",
    "import-export",
    "restore-preflight",
    "cloud-sync",
    "tools",
    // Reachability-only checks replace the retired real-model test/settings API.
    "connectivity-check",
    "usage",
    "usage-manual-session-sync",
    "usage-model-pricing-sync",
    "auth",
    "auth-targeted-relogin",
    "auth-cancel-login",
    "codex-config-only",
    "settings",
    "settings-app-config-dir",
    "plugin",
    "session",
];

pub const REMOTE_HELPER_REQUIRED_CAPABILITIES: &[&str] = &["providers"];

pub fn remote_helper_capabilities() -> Vec<String> {
    REMOTE_HELPER_CAPABILITIES
        .iter()
        .map(|capability| (*capability).to_string())
        .collect()
}
