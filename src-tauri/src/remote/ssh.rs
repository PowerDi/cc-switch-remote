use super::execution::{execute, RemoteOperationError};
use crate::error::AppError;
use crate::remote::types::{
    RemoteAuthMethod, RemoteCommandError, RemoteCommandResponse, RemoteConnectionSecret,
    RemoteConnectionStage, RemoteHostProfile,
};
use crate::remote_capabilities::REMOTE_HELPER_REQUIRED_CAPABILITIES;
use serde::de::DeserializeOwned;
use tokio::time::{Duration, Instant};

const HELPER_RELEASE_REPO: &str = "PowerDi/cc-switch-remote";
const HELPER_RELEASE_TAG: &str = "remote-helper-latest";
const HELPER_RELEASE_REPO_ENV: &str = "CC_SWITCH_REMOTE_HELPER_RELEASE_REPO";
const HELPER_RELEASE_TAG_ENV: &str = "CC_SWITCH_REMOTE_HELPER_RELEASE_TAG";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHelperInstallSource {
    pub release_repo: String,
    pub release_tag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHelperAssetTarget {
    pub asset_os: String,
    pub asset_arch: String,
}

impl Default for RemoteHelperInstallSource {
    fn default() -> Self {
        Self {
            release_repo: HELPER_RELEASE_REPO.to_string(),
            release_tag: HELPER_RELEASE_TAG.to_string(),
        }
    }
}

impl RemoteHelperInstallSource {
    pub fn from_env() -> Self {
        let default = Self::default();
        Self {
            release_repo: env_string(HELPER_RELEASE_REPO_ENV).unwrap_or(default.release_repo),
            release_tag: env_string(HELPER_RELEASE_TAG_ENV).unwrap_or(default.release_tag),
        }
    }
}

fn build_ssh_base_args(profile: &RemoteHostProfile) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        profile.port.to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        "ControlPersist=no".to_string(),
        "-o".to_string(),
        match &profile.auth_method {
            RemoteAuthMethod::Password => "BatchMode=no".to_string(),
            _ => "BatchMode=yes".to_string(),
        },
    ];

    match &profile.auth_method {
        RemoteAuthMethod::KeyFile { path } => {
            args.push("-i".to_string());
            args.push(path.clone());
        }
        RemoteAuthMethod::Password => {
            args.push("-o".to_string());
            args.push("PreferredAuthentications=password,keyboard-interactive".to_string());
            args.push("-o".to_string());
            args.push("PubkeyAuthentication=no".to_string());
        }
        RemoteAuthMethod::SshAgent => {}
    }

    args.push("--".to_string());
    args.push(format!("{}@{}", profile.username, profile.host));
    args
}

/// One-shot and persistent SSH share Windows no-console process flags.
pub(crate) fn ssh_tokio_command() -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut command = tokio::process::Command::new("ssh");
    #[cfg(windows)]
    {
        // tokio 自己提供 creation_flags，不需要 std 的 CommandExt。
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn build_ssh_args(profile: &RemoteHostProfile, helper_args: &[String]) -> Vec<String> {
    let mut args = build_ssh_base_args(profile);

    let mut command = vec![
        shell_quote_helper_path(&profile.helper_path),
        "--json".to_string(),
    ];
    command.extend(helper_args.iter().map(|arg| shell_quote(arg)));
    args.push(command.join(" "));
    args
}

pub fn build_ssh_serve_args(profile: &RemoteHostProfile) -> Vec<String> {
    let mut args = build_ssh_base_args(profile);
    args.push(format!(
        "{} --json serve",
        shell_quote_helper_path(&profile.helper_path)
    ));
    args
}

pub fn build_helper_install_args(profile: &RemoteHostProfile) -> Vec<String> {
    build_helper_install_args_with_source(profile, &RemoteHelperInstallSource::from_env())
}

pub fn build_helper_install_args_with_source(
    profile: &RemoteHostProfile,
    source: &RemoteHelperInstallSource,
) -> Vec<String> {
    build_install_args(profile, source, false)
}

fn build_install_args(
    profile: &RemoteHostProfile,
    source: &RemoteHelperInstallSource,
    upload: bool,
) -> Vec<String> {
    let mut args = build_ssh_base_args(profile);
    args.push(format!("env CC_SWITCH_HELPER_PATH={} CC_SWITCH_REMOTE_HELPER_RELEASE_REPO={} CC_SWITCH_INSTALL_MODE={} CC_SWITCH_REQUIRED_CAPABILITIES={} sh -c {} -- {}",
        shell_quote(&profile.helper_path), shell_quote(&source.release_repo),
        if upload { "upload" } else { "download" },
        shell_quote(&REMOTE_HELPER_REQUIRED_CAPABILITIES.join(" ")),
        shell_quote(include_str!("../../../scripts/install-remote-helper.sh")), shell_quote(&source.release_tag)));
    args
}

pub async fn detect_helper_asset_target(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
) -> Result<RemoteHelperAssetTarget, RemoteOperationError> {
    let mut args = build_ssh_base_args(profile);
    args.push("uname -s; uname -m".to_string());
    let stdout = run_ssh(
        profile,
        args,
        secret,
        &[],
        Instant::now() + Duration::from_secs(30),
    )
    .await?;
    let mut parts = stdout.split_whitespace();
    let os = parts.next().unwrap_or_default();
    let arch = parts.next().unwrap_or_default();
    helper_asset_target_from_uname(os, arch)
        .ok_or_else(|| RemoteOperationError::new("unsupported-platform", format!("{os}/{arch}")))
}

pub async fn upload_helper_bytes_and_verify_json<T: DeserializeOwned>(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
    helper_bytes: &[u8],
) -> Result<T, RemoteOperationError> {
    let args = build_install_args(profile, &RemoteHelperInstallSource::from_env(), true);
    let stdout = run_ssh(
        profile,
        args,
        secret,
        helper_bytes,
        Instant::now() + Duration::from_secs(300),
    )
    .await
    .map_err(classify_install_uncertainty)?;
    parse_install_ack(&stdout)
}

fn classify_install_uncertainty(mut error: RemoteOperationError) -> RemoteOperationError {
    // Unknown exits (including failed ack/cleanup after rename) cannot promise
    // preservation. Only reserved PRE-COMMIT failures have that guarantee.
    if matches!(
        error.code.as_str(),
        "helper-execution" | "helper-protocol" | "ssh-io"
    ) {
        error.remote_state_uncertain = true;
    }
    error
}

fn parse_metadata(stdout: &str) -> Result<serde_json::Value, RemoteOperationError> {
    let envelope: RemoteCommandResponse<crate::cli::commands::StatusPayload> =
        serde_json::from_str(stdout)
            .map_err(|e| RemoteOperationError::new("helper-protocol", e))?;
    let status = envelope.data.filter(|_| envelope.ok).ok_or_else(|| {
        RemoteOperationError::new("helper-protocol", "Missing successful metadata")
    })?;
    serde_json::to_value(status).map_err(|e| RemoteOperationError::new("helper-protocol", e))
}

fn parse_install_ack<T: DeserializeOwned>(stdout: &str) -> Result<T, RemoteOperationError> {
    parse_metadata(stdout)
        .and_then(|value| {
            serde_json::from_value(value)
                .map_err(|e| RemoteOperationError::new("helper-protocol", e))
        })
        .map_err(|mut error| {
            error.remote_state_uncertain = true;
            error.local_process_reaped = true;
            error
        })
}

fn helper_asset_target_from_uname(os: &str, arch: &str) -> Option<RemoteHelperAssetTarget> {
    let asset_os = match os {
        "Linux" => "Linux",
        "Darwin" => "macOS",
        _ => return None,
    };
    let asset_arch = if asset_os == "macOS" {
        "universal"
    } else {
        match arch {
            "x86_64" | "amd64" => "x86_64",
            "aarch64" | "arm64" => "arm64",
            _ => return None,
        }
    };

    Some(RemoteHelperAssetTarget {
        asset_os: asset_os.to_string(),
        asset_arch: asset_arch.to_string(),
    })
}

pub fn run_helper_json<T: DeserializeOwned>(
    profile: &RemoteHostProfile,
    helper_args: &[String],
    secret: Option<&RemoteConnectionSecret>,
) -> Result<T, AppError> {
    let stdout = run_ssh_command(profile, build_ssh_args(profile, helper_args), secret)?;
    parse_helper_json(&stdout)
}

pub async fn install_helper_json<T: DeserializeOwned>(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
) -> Result<T, RemoteOperationError> {
    let stdout = run_ssh(
        profile,
        build_helper_install_args(profile),
        secret,
        &[],
        Instant::now() + Duration::from_secs(300),
    )
    .await
    .map_err(classify_install_uncertainty)?;
    parse_install_ack(&stdout)
}

// Compatibility for existing blocking one-shot business callers. All execution
// still uses the same bounded, concurrently drained, kill-and-reap implementation.
fn run_ssh_command(
    profile: &RemoteHostProfile,
    args: Vec<String>,
    secret: Option<&RemoteConnectionSecret>,
) -> Result<String, AppError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| AppError::Message(e.to_string()))?
        .block_on(run_ssh(
            profile,
            args,
            secret,
            &[],
            Instant::now() + Duration::from_secs(900),
        ))
        .map_err(|e| {
            let message = if e.code.starts_with("ssh-")
                || is_helper_missing_error(profile, &e.message)
                || e.message.contains("libgdk-3.so.0")
                || e.message.contains("libgtk-3.so.0")
                || e.message.contains("libwebkit2gtk")
                || e.message.contains("libayatana-appindicator")
            {
                normalize_remote_stderr(profile, &e.message)
            } else {
                e.to_string()
            };
            AppError::Message(message)
        })
}

async fn run_ssh(
    profile: &RemoteHostProfile,
    args: Vec<String>,
    secret: Option<&RemoteConnectionSecret>,
    input: &[u8],
    deadline: Instant,
) -> Result<String, RemoteOperationError> {
    let mut command = ssh_tokio_command();
    command.args(args);
    let _askpass = configure_password_auth_for_tokio(profile, secret, &mut command)
        .map_err(|e| RemoteOperationError::new("ssh-auth-setup", e))?;
    let output = execute(command, input, deadline).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = classify_process_failure(output.status.code(), &stderr);
        let mut error = RemoteOperationError::new(code, stderr.trim());
        error.local_process_reaped = true;
        error.remote_state_uncertain =
            output.status.code() == Some(255) && !matches!(code, "ssh-auth" | "ssh-host-key");
        return Err(error);
    }
    String::from_utf8(output.stdout).map_err(|e| {
        let mut error = RemoteOperationError::new("helper-protocol", e);
        error.local_process_reaped = true;
        error
    })
}

fn classify_process_failure(exit: Option<i32>, stderr: &str) -> &str {
    if exit == Some(255) {
        return if is_changed_host_key_error(stderr) {
            "ssh-host-key"
        } else if is_ssh_auth_error(stderr) {
            "ssh-auth"
        } else {
            "ssh-transport"
        };
    }
    // The final marker and matching reserved exit code belong to the installer,
    // not arbitrary stderr from curl or a failing candidate helper.
    let marker = stderr
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("CC_SWITCH_INSTALL_ERROR:"));
    match (exit, marker) {
        (Some(69), Some("download-failed")) => "download-failed",
        (Some(66), Some("unsupported-platform")) => "unsupported-platform",
        (Some(75), Some("install-locked")) => "install-locked",
        (Some(74), Some("upload-failed")) => "upload-failed",
        (
            Some(65),
            Some(
                code @ ("helper-validation"
                | "helper-protocol"
                | "helper-capabilities"
                | "helper-not-executable"),
            ),
        ) => code,
        (Some(73), Some(code @ ("install-permission" | "install-path" | "install-commit"))) => code,
        _ => "helper-execution",
    }
}

pub(crate) fn normalize_remote_stderr(profile: &RemoteHostProfile, stderr: &str) -> String {
    if stderr.contains("libgdk-3.so.0")
        || stderr.contains("libgtk-3.so.0")
        || stderr.contains("libwebkit2gtk")
        || stderr.contains("libayatana-appindicator")
    {
        format!(
            "{HELPER_NOT_RUNNABLE_PREFIX}，依赖服务器上不存在的桌面 GTK/WebKit 库。请重新安装最新的远程 Helper。"
        )
    } else if is_changed_host_key_error(stderr) {
        let host = extract_changed_host_key_host(stderr).unwrap_or(profile.host.as_str());
        let location = extract_offending_known_hosts_entry(stderr)
            .map(|entry| format!("冲突记录：{entry}。"))
            .unwrap_or_default();
        format!(
            "{SSH_HOST_KEY_CHANGED_PREFIX}，SSH 已拒绝连接以防止中间人攻击。若你确认这台服务器刚重装、重置或更换过系统，请在本机终端执行：ssh-keygen -R {host}，然后重新连接并确认新的主机指纹。{location}"
        )
    } else if is_ssh_auth_error(stderr) {
        format!(
            "{SSH_AUTH_FAILURE_PREFIX}：当前密钥或密码无法登录 {}@{}:{}。请检查远程账号、密钥文件、密码或服务器 authorized_keys。",
            profile.username, profile.host, profile.port
        )
    } else if is_ssh_connection_refused(stderr) {
        let endpoint = extract_ssh_connect_endpoint(stderr)
            .unwrap_or_else(|| format!("{}:{}", profile.host, profile.port));
        format!(
            "{SSH_CONNECTION_REFUSED_PREFIX}：{endpoint} 没有 SSH 服务监听，或连接被防火墙拒绝。请检查服务器 IP、端口和 sshd 状态。"
        )
    } else if is_ssh_timeout(stderr) {
        let endpoint = extract_ssh_connect_endpoint(stderr)
            .unwrap_or_else(|| format!("{}:{}", profile.host, profile.port));
        format!(
            "{SSH_TIMEOUT_PREFIX}：无法连接到 {endpoint}。请检查网络、VPN、服务器状态、防火墙和 SSH 端口。"
        )
    } else if let Some(host) = extract_unresolved_ssh_host(stderr) {
        format!(
            "{SSH_HOSTNAME_UNRESOLVED_PREFIX}：{host}。请检查远程服务器地址是否填写正确，或检查本机 DNS/网络。"
        )
    } else if is_ssh_control_socket_error(stderr) {
        format!(
            "{SSH_CONTROL_SOCKET_PREFIX}，连接尚未到达远程 Helper。当前版本已默认禁用 SSH ControlMaster；请升级客户端后重试。若仍然出现，请检查本机 ~/.ssh/config 中该主机的 ControlMaster/ControlPath 配置。"
        )
    } else if is_helper_missing_error(profile, stderr) {
        format!(
            "{HELPER_MISSING_PREFIX}或路径不正确。请点击“安装 Helper”，或在远程服务器配置中修正 Helper 路径（当前：{}）。",
            profile.helper_path
        )
    } else {
        stderr.to_string()
    }
}

fn is_changed_host_key_error(stderr: &str) -> bool {
    stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || (stderr.contains("Host key for ")
            && stderr.contains(" has changed")
            && stderr.contains("Host key verification failed"))
}

fn extract_changed_host_key_host(stderr: &str) -> Option<&str> {
    for line in stderr.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Host key for ") {
            if let Some((host, _)) = rest.split_once(" has changed") {
                return Some(host.trim());
            }
        }
    }
    None
}

fn extract_offending_known_hosts_entry(stderr: &str) -> Option<String> {
    for line in stderr.lines() {
        let line = line.trim();
        if let Some((_, location)) = line.split_once(" in ") {
            if line.starts_with("Offending ") && line.contains(" key in ") {
                return Some(location.trim_end_matches('.').to_string());
            }
        }
    }
    None
}

fn is_ssh_auth_error(stderr: &str) -> bool {
    stderr.contains("Permission denied")
        || stderr.contains("Authentication failed")
        || stderr.contains("Too many authentication failures")
}

fn is_ssh_connection_refused(stderr: &str) -> bool {
    stderr.contains("Connection refused")
}

fn is_ssh_timeout(stderr: &str) -> bool {
    stderr.contains("Operation timed out")
        || stderr.contains("Connection timed out")
        || stderr.contains("Connection timeout")
}

fn extract_ssh_connect_endpoint(stderr: &str) -> Option<String> {
    for line in stderr.lines() {
        let Some(rest) = line.split("connect to host ").nth(1) else {
            continue;
        };
        let Some((host, rest)) = rest.split_once(" port ") else {
            continue;
        };
        let port = rest
            .split(|ch: char| ch == ':' || ch.is_whitespace())
            .next()
            .unwrap_or("")
            .trim();
        if !host.trim().is_empty() && !port.is_empty() {
            return Some(format!("{}:{}", host.trim(), port));
        }
    }
    None
}

fn extract_unresolved_ssh_host(stderr: &str) -> Option<&str> {
    for line in stderr.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("ssh: Could not resolve hostname ") else {
            continue;
        };
        let host = rest
            .split(|ch: char| ch == ':' || ch.is_whitespace())
            .next()
            .unwrap_or("")
            .trim();
        if !host.is_empty() {
            return Some(host);
        }
    }
    None
}

fn is_ssh_control_socket_error(stderr: &str) -> bool {
    stderr.contains("getsockname failed: Not a socket")
        || stderr.contains("Control socket connect")
        || stderr.contains("mux_client_hello_exchange")
}

fn is_helper_missing_error(profile: &RemoteHostProfile, stderr: &str) -> bool {
    let mentions_helper = stderr.contains("cc-switch-remote-helper")
        || stderr.contains("cc-switch-cli")
        || stderr.contains(profile.helper_path.as_str());
    let stderr_lower = stderr.to_lowercase();
    mentions_helper
        && (stderr_lower.contains("no such file or directory")
            || stderr_lower.contains("not found")
            || stderr.contains("没有那个文件或目录"))
}

fn parse_helper_json<T: DeserializeOwned>(stdout: &str) -> Result<T, AppError> {
    let json_line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(stdout)
        .trim();
    let envelope: RemoteCommandResponse<T> = serde_json::from_str(json_line)
        .map_err(|e| AppError::Message(format!("Remote helper returned invalid JSON: {e}")))?;

    if envelope.ok {
        if let Some(data) = envelope.data {
            Ok(data)
        } else {
            serde_json::from_value(serde_json::Value::Null).map_err(|_| {
                AppError::Message("Remote helper returned ok without data".to_string())
            })
        }
    } else {
        let RemoteCommandError { code, message } = envelope.error.unwrap_or(RemoteCommandError {
            code: "remote_error".to_string(),
            message: "Remote helper command failed".to_string(),
        });
        // 老 helper（3.20.x）会广告一个能力组、但没有 v4 新增的子命令（例如 tools
        // probe-installations / app-mode）。能力门控挡不住这种情况，这里把 helper 的
        // "unknown command" 换成能照做的说法，别把「Supported commands: …」原样丢给用户。
        if is_stale_helper_command_error(&code, &message) {
            return Err(AppError::Message(format!(
                "远程 Helper 版本过旧，不支持该操作。请在远端更新 Helper 后重试；若 Helper 已是最新，请连同下面原文一并反馈 (helper does not support this command; update the remote helper, or report the raw message below if it is already current): {message}"
            )));
        }
        Err(AppError::Message(format!("{code}: {message}")))
    }
}

/// helper 回的是「不认识这条命令」而不是业务失败。
pub(crate) fn is_stale_helper_command_error(code: &str, message: &str) -> bool {
    code == "unsupported_command"
        || message.contains("Unsupported retired command")
        || message.contains("Supported commands:")
}

#[cfg(test)]
mod stale_helper_tests {
    use super::*;

    #[test]
    fn unknown_helper_command_is_reported_as_a_stale_helper() {
        let stdout = r#"{"ok":false,"data":null,"error":{"code":"unsupported_command","message":"Supported commands: status, providers"}}"#;
        let error = parse_helper_json::<serde_json::Value>(stdout).unwrap_err();
        let text = error.to_string();
        assert!(text.contains("远程 Helper 版本过旧"), "{text}");
        assert!(text.contains("update the remote helper"), "{text}");
    }

    #[test]
    fn retired_command_is_reported_as_a_stale_helper() {
        let stdout = r#"{"ok":false,"data":null,"error":{"code":"tools_installations_failed","message":"该接口已被 v4.0.4 移除，未修改任何配置 (Unsupported retired command: tools installations; no configuration was changed)"}}"#;
        let error = parse_helper_json::<serde_json::Value>(stdout).unwrap_err();
        assert!(error.to_string().contains("远程 Helper 版本过旧"));
    }

    #[test]
    fn business_failures_keep_their_own_message() {
        let stdout = r#"{"ok":false,"data":null,"error":{"code":"providers_delete_failed","message":"无法删除当前正在使用的供应商"}}"#;
        let error = parse_helper_json::<serde_json::Value>(stdout).unwrap_err();
        let text = error.to_string();
        assert!(text.contains("providers_delete_failed"), "{text}");
        assert!(!text.contains("版本过旧"), "{text}");
    }
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(unix)]
fn create_askpass_script() -> Result<tempfile::TempPath, AppError> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let mut askpass = tempfile::Builder::new()
        .prefix("cc-switch-ssh-askpass-")
        .tempfile()
        .map_err(|e| AppError::Message(format!("Failed to create ssh askpass helper: {e}")))?;
    askpass
        .write_all(b"#!/bin/sh\nprintf '%s' \"$CC_SWITCH_REMOTE_SSH_PASSWORD\"\n")
        .map_err(|e| AppError::Message(format!("Failed to write ssh askpass helper: {e}")))?;
    let mut perms = askpass
        .as_file()
        .metadata()
        .map_err(|e| AppError::Message(format!("Failed to inspect ssh askpass helper: {e}")))?
        .permissions();
    perms.set_mode(0o700);
    askpass
        .as_file()
        .set_permissions(perms)
        .map_err(|e| AppError::Message(format!("Failed to secure ssh askpass helper: {e}")))?;
    Ok(askpass.into_temp_path())
}

/// `remote_failure_message` 与 `classify_remote_failure_message` 共用的消息前缀：
/// 展示文案和分层判定必须保持同步，改一处不会漏改另一处。
const SSH_AUTH_FAILURE_PREFIX: &str = "SSH 认证失败";
const SSH_HOST_KEY_CHANGED_PREFIX: &str = "远程主机密钥已变更";
const SSH_CONNECTION_REFUSED_PREFIX: &str = "SSH 连接被拒绝";
const SSH_TIMEOUT_PREFIX: &str = "SSH 连接超时";
const SSH_HOSTNAME_UNRESOLVED_PREFIX: &str = "SSH 主机名无法解析";
const SSH_CONTROL_SOCKET_PREFIX: &str = "SSH 连接复用控制 socket 异常";
const HELPER_MISSING_PREFIX: &str = "远程 Helper 未安装";
const HELPER_NOT_RUNNABLE_PREFIX: &str = "远程 Helper 不是纯 CLI 构建";

const SSH_TRANSPORT_FAILURE_PREFIXES: [&str; 5] = [
    SSH_HOST_KEY_CHANGED_PREFIX,
    SSH_CONNECTION_REFUSED_PREFIX,
    SSH_TIMEOUT_PREFIX,
    SSH_HOSTNAME_UNRESOLVED_PREFIX,
    SSH_CONTROL_SOCKET_PREFIX,
];

/// 从 `normalize_remote_stderr` 产出的消息反推失败分层。
///
/// 未识别的错误返回 `None`，调用方应再用一次 SSH 探针确认真实分层，
/// 而不是猜测。
pub fn classify_remote_failure_message(message: &str) -> Option<RemoteConnectionStage> {
    if message.contains(SSH_AUTH_FAILURE_PREFIX) {
        return Some(RemoteConnectionStage::SshAuth);
    }
    if SSH_TRANSPORT_FAILURE_PREFIXES
        .iter()
        .any(|prefix| message.contains(prefix))
    {
        return Some(RemoteConnectionStage::SshTransport);
    }
    if message.contains(HELPER_MISSING_PREFIX) {
        return Some(RemoteConnectionStage::HelperMissing);
    }
    if message.contains(HELPER_NOT_RUNNABLE_PREFIX) {
        return Some(RemoteConnectionStage::HelperError);
    }
    None
}

fn build_probe_args(profile: &RemoteHostProfile, mode: &str) -> Vec<String> {
    let mut args = build_ssh_base_args(profile);
    args.push(format!(
        "sh -c {} -- {} {}",
        shell_quote(include_str!("../../../scripts/probe-remote-helper.sh")),
        shell_quote(mode),
        shell_quote(&profile.helper_path)
    ));
    args
}

/// Probe SSH/authentication before invoking the helper. Presence is not executability.
pub async fn probe_remote_helper_presence(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
    deadline: Instant,
) -> Result<&'static str, RemoteOperationError> {
    let args = build_probe_args(profile, "presence");
    let stdout = run_ssh(profile, args, secret, &[], deadline).await?;
    match stdout.trim() {
        "missing" => Ok("missing"),
        "not-executable" => Ok("not-executable"),
        "executable" => Ok("executable"),
        _ => Err(RemoteOperationError::new(
            "probe-protocol",
            "Unexpected SSH probe response",
        )),
    }
}

/// Metadata probes must also isolate OLD helpers whose status initializes a DB.
pub async fn probe_helper_status(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
    deadline: Instant,
) -> Result<serde_json::Value, RemoteOperationError> {
    let args = build_probe_args(profile, "status");
    let stdout = run_ssh(profile, args, secret, &[], deadline).await?;
    parse_metadata(&stdout)
}

#[cfg(any(unix, windows))]
fn password_for_profile(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
) -> Result<Option<String>, AppError> {
    if !matches!(profile.auth_method, RemoteAuthMethod::Password) {
        return Ok(None);
    }

    let stored_secret = if secret
        .and_then(|secret| secret.password.as_deref())
        .filter(|password| !password.is_empty())
        .is_none()
    {
        crate::remote::store::load_profile_secret(&profile.id).ok()
    } else {
        None
    };
    let password = secret
        .and_then(|secret| secret.password.as_deref())
        .or_else(|| {
            stored_secret
                .as_ref()
                .and_then(|secret| secret.password.as_deref())
        })
        .filter(|password| !password.is_empty())
        .ok_or_else(|| AppError::Message("Remote SSH password is required".to_string()))?;

    Ok(Some(password.to_string()))
}

#[cfg(unix)]
pub fn configure_password_auth_for_tokio(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
    command: &mut tokio::process::Command,
) -> Result<Option<tempfile::TempPath>, AppError> {
    let Some(password) = password_for_profile(profile, secret)? else {
        return Ok(None);
    };
    let askpass_path = create_askpass_script()?;
    command.env("SSH_ASKPASS", &askpass_path);
    command.env("SSH_ASKPASS_REQUIRE", "force");
    command.env("DISPLAY", "cc-switch");
    command.env("CC_SWITCH_REMOTE_SSH_PASSWORD", password);
    Ok(Some(askpass_path))
}

#[cfg(not(any(unix, windows)))]
pub fn configure_password_auth_for_tokio(
    profile: &RemoteHostProfile,
    _secret: Option<&RemoteConnectionSecret>,
    _command: &mut tokio::process::Command,
) -> Result<Option<()>, AppError> {
    if matches!(profile.auth_method, RemoteAuthMethod::Password) {
        return Err(AppError::localized(
            "remote.ssh.password_unsupported_platform",
            "当前平台不支持 SSH 密码认证，请改用密钥文件或 SSH Agent。",
            "SSH password authentication is not supported on this platform; use a key file or SSH Agent instead.",
        ));
    }
    Ok(None)
}

/// Windows: locate the bundled askpass sidecar.
///
/// Windows has no `/bin/sh`, so the Unix temporary-script trick cannot work.
/// The sidecar is a real executable embedded through
/// `tauri.windows.conf.json` (`bundle.externalBin`); Tauri strips the target
/// triple when it copies the binary next to the application, so both names are
/// probed to also cover `tauri dev` layouts.
#[cfg(windows)]
fn resolve_askpass_helper_path() -> Result<std::path::PathBuf, AppError> {
    let current_exe = std::env::current_exe().map_err(|error| {
        AppError::Message(format!(
            "Failed to locate the application executable for SSH askpass: {error}"
        ))
    })?;
    let directory = current_exe.parent().ok_or_else(|| {
        AppError::Message("Application directory is unavailable for SSH askpass".to_string())
    })?;

    let triple = env!("CC_SWITCH_REMOTE_TARGET_TRIPLE");
    let candidates = [
        directory.join("cc-switch-remote-askpass.exe"),
        directory.join(format!("cc-switch-remote-askpass-{triple}.exe")),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    // `tauri dev` does not always copy external binaries next to the debug
    // executable; fall back to the path `build.rs` generated, which only exists
    // for a local checkout and is therefore debug-only.
    #[cfg(debug_assertions)]
    {
        let dev_candidate = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("cc-switch-remote-askpass-{triple}.exe"));
        if dev_candidate.is_file() {
            return Ok(dev_candidate);
        }
    }

    Err(AppError::localized(
        "remote.ssh.askpass_missing",
        "缺少 SSH askpass 组件（cc-switch-remote-askpass.exe），无法使用密码认证。请重新安装 CC Switch Remote。",
        "The SSH askpass helper (cc-switch-remote-askpass.exe) is missing, so password authentication is unavailable. Reinstall CC Switch Remote.",
    ))
}

#[cfg(windows)]
pub fn configure_password_auth_for_tokio(
    profile: &RemoteHostProfile,
    secret: Option<&RemoteConnectionSecret>,
    command: &mut tokio::process::Command,
) -> Result<Option<std::path::PathBuf>, AppError> {
    let Some(password) = password_for_profile(profile, secret)? else {
        return Ok(None);
    };
    let askpass_path = resolve_askpass_helper_path()?;
    command.env("SSH_ASKPASS", &askpass_path);
    command.env("SSH_ASKPASS_REQUIRE", "force");
    command.env("CC_SWITCH_REMOTE_SSH_PASSWORD", password);
    Ok(Some(askpass_path))
}

fn shell_quote_helper_path(value: &str) -> String {
    if let Some(relative) = value.strip_prefix("~/") {
        return format!("~/{}", shell_quote(relative));
    }
    if is_safe_unquoted_helper_path(value) {
        return value.to_string();
    }
    shell_quote(value)
}

fn is_safe_unquoted_helper_path(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:~".contains(c))
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:".contains(c))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_profile() -> RemoteHostProfile {
        RemoteHostProfile {
            id: "prod".to_string(),
            name: "Production".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "ccswitch".to_string(),
            auth_method: RemoteAuthMethod::SshAgent,
            helper_path: "/usr/local/bin/cc-switch-helper".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn post_commit_errors_and_invalid_acks_are_uncertain_and_never_claim_preservation() {
        let error = classify_install_uncertainty(RemoteOperationError::new(
            "helper-execution",
            "ack write failed",
        ));
        assert!(error.remote_state_uncertain);
        let invalid = r#"{"ok":true,"ok":true,"data":{"version":"test","platform":"linux","arch":"x86_64","capabilities":["session"]}}"#;
        let error = parse_install_ack::<serde_json::Value>(invalid).unwrap_err();
        assert!(error.remote_state_uncertain);
        assert!(error.local_process_reaped);
        assert!(
            parse_install_ack::<serde_json::Value>("")
                .unwrap_err()
                .remote_state_uncertain
        );
        assert!(
            !classify_install_uncertainty(RemoteOperationError::new(
                "helper-validation",
                "precommit"
            ))
            .remote_state_uncertain
        );
    }

    #[test]
    fn structured_failures_do_not_confuse_helper_permissions_or_spoofed_markers_with_ssh() {
        assert_eq!(
            classify_process_failure(Some(65), "Permission denied"),
            "helper-execution"
        );
        assert_eq!(
            classify_process_failure(Some(255), "Permission denied (publickey)."),
            "ssh-auth"
        );
        assert_eq!(classify_process_failure(Some(65), "CC_SWITCH_INSTALL_ERROR:download-failed\nCC_SWITCH_INSTALL_ERROR:helper-validation"), "helper-validation");
        assert_eq!(
            classify_process_failure(Some(65), "CC_SWITCH_INSTALL_ERROR:download-failed"),
            "helper-execution"
        );
        assert_eq!(
            classify_process_failure(Some(69), "CC_SWITCH_INSTALL_ERROR:download-failed"),
            "download-failed"
        );
    }

    #[test]
    fn disables_ssh_control_master_by_default() {
        let args = build_ssh_args(&valid_profile(), &["status".to_string()]);

        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ControlMaster=no"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ControlPersist=no"]));
        assert!(!args
            .windows(2)
            .any(|pair| pair == ["-o", "ControlMaster=auto"]));
        assert!(!args.iter().any(|arg| arg == "-S"));
    }

    #[test]
    fn normalizes_ssh_control_socket_error() {
        let message = normalize_remote_stderr(
            &valid_profile(),
            "getsockname failed: Not a socket\r\nRead from remote host 10.81.2.202: Unknown error",
        );

        assert!(message.contains("SSH 连接复用控制 socket 异常"));
        assert!(message.contains("ControlMaster"));
    }

    #[test]
    fn normalizes_changed_host_key_error() {
        let message = normalize_remote_stderr(
            &valid_profile(),
            r#"@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
Offending ED25519 key in ~/.ssh/known_hosts:33
Host key for 192.168.123.111 has changed and you have requested strict checking.
Host key verification failed."#,
        );

        assert!(message.contains("远程主机密钥已变更"));
        assert!(message.contains("ssh-keygen -R 192.168.123.111"));
        assert!(message.contains("~/.ssh/known_hosts:33"));
        assert!(!message.contains("SOMETHING NASTY"));
    }

    #[test]
    fn normalizes_common_ssh_transport_errors() {
        let denied = normalize_remote_stderr(&valid_profile(), "Permission denied (publickey).");
        assert!(denied.contains("SSH 认证失败"));

        let refused = normalize_remote_stderr(
            &valid_profile(),
            "ssh: connect to host 192.168.123.111 port 22: Connection refused",
        );
        assert!(refused.contains("SSH 连接被拒绝"));

        let timeout = normalize_remote_stderr(
            &valid_profile(),
            "ssh: connect to host 192.168.123.111 port 22: Operation timed out",
        );
        assert!(timeout.contains("SSH 连接超时"));
    }
}
