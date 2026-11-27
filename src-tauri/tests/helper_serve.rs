use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

/// 写入一份 Codex rollout fixture。
///
/// 时间必须落在 Database::init 的 30 天明细保留窗口内：写死日期会让这个用例随日历
/// 过期（明细被当成历史数据清理掉，导入数对得上但明细查不到）。
fn write_codex_rollout(sessions: &std::path::Path, session_id: &str, first: u64, second: u64) {
    let started = chrono::Utc::now() - chrono::Duration::minutes(5);
    let stamp = |seconds: i64| (started + chrono::Duration::seconds(seconds)).to_rfc3339();
    let path = sessions.join(format!(
        "rollout-{}-{session_id}.jsonl",
        started.format("%Y-%m-%dT%H-%M-%S")
    ));
    let lines = [
        serde_json::json!({
            "timestamp": stamp(0),
            "type": "session_meta",
            "payload": { "id": session_id, "source": "cli" }
        }),
        serde_json::json!({
            "timestamp": stamp(1),
            "type": "turn_context",
            "payload": { "model": "gpt-5.6-sol" }
        }),
        serde_json::json!({
            "timestamp": stamp(2),
            "type": "event_msg",
            "payload": { "type": "token_count", "info": {
                "total_token_usage": {
                    "input_tokens": first,
                    "cached_input_tokens": first / 2,
                    "output_tokens": first / 10,
                    "total_tokens": first + first / 10
                }
            }}
        }),
        serde_json::json!({
            "timestamp": stamp(4),
            "type": "event_msg",
            "payload": { "type": "token_count", "info": {
                "total_token_usage": {
                    "input_tokens": second,
                    "cached_input_tokens": second / 2,
                    "output_tokens": second / 10,
                    "total_tokens": second + second / 10
                }
            }}
        }),
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect::<Vec<_>>()
    .join("\n")
        + "\n";
    std::fs::write(path, lines).expect("write Codex rollout");
}

#[test]
fn production_helper_serve_keeps_session_and_uses_shared_codex_sync() {
    let test_home = tempfile::tempdir().expect("serve test home");
    let started = chrono::Utc::now() - chrono::Duration::minutes(5);
    let sessions = test_home
        .path()
        .join(".codex/sessions")
        .join(started.format("%Y/%m/%d").to_string());
    std::fs::create_dir_all(&sessions).expect("create Codex session directory");
    let session_a = "00000000-0000-4000-8000-0000000000a1";
    let session_b = "00000000-0000-4000-8000-0000000000b2";
    write_codex_rollout(&sessions, session_a, 100, 150);
    write_codex_rollout(&sessions, session_b, 1_000, 1_300);

    let mut child = Command::new(env!("CARGO_BIN_EXE_cc-switch-remote-helper"))
        .arg("serve")
        .env("CC_SWITCH_TEST_HOME", test_home.path())
        .env("HOME", test_home.path())
        .env("XDG_DATA_HOME", test_home.path().join("xdg-data"))
        .env("OPENCODE_DB", test_home.path().join("missing-opencode.db"))
        .env_remove("CC_SWITCH_DISABLE_SESSION_SYNC_FOR_TESTS")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn helper serve session");

    let mut stdin = child.stdin.take().expect("helper stdin");
    stdin
        .write_all(
            concat!(
                r#"{"id":"bad","command":["missing"]}"#,
                "\n",
                r#"{"id":"unit","command":["routing-config","set-global-outbound","-"]}"#,
                "\n",
                r#"{"id":"sync-1","command":["usage","sync-session"]}"#,
                "\n",
                r#"{"id":"sync-2","command":["usage","sync-session"]}"#,
                "\n",
                r#"{"id":"next","command":["status"]}"#,
                "\n"
            )
            .as_bytes(),
        )
        .expect("write helper requests");
    drop(stdin);

    let output = child.wait_with_output().expect("wait for helper session");
    assert!(
        output.status.success(),
        "helper serve session failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = String::from_utf8(output.stdout)
        .expect("helper stdout UTF-8")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("serve response JSON"))
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 5);
    assert_eq!(responses[0]["id"], "bad");
    assert_eq!(responses[0]["ok"], false);
    assert_eq!(responses[0]["error"]["code"], "unsupported_command");
    assert_eq!(responses[1]["id"], "unit");
    assert_eq!(responses[1]["ok"], true);
    assert!(responses[1]["data"].is_null());
    assert_eq!(responses[2]["id"], "sync-1");
    assert_eq!(responses[2]["data"]["imported"], 4);
    assert_eq!(responses[3]["id"], "sync-2");
    assert_eq!(responses[3]["data"]["imported"], 0);
    assert_eq!(responses[3]["data"]["skipped"], 0);
    assert_eq!(responses[4]["id"], "next");
    assert_eq!(responses[4]["ok"], true);
    assert!(responses[4]["data"]["capabilities"].is_array());

    let db_path = test_home.path().join(".cc-switch-remote/cc-switch.db");
    let conn = rusqlite::Connection::open(db_path).expect("open helper database");
    let rows = conn
        .prepare(
            "SELECT session_id, input_tokens FROM proxy_request_logs
             WHERE data_source = 'codex_session'
             ORDER BY session_id, request_id",
        )
        .expect("prepare usage query")
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .expect("query helper usage")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect helper usage");
    assert_eq!(
        rows,
        vec![
            (session_a.to_string(), 100),
            (session_a.to_string(), 50),
            (session_b.to_string(), 1_000),
            (session_b.to_string(), 300),
        ]
    );
    let cursor_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_log_sync WHERE last_line_offset = 4",
            [],
            |row| row.get(0),
        )
        .expect("query persisted helper cursors");
    assert_eq!(cursor_count, 2);

    let upstream_root = test_home.path().join(".cc-switch");
    assert!(
        !upstream_root.exists(),
        "the remote helper must never create or mutate the upstream CC Switch root: {}",
        upstream_root.display()
    );
    assert!(
        !upstream_root.join("cc-switch.db").exists(),
        "the remote helper database must remain isolated under .cc-switch-remote"
    );
}

struct StartupFixture {
    home: tempfile::TempDir,
    claude: std::path::PathBuf,
    codex: std::path::PathBuf,
    settings: std::path::PathBuf,
    db: rusqlite::Connection,
}

const BEFORE: &str = "https://before.invalid/v1";
const AFTER: &str = "https://after.invalid/v1";

impl StartupFixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let claude = home.path().join(".claude/settings.json");
        let codex = home.path().join(".codex/config.toml");
        let config = home.path().join(".cc-switch-remote");
        for path in [&claude, &codex] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        }
        std::fs::write(&claude, Self::claude_config(AFTER).to_string()).unwrap();
        std::fs::write(&codex, Self::codex_config(AFTER)).unwrap();
        let output = Self::helper(home.path())
            .args(["settings", "get"])
            .output()
            .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        let db = rusqlite::Connection::open(config.join("cc-switch.db")).unwrap();
        for (id, endpoint, current) in [("before", BEFORE, 1), ("after", AFTER, 0)] {
            for (app, settings) in [
                ("claude", Self::claude_config(endpoint)),
                (
                    "codex",
                    serde_json::json!({
                        "auth": {"OPENAI_API_KEY": "fixture"},
                        "config": Self::codex_config(endpoint)
                    }),
                ),
            ] {
                db.execute(
                    "INSERT INTO providers (id, app_type, name, settings_config, is_current)
                     VALUES (?1, ?2, ?1, ?3, ?4)",
                    rusqlite::params![id, app, settings.to_string(), current],
                )
                .unwrap();
            }
        }
        Self {
            home,
            claude,
            codex,
            settings: config.join("settings.json"),
            db,
        }
    }

    fn claude_config(endpoint: &str) -> serde_json::Value {
        serde_json::json!({"env": {"ANTHROPIC_BASE_URL": endpoint, "ANTHROPIC_AUTH_TOKEN": "fixture"}})
    }

    fn codex_config(endpoint: &str) -> String {
        format!("model_provider = 'fixture'\n[model_providers.fixture]\nname = 'Fixture'\nbase_url = '{endpoint}'\nwire_api = 'responses'\n")
    }

    fn helper(home: &std::path::Path) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_cc-switch-remote-helper"));
        command.env("CC_SWITCH_TEST_HOME", home).env("HOME", home);
        command
    }

    fn serve(&self) -> std::process::Child {
        Self::helper(self.home.path())
            .args(["--json", "serve"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap()
    }

    fn live_files(&self) -> [Vec<u8>; 2] {
        [&self.claude, &self.codex].map(|path| std::fs::read(path).unwrap())
    }

    fn set_direct_pointers(&self, id: &str, silent: bool) {
        std::fs::write(
            &self.settings,
            serde_json::json!({
                "currentProviderClaude": id,
                "currentProviderCodex": id,
                "silentStartup": silent
            })
            .to_string(),
        )
        .unwrap();
    }
}

fn serve_request(
    input: &mut impl Write,
    output: &mut impl BufRead,
    command: &[&str],
) -> serde_json::Value {
    writeln!(
        input,
        "{}",
        serde_json::json!({"id": "fixture", "command": command})
    )
    .unwrap();
    input.flush().unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["data"].clone()
}

#[test]
fn helper_startup_reconnect_preserves_claude_and_codex_live_files_and_provider_rows() {
    let fixture = StartupFixture::new();
    std::fs::write(
        &fixture.claude,
        StartupFixture::claude_config(BEFORE).to_string(),
    )
    .unwrap();
    std::fs::write(&fixture.codex, StartupFixture::codex_config(BEFORE)).unwrap();
    let before_switch = fixture.live_files();
    let legacy = StartupFixture::claude_config(BEFORE).to_string();
    fixture
        .db
        .execute(
            "INSERT INTO proxy_live_backup (app_type, original_config, backed_up_at)
         VALUES ('claude', ?1, 'fixture'), ('codex', ?2, 'fixture')",
            rusqlite::params![
                legacy,
                serde_json::json!({"config": StartupFixture::codex_config(BEFORE)}).to_string()
            ],
        )
        .unwrap();
    let mut helper = fixture.serve();
    let mut input = helper.stdin.take().unwrap();
    let mut output = BufReader::new(helper.stdout.take().unwrap());
    for app in ["claude", "codex"] {
        serve_request(
            &mut input,
            &mut output,
            &["providers", "switch", app, "after"],
        );
    }
    drop(input);
    assert!(helper.wait().unwrap().success());
    let expected = fixture.live_files();
    assert_ne!(expected, before_switch);
    for config in &expected {
        assert!(String::from_utf8_lossy(config).contains(AFTER));
    }
    let legacy_backup_count = fixture
        .db
        .query_row("SELECT COUNT(*) FROM proxy_live_backup", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    assert_eq!(legacy_backup_count, 0);
    fixture
        .db
        .execute(
            "INSERT INTO proxy_live_backup (app_type, original_config, backed_up_at)
         VALUES ('claude', ?1, 'fixture'), ('codex', ?2, 'fixture')",
            rusqlite::params![
                StartupFixture::claude_config(BEFORE).to_string(),
                serde_json::json!({"config": StartupFixture::codex_config(BEFORE)}).to_string()
            ],
        )
        .unwrap();
    for _ in 0..2 {
        let mut helper = fixture.serve();
        let mut input = helper.stdin.take().unwrap();
        let mut output = BufReader::new(helper.stdout.take().unwrap());
        for app in ["claude", "codex"] {
            let one_shot_output = StartupFixture::helper(fixture.home.path())
                .args(["providers", "state", app])
                .output()
                .unwrap();
            let one_shot: serde_json::Value =
                serde_json::from_slice(&one_shot_output.stdout).unwrap();
            assert_eq!(one_shot["data"]["currentProviderId"], "after", "{one_shot}");
            let provider_state =
                serve_request(&mut input, &mut output, &["providers", "state", app]);
            assert_eq!(provider_state["currentProviderId"], "after");
            assert!(provider_state["providers"]["after"]
                .to_string()
                .contains(AFTER));
        }
        serve_request(&mut input, &mut output, &["settings", "get"]);
        #[cfg(feature = "proxy-runtime")]
        serve_request(&mut input, &mut output, &["app-mode", "takeover-status"]);
        drop(input);
        assert!(helper.wait().unwrap().success());
        assert_eq!(fixture.live_files(), expected);
        assert_eq!(
            fixture
                .db
                .query_row("SELECT COUNT(*) FROM proxy_live_backup", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(fixture.db.query_row("SELECT COUNT(*) FROM providers WHERE id = 'after' AND instr(settings_config, ?1) > 0", [AFTER], |row| row.get::<_, i64>(0)).unwrap(), 2);
    }
}

#[test]
fn helper_startup_reconnect_erases_an_invalid_saved_outbound_proxy() {
    let fixture = StartupFixture::new();
    fixture.db.execute(
        "INSERT INTO settings (key, value) VALUES ('global_proxy_url', 'fixture://before.invalid')",
        [],
    ).unwrap();
    let expected = fixture.live_files();
    let mut helper = fixture.serve();
    let mut input = helper.stdin.take().unwrap();
    let mut output = BufReader::new(helper.stdout.take().unwrap());
    serve_request(&mut input, &mut output, &["status"]);
    drop(input);
    assert!(helper.wait().unwrap().success());
    assert_eq!(fixture.live_files(), expected);
    assert_eq!(
        fixture
            .db
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'global_proxy_url'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn helper_startup_reconnect_keeps_current_provider_reads_fresh_and_read_only() {
    let fixture = StartupFixture::new();
    fixture.set_direct_pointers("before", false);
    let mut old_helper = fixture.serve();
    let mut old_input = old_helper.stdin.take().unwrap();
    let mut old_output = BufReader::new(old_helper.stdout.take().unwrap());
    let initial = std::fs::read(&fixture.settings).unwrap();
    assert_eq!(
        serve_request(
            &mut old_input,
            &mut old_output,
            &["providers", "current", "claude"]
        ),
        "before"
    );
    let mut stale = serve_request(&mut old_input, &mut old_output, &["settings", "get"]);
    assert_eq!(std::fs::read(&fixture.settings).unwrap(), initial);
    assert!(!fixture.settings.with_extension("json.lock").exists());

    let mut fresh_helper = fixture.serve();
    let mut fresh_input = fresh_helper.stdin.take().unwrap();
    let mut fresh_output = BufReader::new(fresh_helper.stdout.take().unwrap());
    for app in ["claude", "codex"] {
        serve_request(
            &mut fresh_input,
            &mut fresh_output,
            &["providers", "switch", app, "after"],
        );
    }
    let mut fresh = serve_request(&mut fresh_input, &mut fresh_output, &["settings", "get"]);
    fresh["silentStartup"] = true.into();
    serve_request(
        &mut fresh_input,
        &mut fresh_output,
        &["settings", "save", &fresh.to_string()],
    );
    let saved = std::fs::read(&fixture.settings).unwrap();
    let mut newest: serde_json::Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(newest["currentProviderClaude"], "after");
    assert_eq!(newest["currentProviderCodex"], "after");
    assert_eq!(newest["silentStartup"], true);
    let live = fixture.live_files();
    for app in ["claude", "codex"] {
        assert_eq!(
            serve_request(
                &mut old_input,
                &mut old_output,
                &["providers", "current", app]
            ),
            "after"
        );
        assert_eq!(
            serve_request(
                &mut fresh_input,
                &mut fresh_output,
                &["providers", "current", app]
            ),
            "after"
        );
    }
    assert_eq!(std::fs::read(&fixture.settings).unwrap(), saved);

    serve_request(
        &mut old_input,
        &mut old_output,
        &["providers", "switch", "claude", "before"],
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&fixture.settings).unwrap()).unwrap();
    newest["currentProviderClaude"] = "before".into();
    assert_eq!(persisted, newest);
    assert_eq!(fixture.live_files()[1], live[1]);

    stale["usageConfirmed"] = true.into();
    stale["silentStartup"] = true.into();
    serve_request(
        &mut old_input,
        &mut old_output,
        &["settings", "save", &stale.to_string()],
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&fixture.settings).unwrap()).unwrap();
    newest["usageConfirmed"] = true.into();
    assert_eq!(persisted, newest);

    fixture
        .db
        .execute("UPDATE providers SET is_current = (id = 'after')", [])
        .unwrap();

    fixture
        .db
        .execute("DELETE FROM providers WHERE id = 'before'", [])
        .unwrap();
    let saved = std::fs::read(&fixture.settings).unwrap();
    let live = fixture.live_files();
    assert_eq!(
        serve_request(
            &mut old_input,
            &mut old_output,
            &["providers", "current", "claude"]
        ),
        "after"
    );
    assert_eq!(std::fs::read(&fixture.settings).unwrap(), saved);
    assert_eq!(fixture.live_files(), live);

    let corrupt = br#"{"currentProviderClaude":"before","silentStartup":"invalid"}"#;
    std::fs::write(&fixture.settings, corrupt).unwrap();
    assert_eq!(
        serve_request(
            &mut old_input,
            &mut old_output,
            &["providers", "current", "claude"]
        ),
        "after"
    );
    assert_eq!(std::fs::read(&fixture.settings).unwrap(), corrupt);
    assert_eq!(fixture.live_files(), live);
    drop(old_input);
    assert!(old_helper.wait().unwrap().success());
    drop(fresh_input);
    assert!(fresh_helper.wait().unwrap().success());
}

#[cfg(feature = "proxy-runtime")]
#[test]
fn helper_startup_reconnect_differs_from_explicit_routing_stop() {
    let fixture = StartupFixture::new();
    fixture.set_direct_pointers("before", false);
    std::fs::write(
        fixture.settings.with_file_name("live-state.json"),
        r#"{"apps":{"claude":{"mode":"proxy","attached":true,"proxy_route":"after"},"codex":{"mode":"proxy","attached":true,"proxy_route":"after"}}}"#,
    ).unwrap();
    let expected = fixture.live_files();
    let mut helper = fixture.serve();
    let mut input = helper.stdin.take().unwrap();
    let mut output = BufReader::new(helper.stdout.take().unwrap());
    serve_request(&mut input, &mut output, &["settings", "get"]);
    assert_eq!(fixture.live_files(), expected);
    serve_request(&mut input, &mut output, &["routing-runtime", "stop"]);
    drop(input);
    assert!(helper.wait().unwrap().success());
    for (app, bytes) in ["claude", "codex"].into_iter().zip(fixture.live_files()) {
        let config = String::from_utf8(bytes).unwrap();
        assert!(config.contains(BEFORE), "{app}: {config}");
    }
}
