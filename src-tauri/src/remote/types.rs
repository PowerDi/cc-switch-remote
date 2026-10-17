use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: RemoteAuthMethod,
    pub helper_path: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RemoteAuthMethod {
    SshAgent,
    KeyFile { path: String },
    Password,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionSecret {
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionStatus {
    pub profile_id: String,
    pub state: RemoteSessionState,
    pub last_error: Option<String>,
    pub active_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteSessionState {
    Idle,
    Connecting,
    Ready,
    Busy,
    Reconnecting,
    Failed,
    Closed,
}

/// 上一次远程检查失败发生在哪一层。
///
/// 与 `reachable`/`helper_installed` 配合使用：SSH 未连通时不能报告
/// “Helper 未安装”，因为那一步根本没跑到。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteConnectionStage {
    /// SSH 传输层失败：连不上、超时、主机名解析失败、主机密钥变更等
    SshTransport,
    /// SSH 传输通了，但认证未通过（密码 / 密钥 / agent）
    SshAuth,
    /// SSH 通了，远端 Helper 未安装或路径不正确
    HelperMissing,
    /// SSH 通了，Helper 文件在但无法正常运行
    HelperError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHealth {
    pub reachable: bool,
    /// SSH 层（连接 + 认证）是否可用。与 Helper 是否安装无关：SSH 通了但
    /// Helper 没装时这里是 `true`。
    #[serde(default)]
    pub ssh_reachable: bool,
    pub helper_installed: bool,
    pub helper_version: Option<String>,
    pub helper_build: Option<String>,
    pub helper_arch: Option<String>,
    pub helper_latest_version: Option<String>,
    pub helper_latest_build: Option<String>,
    pub helper_latest_asset: Option<String>,
    pub helper_update_available: bool,
    pub helper_update_error: Option<String>,
    pub platform: Option<RemotePlatform>,
    pub capabilities: Vec<RemoteCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_stage: Option<RemoteConnectionStage>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemotePlatform {
    Linux,
    Macos,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteCapability {
    Providers,
    ProviderEditor,
    AppMode,
    UniversalProviders,
    RoutingConfig,
    RoutingRuntime,
    RoutingDaemon,
    Openclaw,
    Mcp,
    Prompts,
    Skills,
    Sessions,
    HermesMemory,
    ImportExport,
    CloudSync,
    Tools,
    StreamCheck,
    ConnectivityCheck,
    Usage,
    UsageManualSessionSync,
    UsageModelPricingSync,
    Auth,
    AuthTargetedRelogin,
    AuthCancelLogin,
    CodexConfigOnly,
    Settings,
    SettingsAppConfigDir,
    Plugin,
    Session,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandRequest {
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandResponse<T> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<RemoteCommandError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandError {
    pub code: String,
    pub message: String,
}
