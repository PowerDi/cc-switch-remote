fn git_output(args: &[&str]) -> Option<String> {
    std::process::Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn watch_git_metadata() {
    // In a linked worktree `.git` is a file, not a directory. Watching the
    // nonexistent `../.git/HEAD` makes Cargo rebuild on every invocation.
    // Resolve the real worktree HEAD and shared refs, including packed refs.
    let mut names = vec![
        "HEAD".to_string(),
        "refs".to_string(),
        "packed-refs".to_string(),
    ];
    if let Some(branch) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        names.push(branch);
    }
    for name in names {
        if let Some(path) = git_output(&["rev-parse", "--git-path", &name]) {
            if std::path::Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
}

/// Compile the Windows-only `SSH_ASKPASS` sidecar before Tauri validates the
/// bundle configuration.
///
/// `tauri.windows.conf.json` lists the askpass binary under
/// `bundle.externalBin`, and `tauri_build` fails the build when the referenced
/// file is missing. Generating it here — instead of committing a prebuilt
/// executable — keeps `cargo check`, `cargo clippy` and `cargo test` working on
/// a fresh checkout while still shipping a real executable inside the bundle.
fn ensure_windows_askpass_sidecar() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        return;
    }

    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
    );
    let source = manifest_dir
        .join("askpass")
        .join("cc-switch-remote-askpass.rs");
    let output_dir = manifest_dir.join("binaries");
    let output = output_dir.join(format!("cc-switch-remote-askpass-{target}.exe"));

    println!("cargo:rerun-if-changed={}", source.display());
    // Announcing the generated file makes a deleted sidecar rebuild instead of
    // leaving `tauri_build` to fail on a stale bundle configuration.
    println!("cargo:rerun-if-changed={}", output.display());

    if !source.exists() {
        panic!(
            "missing SSH askpass source at {}; the Windows bundle cannot embed it",
            source.display()
        );
    }

    let up_to_date = output
        .metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .zip(source.metadata().and_then(|meta| meta.modified()).ok())
        .map(|(output_time, source_time)| output_time >= source_time)
        .unwrap_or(false);
    // MSVC links a PDB next to the binary even when it is stripped; it is pure
    // build noise in the source tree and is never bundled.
    let _ = std::fs::remove_file(output.with_extension("pdb"));
    if up_to_date {
        return;
    }

    if let Err(error) = std::fs::create_dir_all(&output_dir) {
        panic!(
            "failed to create {} for the SSH askpass sidecar: {error}",
            output_dir.display()
        );
    }

    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let status = std::process::Command::new(&rustc)
        .arg("--edition")
        .arg("2021")
        .arg("-O")
        .arg("-C")
        .arg("strip=symbols")
        .arg("-C")
        .arg("debuginfo=0")
        .arg("--target")
        .arg(&target)
        .arg("-o")
        .arg(&output)
        .arg(&source)
        .status()
        .unwrap_or_else(|error| {
            panic!("failed to run {rustc} for the SSH askpass sidecar: {error}")
        });
    if !status.success() {
        panic!("failed to build the SSH askpass sidecar for target {target}");
    }
    let _ = std::fs::remove_file(output.with_extension("pdb"));
}

fn main() {
    let target_triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=CC_SWITCH_REMOTE_TARGET_TRIPLE={target_triple}");

    let helper_build = std::env::var("GITHUB_SHA")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(&["rev-parse", "--short=8", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=CC_SWITCH_REMOTE_HELPER_BUILD={helper_build}");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=build.rs");
    watch_git_metadata();

    ensure_windows_askpass_sidecar();

    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build();
    }

    // Windows: Embed Common Controls v6 manifest for test binaries
    //
    // When running `cargo test`, the generated test executables don't include
    // the standard Tauri application manifest. Without Common Controls v6,
    // `tauri::test` calls fail with STATUS_ENTRYPOINT_NOT_FOUND.
    //
    // This workaround:
    // 1. Embeds the manifest into test binaries via /MANIFEST:EMBED
    // 2. Uses /MANIFEST:NO for the main binary to avoid duplicate resources
    //    (Tauri already handles manifest embedding for the app binary)
    #[cfg(target_os = "windows")]
    {
        let manifest_path = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
        )
        .join("common-controls.manifest");
        let manifest_arg = format!("/MANIFESTINPUT:{}", manifest_path.display());

        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg={}", manifest_arg);
        // Avoid duplicate manifest resources in binary builds.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rerun-if-changed={}", manifest_path.display());
    }
}
