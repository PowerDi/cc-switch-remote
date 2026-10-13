# Remote Feature Parity Matrix

This document tracks how remote management maps to the local CC Switch feature set. Remote features must stay target-aware: local state is not the source of truth for a remote host, and unsupported local-only features should be hidden, disabled, or documented instead of exposed as broken controls.

## Status Terms

- `parity`: remote uses the same user workflow and shared target-aware logic as local.
- `remote-adapted`: remote intentionally differs because the action runs on another host or depends on SSH/helper state.
- `local-only`: feature is tied to the desktop app or the local OS session and should not be remote-managed without a separate design.
- `next`: useful remote capability that is not complete enough to call parity.

## Settings Modules

| Local module | Remote module | Status | Notes |
| --- | --- | --- | --- |
| General: main page app visibility | General | parity | Saved in the selected remote host settings. |
| General: Skills storage location | General | parity | Uses remote helper migration command. |
| General: Skills sync method | General | parity | Saved in remote settings. |
| General: Codex app enhancements | General | parity | Saved in remote settings and applied on the remote host. |
| General: window behavior Claude plugin options | General | remote-adapted | Applies remote Claude Code plugin config and onboarding skip through helper commands. |
| General: language, theme | none | local-only | These control the desktop UI only. |
| General: preferred terminal | none | local-only | Terminal launch is local desktop behavior. |
| Routing: runtime start/stop | Routing | parity | Remote runtime is started/stopped through helper session commands. |
| Routing: app routing toggles | Routing and home page | parity | Uses remote target app routing config; enabling a home-page app route starts the remote routing runtime first when needed. |
| Routing: show route/failover on home page | Routing | parity | Uses remote-specific setting keys so local and remote homepage controls stay independent. |
| Routing: failover queue | Routing | parity | Queue actions run against remote routing state. |
| Routing: automatic failover | Routing | parity | Uses remote provider health and circuit breaker commands. |
| Routing: rectifier and optimizer | Routing | parity | Uses target-aware rectifier panel and remote commands. |
| Routing: global outbound proxy | Routing | remote-adapted | Configures the remote host outbound proxy, not the desktop network proxy. |
| Auth: managed accounts | Auth | parity | AuthCenterPanel is target-aware and calls remote helper auth commands. |
| Advanced: config directories | Advanced | remote-adapted | Tool config dirs are remote settings; CC Switch app config dir requires helper `settings-app-config-dir`. |
| Advanced: import/export | Advanced | parity | Imports/exports the selected remote host state. |
| Advanced: backup and restore | Advanced | parity | Backup list and restore actions target the remote host database. |
| Advanced: WebDAV/S3 cloud sync | Advanced | parity | Sync actions target the remote host state and settings. |
| Advanced: model test config | Advanced | parity | Stream check config and checks are target-aware. |
| Advanced: log config | Advanced | parity | Reads/writes remote log settings through helper settings commands. |
| Usage statistics | Usage | parity | Summary, trends, logs, pricing, and sync actions are target-aware. |
| About: app release/update | local About | local-only | Desktop app update belongs to the local application. The update badge opens the local About settings even when the active management target is remote. |
| About: install conflict diagnostics | Remote | remote-adapted | Remote environment diagnostics live in the Remote tab. |

## Feature Areas

| Feature area | Status | Notes |
| --- | --- | --- |
| Remote host profiles | remote-adapted | Stored locally because they describe SSH connection targets; remote passwords are local connection secrets, not provider secrets. |
| Helper install/update | remote-adapted | Installs GitHub release assets on the remote host. If remote download fails, the desktop app can download and upload through SSH. |
| Helper version/update detection | remote-adapted | UI shows clean app version plus short build hash; comparison uses helper build internally. |
| Providers | parity | CRUD, switch, import, sort, live IDs, and universal providers route through remote commands. |
| Provider secrets | remote-adapted | Secrets stay on the remote host. Redacted values are preserved by shared restore logic. |
| MCP | parity | List, upsert, delete, app toggles, and import aggregation are target-aware. |
| Prompts | parity | CRUD, enable, import, and current prompt file content are target-aware. |
| Skills | parity | Install, uninstall, backups, restore, app toggles, unmanaged scan, app import, repos, update check, and update are target-aware. |
| Sessions | remote-adapted | List, delete, batch delete, and the copy/resume-command payloads are target-aware. **Session body reading is not supported on a remote target**: the v4 reader streams through a Tauri Channel from the local filesystem, and there is no helper equivalent yet, so the remote view keeps the list/delete actions only. Terminal resume stays local-only. |
| Hermes memory | parity | Memory, model config, limits, and enabled state are target-aware. |
| OpenClaw | parity | Default model, env, tools, and agents defaults are target-aware. |
| Apps page | parity | The v4 Apps page follows the management target: tool versions, install/update/uninstall, conflict diagnosis, installation listing and the per-host visible-app switches all run against the selected host through the shared `tool_environment` logic. Local-only parts are hidden on a remote target (the Claude Desktop row, the Windows WSL shell override, and the client startup update check that feeds the local sidebar dot). |
| App mode / stack panel | parity | The v4 direct/route/stack panel is target-aware: a remote target reads and writes the selected host's mode state through the helper's `app-mode` commands, which are thin adapters over the same `mode::controller` logic the desktop uses (`get` / `enter` / `exit` / `set-route` / `direct-provider` / `takeover-status` / `exit-apps-in-mode` / `stack` / `set-stack-member` / `adopt-codex-catalog` / `restart-codex-daemon`). Stack member writes return a structured result so the partial-write warning survives the helper boundary. Local-only parts stay local: startup attach-failure notices and tray-driven "needs route" prompts are not sent for a remote target, and an old helper without the `app-mode` capability keeps the provider list but replaces the mode row with an explanation instead of failing controls. |
| Remote routing "apps in use" rows | parity | The routing settings block lists each app's effective mode and route for the selected host (same rows as local) and "exit all" exits that host's modes. |
| Pi (live status) | remote-adapted | Remote shows the provider row and its stored `liveConfigManaged` flag. The helper's `live-ids` covers OpenCode/OpenClaw/Hermes only, so remote Pi live state is not readable. |
| Hermes Web UI | local-only | The embedded Hermes web panel and its ZIP/folder pickers are desktop features; remote Hermes work uses the target-aware memory/config surfaces. |
| Workspace view | local-only | The workspace/aggregate shell reads local runtimes and filesystem paths. |
| Project switcher (profiles) | local-only | Project profiles switch the local live config; the remote equivalent is the host profile list in Remote Servers. |
| Tray, terminal launch, deeplinks | local-only | These act on the desktop OS session; they never run against a remote target. |
| Open folder / copy path / ZIP picker / discovery cache | local-only | Filesystem and picker actions stay on the desktop. Skill discovery results are cached for the local target only so a remote scan can never fill the local cache. |
| Tool environment lifecycle | parity | Version check, install/update/uninstall, conflict diagnosis, and installation listing are remote-adapted through the shared `tool_environment` logic; the Apps page (`appsPage`) now follows the management target, so the same rows work for a remote host via the helper (`tools versions` / `tools run` / `tools probe-installations` / `tools installations`). Local-only pieces stay hidden for a remote target: the Claude Desktop row, the Windows WSL shell override, and the client startup update check (that one keeps informing the local sidebar dot). Helper install/status checks additionally run a remote-only Claude Code native installer PATH postflight. The tool lifecycle has exactly one entry point per target: the Apps page. The remote settings environment tab keeps only the helper health/capability panel plus a link to the Apps page, and states the missing-`tools`-capability case instead of offering controls that would fail. |

## Known Unsupported / Next

| Item | Status | Why |
| --- | --- | --- |
| Remote session body reading | unsupported | v4 reads transcripts through a Tauri Channel over local files; no helper protocol equivalent yet. List, delete and copy/resume payloads remain available. |
| Remote Pi live state | unsupported | helper `live-ids` covers OpenCode / OpenClaw / Hermes only. |
| Remote terminal resume | local-only | Opens a local terminal. |
| Remote local proxy takeover / hot switch | local-only | The takeover runtime is the desktop app's; remote routing uses the host's own runtime through helper commands. |

## Current Next Items

1. Keep local-only proxy takeover and hot-switch hooks out of remote UI paths. Remote app routing must continue to use routing app config and helper runtime commands instead.
2. Keep checking new upstream local settings additions against this matrix during upstream merges.

## Audit Note

Audited while landing the upstream v4.0.4 baseline (fork 4.0.5). The mechanical pass behind this table:

- every capability string the UI gates on (`useTargetCapability`, `capabilities.includes`) is advertised by the helper's `remote_capabilities` list, so no working remote feature is hidden as unsupported;
- the only frontend files that mix `target.type === "remote"` with local `invoke(` calls are the `src/lib/api/*` adapter modules, each branching remote → helper and local → Tauri command (covered by the target-routing tests);
- local-only surfaces are guarded at the entry point: the tray/terminal/deeplink actions, the workspace view, the project switcher, the Hermes web panel, the Apps desktop row, and the WSL shell override. The app mode/stack panel is shared with the remote target, and only its desktop-specific extras (startup attach failures, tray-routed prompts) stay local.

### Real-host run (B10, first pass)

Executed against a throwaway Ubuntu 22.04 x86_64 host over SSH (no pre-existing CC Switch data; nothing left behind afterwards):

- The app's own helper install command ran end to end: release download on the host, capability check, `status` verification. It installed the **published 3.20.2 helper** (the fork's `remote-helper-latest` line is still the 3.20.x build), so this pass covered the upgrade path "v4 app + older helper".
- 24 of 34 read commands and 6 of 16 write commands succeeded on that host (providers, settings, routing config/runtime, MCP, prompts, skills, sessions, usage, auth, import-export, tools versions, openclaw, universal providers).
- The old helper is **downward compatible with everything the v4 app calls except exactly the v4 additions**. Comparing the published build's source (`836797ab`) with this branch: 33 → 34 capabilities (+`provider-editor`, +`app-mode`, +`connectivity-check`; −`common-config`, −`stream-check`, both retired upstream) and 174 → 189 dispatched subcommands (+16 / −1): `app-mode` ×11, `providers add-editor` / `editor-view` / `update-editor`, `tools installations`, `connectivity-check provider`. Those are the only commands an old helper rejects.
- Correction to the first pass: `tools probe-installations` **is** supported by the old helper — the earlier "unsupported" line was a missing payload in the probe script, not a helper gap (re-verified on the host with the right arity). Since `tools installations` is only a v4 rename of the same shared function (`list_tool_installations` = `probe_tool_installations`), `remote_list_tool_installations` now **falls back to `tools probe-installations`** when a helper rejects the new spelling, so old-helper users still get install paths/source/conflicts.
- The three genuinely v4-only families are gated in the UI and degrade rather than error: `provider-editor` falls back to the library row, `connectivity-check` disables the check button, `app-mode` keeps the provider list and only replaces the mode row.
- Isolation held on real hardware: `/root/.cc-switch` was never created (`find` returned zero files), all state stayed in `~/.cc-switch-remote` (`cc-switch.db`, `settings.json` with 0600, `model-pricing.json`), and a remote provider switch wrote the host's `~/.codex/config.toml` as designed.
- Failure preservation held: a broken `settings save` payload returned an error and left `settings.json` byte-identical (md5 unchanged).
- Finding fixed because of this run: an older helper **advertises a capability group but not every v4 subcommand inside it** (`tools installations`), which capability gating cannot catch. The remote layer now maps `unsupported_command` / "Unsupported retired command" to a "remote helper is too old, update it" message (with a note to report the raw text if the helper is already current, because a wrong argument shape produces the same helper error) in both the one-shot SSH path and the long-lived session path.

The v4 helper binary itself was verified locally rather than on that host: `cargo build --bin cc-switch-remote-helper --no-default-features --features proxy-runtime` at this branch reports `version 4.0.5`, the 34-capability list above and 23 command groups, and `app-mode get codex` answers `{"mode":"direct","attached":false,...}`. What remains unverified is that same binary **running on a real Linux host** — the published helper is still 3.20.2, cross-compiling needs a Linux OpenSSL toolchain, and building on the host needs crates.io at the link speeds available there.

### Helper release chain (release-preparation item)

The helper artifacts the app downloads come from the inherited chain (`xiaoY233/cc-switch-remote`, tag `remote-helper-latest`, last built from `836797ab` = the 3.20.x line). `helper-artifacts.yml` publishes to `$GITHUB_REPOSITORY`, so a run in this fork would write to `PowerDi/cc-switch-remote` while the app still downloads from the inherited repo. Publishing a v4 helper therefore requires a deliberate fork decision: either republish the inherited chain or move `HELPER_RELEASE_REPO` / `scripts/install-remote-helper.sh` / the helper-tag lookup in `commands/remote.rs` to this fork's repository.

Still unverified: non-x86_64 / macOS hosts, and the release chain (tag, `latest.json`, signatures, asset names).
