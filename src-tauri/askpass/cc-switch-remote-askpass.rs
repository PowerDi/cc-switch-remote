//! Minimal `SSH_ASKPASS` helper for Windows OpenSSH.
//!
//! Windows OpenSSH has no `/bin/sh`, so the Unix askpass trick (a temporary
//! shell script) cannot be used there. This binary is the equivalent: it is
//! spawned by `ssh.exe` whenever a password is required and simply prints the
//! password that the desktop app passes through the environment.
//!
//! It is intentionally dependency-free and never touches the network, files or
//! configuration. `src-tauri/build.rs` compiles it into
//! `src-tauri/binaries/cc-switch-remote-askpass-<target-triple>.exe`, which
//! `tauri.windows.conf.json` then bundles next to the application.
//!
//! The exit status is always 0 with an empty fallback, so a missing variable
//! turns into "wrong password" instead of an unrelated ssh failure.

// No console window: ssh.exe spawns this process for every password prompt.
#![windows_subsystem = "windows"]

use std::io::Write;

fn main() {
    let password = std::env::var("CC_SWITCH_REMOTE_SSH_PASSWORD").unwrap_or_default();
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(password.as_bytes());
    let _ = stdout.flush();
}
