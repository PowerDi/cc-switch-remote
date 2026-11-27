use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, RwLock};
use std::time::{Duration, Instant};

use crate::app_config::AppType;
use crate::error::AppError;
use crate::services::skill::{SkillStorageLocation, SyncMethod};

/// 自定义端点配置（历史兼容，实际存储在 provider.meta.custom_endpoints）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEndpoint {
    pub url: String,
    pub added_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<i64>,
}

fn default_true() -> bool {
    true
}

/// 主页面显示的应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleApps {
    #[serde(default = "default_true")]
    pub claude: bool,
    #[serde(
        rename = "claude-desktop",
        alias = "claudeDesktop",
        alias = "claude_desktop",
        default = "default_true"
    )]
    pub claude_desktop: bool,
    #[serde(default = "default_true")]
    pub codex: bool,
    #[serde(default = "default_true")]
    pub gemini: bool,
    #[serde(default = "default_true")]
    pub grokbuild: bool,
    #[serde(default = "default_true")]
    pub opencode: bool,
    #[serde(default = "default_true")]
    pub openclaw: bool,
    #[serde(default)]
    pub hermes: bool,
    #[serde(default = "default_true")]
    pub pi: bool,
    #[serde(default)]
    pub omp: bool,
    #[serde(default = "default_true")]
    pub mcode: bool,
    #[serde(default = "default_true")]
    pub kimi: bool,
    #[serde(default = "default_true")]
    pub agy: bool,
}

impl Default for VisibleApps {
    fn default() -> Self {
        Self {
            claude: true,
            claude_desktop: true,
            codex: true,
            gemini: true,
            grokbuild: true,
            opencode: true,
            openclaw: true,
            hermes: false, // 默认不显示，需用户手动启用
            pi: true,
            mcode: true,
            kimi: true,
            agy: true,
            omp: true,
        }
    }
}

impl VisibleApps {
    /// Check if the specified app is visible
    pub fn is_visible(&self, app: &AppType) -> bool {
        match app {
            AppType::Claude => self.claude,
            AppType::ClaudeDesktop => self.claude_desktop,
            AppType::Codex => self.codex,
            AppType::Gemini => self.gemini,
            AppType::GrokBuild => self.grokbuild,
            AppType::OpenCode => self.opencode,
            AppType::OpenClaw => self.openclaw,
            AppType::Hermes => self.hermes,
            AppType::Pi => self.pi,
            AppType::Mcode => self.mcode,
            AppType::Kimi => self.kimi,
            AppType::Agy => self.agy,
            AppType::Omp => self.omp,
        }
    }
}

/// WebDAV 同步状态（持久化同步进度信息）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_remote_etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_local_manifest_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_remote_manifest_hash: Option<String>,
}

fn default_remote_root() -> String {
    "cc-switch-sync".to_string()
}
fn default_profile() -> String {
    "default".to_string()
}

/// WebDAV 同步设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default = "default_remote_root")]
    pub remote_root: String,
    #[serde(default = "default_profile")]
    pub profile: String,
    #[serde(default)]
    pub status: WebDavSyncStatus,
}

impl Default for WebDavSyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_sync: false,
            base_url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_root: default_remote_root(),
            profile: default_profile(),
            status: WebDavSyncStatus::default(),
        }
    }
}

impl WebDavSyncSettings {
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.base_url.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "webdav.base_url.required",
                "WebDAV 地址不能为空",
                "WebDAV URL is required.",
            ));
        }
        if self.username.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "webdav.username.required",
                "WebDAV 用户名不能为空",
                "WebDAV username is required.",
            ));
        }
        Ok(())
    }

    pub fn normalize(&mut self) {
        self.base_url = self.base_url.trim().to_string();
        self.username = self.username.trim().to_string();
        self.remote_root = self.remote_root.trim().to_string();
        self.profile = self.profile.trim().to_string();
        if self.remote_root.is_empty() {
            self.remote_root = default_remote_root();
        }
        if self.profile.is_empty() {
            self.profile = default_profile();
        }
    }

    /// Returns true if all credential fields are blank (no config to persist).
    fn is_empty(&self) -> bool {
        self.base_url.is_empty() && self.username.is_empty() && self.password.is_empty()
    }
}

/// S3 同步设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub access_key_id: String,
    #[serde(default)]
    pub secret_access_key: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_remote_root")]
    pub remote_root: String,
    #[serde(default = "default_profile")]
    pub profile: String,
    #[serde(default)]
    pub status: WebDavSyncStatus,
}

impl Default for S3SyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_sync: false,
            region: String::new(),
            bucket: String::new(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            endpoint: String::new(),
            remote_root: default_remote_root(),
            profile: default_profile(),
            status: WebDavSyncStatus::default(),
        }
    }
}

impl S3SyncSettings {
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.bucket.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.bucket.required",
                "S3 存储桶不能为空",
                "S3 bucket is required.",
            ));
        }
        if self.region.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.region.required",
                "S3 区域不能为空",
                "S3 region is required.",
            ));
        }
        if self.access_key_id.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.access_key_id.required",
                "S3 Access Key ID 不能为空",
                "S3 Access Key ID is required.",
            ));
        }
        if self.secret_access_key.trim().is_empty() {
            return Err(crate::error::AppError::localized(
                "s3.secret_access_key.required",
                "S3 Secret Access Key 不能为空",
                "S3 Secret Access Key is required.",
            ));
        }
        Ok(())
    }

    pub fn normalize(&mut self) {
        self.region = self.region.trim().to_string();
        self.bucket = self.bucket.trim().to_string();
        self.access_key_id = self.access_key_id.trim().to_string();
        self.endpoint = self.endpoint.trim().to_string();
        self.remote_root = self.remote_root.trim().to_string();
        self.profile = self.profile.trim().to_string();
        if self.remote_root.is_empty() {
            self.remote_root = default_remote_root();
        }
        if self.profile.is_empty() {
            self.profile = default_profile();
        }
    }

    /// Returns true if all credential fields are blank (no config to persist).
    fn is_empty(&self) -> bool {
        self.bucket.is_empty()
            && self.region.is_empty()
            && self.access_key_id.is_empty()
            && self.secret_access_key.is_empty()
    }
}

/// 本机自动迁移状态。
///
/// 这里记录的是本机启动时执行过的一次性迁移；标记不随数据库同步。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalMigrations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_third_party_history_provider_bucket_v1:
        Option<CodexThirdPartyHistoryProviderBucketMigration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_provider_template_v1: Option<CodexProviderTemplateMigration>,
    /// 统一会话开关的官方历史迁移标记。开关关闭时会被清除，
    /// 这样重新开启能把"关闭期间"落入 openai 桶的官方会话补迁进来。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_official_history_unify_v1: Option<CodexOfficialHistoryUnifyMigration>,
    /// 旧版官方路由桶（`cc-switch-official`）迁回 openai 桶的标记，按 Codex 目录生效。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_legacy_official_history_bucket_v1: Option<CodexLegacyOfficialHistoryBucketMigration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThirdPartyHistoryProviderBucketMigration {
    pub completed_at: String,
    pub target_provider_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_provider_ids: Vec<String>,
    #[serde(default)]
    pub migrated_jsonl_files: usize,
    #[serde(default)]
    pub migrated_state_rows: usize,
    #[serde(default)]
    pub scanned_history_files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderTemplateMigration {
    pub completed_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub migrated_provider_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOfficialHistoryUnifyMigration {
    pub completed_at: String,
    pub target_provider_id: String,
    #[serde(default)]
    pub migrated_jsonl_files: usize,
    #[serde(default)]
    pub migrated_state_rows: usize,
    /// 迁移时的规范化 Codex 目录。标记只对同一目录生效：
    /// 切换 codex_config_dir 后旧标记不会挡住新目录的迁移。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLegacyOfficialHistoryBucketMigration {
    pub completed_at: String,
    pub target_provider_id: String,
    #[serde(default)]
    pub migrated_jsonl_files: usize,
    #[serde(default)]
    pub migrated_state_rows: usize,
    /// 迁移时的规范化 Codex 目录，切换 codex_config_dir 后新目录照常迁移。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config_dir: Option<String>,
}

/// 用量金额的显示方式。只影响显示：库里的费用一律是美元，按 `exchange_rates`
/// 换算后显示；值的合法性（认不认得币种、汇率是否为正数）由前端兜底。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageDisplaySettings {
    /// 显示币种（"USD" / "CNY" / "JPY" 等，见前端 `DISPLAY_CURRENCIES`），缺省为 USD
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// 1 美元折多少目标币种，按币种存：换回 USD 再换回来，填过的汇率还在
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exchange_rates: BTreeMap<String, f64>,
    /// 侧栏「今日」显示哪几项（"cost" / "tokens" / "requests" / "hitRate"，最多两项），
    /// 缺省只显示金额；空列表＝不显示，所以空列表也要写进文件
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_today_items: Option<Vec<String>>,
    /// 请求日志的列显隐：只存用户改过的列（列 id → 是否显示），没写的按各列默认值，
    /// 以后新加的列也按它自己的默认值出现
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub request_log_columns: BTreeMap<String, bool>,
    /// 用量趋势图的样式（"bar" / "area"），缺省为柱形图
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trend_chart_type: Option<String>,
}

/// 应用设置结构
///
/// 存储设备级别设置，保存在本地 `~/.cc-switch-remote/settings.json`，不随数据库同步。
/// 这确保了云同步场景下多设备可以独立运作。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // ===== 设备级 UI 设置 =====
    #[serde(default = "default_show_in_tray")]
    pub show_in_tray: bool,
    #[serde(default = "default_minimize_to_tray_on_close")]
    pub minimize_to_tray_on_close: bool,
    #[serde(default)]
    pub use_app_window_controls: bool,
    /// 是否启用 Claude 插件联动
    #[serde(default)]
    pub enable_claude_plugin_integration: bool,
    /// 是否跳过 Claude Code 初次安装确认
    #[serde(default)]
    pub skip_claude_onboarding: bool,
    /// 是否开机自启
    #[serde(default)]
    pub launch_on_startup: bool,
    /// 静默启动（程序启动时不显示主窗口，仅托盘运行）
    #[serde(default)]
    pub silent_startup: bool,
    /// 退出时是否处于轻量模式（主窗口已销毁、只留托盘）；下次启动按它恢复。
    /// 只经 [`set_lightweight_mode`] 写，前端全量保存不透传。
    #[serde(default)]
    pub lightweight_mode: bool,
    /// 是否在主页面启用本地代理功能（默认关闭）
    #[serde(default)]
    pub enable_local_proxy: bool,
    /// 是否在主页面显示 Stack 模式开关（默认关闭）。和 `enable_local_proxy` 二选一，只影响
    /// Claude Code、Codex：它们的开关换成 Stack 模式开关，其余应用仍显示路由开关。
    #[serde(default)]
    pub enable_stack_mode: bool,
    /// User has confirmed the local proxy first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_confirmed: Option<bool>,
    /// User has confirmed the usage query first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_dashboard_refresh_interval_ms: Option<u32>,
    /// 用量金额的显示币种与汇率（只影响显示）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_display: Option<UsageDisplaySettings>,
    /// 会话用量自动扫描开关（默认开启=自动模式）。关闭后停止后台定时扫描
    /// 各客户端会话日志，仅在用户点击"立即同步"时手动扫描；只管扫描时机，
    /// 代理接管记账与启动费用回填（不读会话文件）不受此开关影响。
    #[serde(default = "default_session_auto_sync_enabled")]
    pub session_auto_sync_enabled: bool,
    /// Whether to show the failover toggle independently on the main page
    #[serde(default)]
    pub enable_failover_toggle: bool,
    /// Whether to show the remote app routing toggle on the main page for this target
    #[serde(default)]
    pub enable_remote_routing_toggle: bool,
    /// Whether to show the remote failover toggle on the main page for this target
    #[serde(default)]
    pub enable_remote_failover_toggle: bool,
    /// Whether to show the project profile switcher on the main page header
    #[serde(default)]
    pub show_profile_switcher: bool,
    /// Show the provider search button in the provider page header (on by default;
    /// Cmd/Ctrl+F still opens the search when it is hidden)
    #[serde(default = "default_true")]
    pub show_provider_search: bool,
    /// Check installed CLI tools for new versions at startup (off by default:
    /// many users do not want to chase every release).
    #[serde(default)]
    pub check_tool_updates_on_startup: bool,
    /// 点托盘图标出原生菜单，不出托盘面板（macOS / Windows；Linux 只能出原生菜单，不看这一项）。
    /// 默认关：用托盘面板，想要原生菜单在设置里换回。
    #[serde(default)]
    pub native_tray_menu: bool,
    /// Keep Codex ChatGPT login material in auth.json when switching to third-party providers.
    /// Opt-in: defaults to false so third-party switches cleanly overwrite auth.json.
    #[serde(default)]
    pub preserve_codex_official_auth_on_switch: bool,
    /// Run official Codex providers under the shared "custom" model_provider id
    /// so official sessions share one resume-history bucket with third-party
    /// providers. Opt-in: defaults to false.
    #[serde(default)]
    pub unify_codex_session_history: bool,
    /// User opted in (via the enable dialog checkbox) to migrate existing
    /// official sessions ("openai" bucket) into the shared bucket. Persisted so
    /// a failed migration retries at startup; cleared when the toggle turns off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unify_codex_migrate_existing: Option<bool>,
    /// Codex 聚合模式下，合并目录里的每个模型都改用经典子 agent 工具（`multi_agent_version`
    /// 写 `"v1"`）。新版工具（v2）把派给子 agent 的任务加密，只有主 agent 那家后端解得开，
    /// 主、子 agent 不在同一家时子 agent 读不到任务。默认开（代价是没有新版工具的
    /// followup_task 等功能）。v4.0.10–4.0.12 用的是默认关的 `codexStackClassicSubagents`，
    /// 每次保存都会写下 `false`，分不清是不是用户关的：换了键名，旧键不再读，升级后一律按开。
    #[serde(default = "default_true")]
    pub codex_stack_classic_tools: bool,
    /// Codex 聚合模式下子 agent 默认用的模型（合并目录里的 slug，`ccs-<key>/<model>`）。
    /// 不设时跟随主模型。只在这个 slug 还在合并目录里时写进 `[agents]`，否则照样跟随主模型
    /// （成员移除后保留设置，加回来自动恢复）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_stack_subagent_model: Option<String>,
    /// 上面那个模型的推理强度。不在它支持的档位里时不写，用模型的默认档。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_stack_subagent_reasoning_effort: Option<String>,
    /// Codex 聚合模式下自动审批（Auto Review）用的模型（合并目录里的 slug）。不设时用 Codex
    /// 的默认：官方做默认那家时是官方的 `codex-auto-review`，否则由主模型自己审批。只在这个
    /// slug 还在合并目录里时写进目录行，规则同子 agent 模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_stack_auto_review_model: Option<String>,
    /// User has confirmed the failover toggle first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failover_confirmed: Option<bool>,
    /// User has confirmed the first-run welcome notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_run_notice_confirmed: Option<bool>,
    /// User has confirmed the one-time "new layout" dialog shown to upgrading users
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_layout_notice_confirmed: Option<bool>,
    /// Highest app version whose "what's new" summary the user has seen on this device
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whats_new_seen_version: Option<String>,
    /// User has confirmed the common config first-run notice
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub common_config_confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// 按档的额度百分比写「剩余」还是「已用」（`"left"` / `"used"`，缺省为剩余）。卡片、
    /// 授权中心和托盘一起变；余额、Credits、重置次数不受影响（#8024）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_display: Option<String>,

    // ===== 主页面显示的应用 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_apps: Option<VisibleApps>,
    /// 应用页和侧栏的应用顺序（应用 ID）。缺的应用由前端按默认顺序插回，不认识的忽略
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_order: Option<Vec<String>>,

    // ===== 设备级目录覆盖 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grok_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openclaw_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hermes_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi_config_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omp_config_dir: Option<String>,

    // ===== 当前供应商 ID（设备级）=====
    /// 当前 Claude 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_claude: Option<String>,
    /// 当前 Claude Desktop 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_claude_desktop: Option<String>,
    /// 当前 Codex 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_codex: Option<String>,
    /// 当前 Gemini 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_gemini: Option<String>,
    /// 当前 Grok Build 供应商 ID（本地存储，优先于数据库 is_current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_grokbuild: Option<String>,
    /// 当前 OpenCode 供应商 ID（本地存储，对 OpenCode 可能无意义，但保持结构一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_opencode: Option<String>,
    /// 当前 OpenClaw 供应商 ID（本地存储，对 OpenClaw 可能无意义，但保持结构一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_openclaw: Option<String>,
    /// 当前 Hermes 供应商 ID（本地存储，保持结构一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_hermes: Option<String>,
    /// 当前 Antigravity CLI 供应商 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_provider_agy: Option<String>,

    // ===== 本地路由（设备级）=====
    /// 写给客户端的代理主机（IP 或主机名），空/未设时按监听地址推（`0.0.0.0` → `127.0.0.1`）。
    /// 客户端和代理不在同一个网络栈时用，比如 WSL2 NAT 模式里的会话连不到 Windows 的回环。
    /// 只对这台机器有意义，所以不放在会随云同步覆盖的 proxy_config 表里。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_client_host: Option<String>,

    // ===== Skill 同步设置 =====
    /// Skill 同步方式：auto（默认，优先 symlink）、symlink、copy
    #[serde(default)]
    pub skill_sync_method: SyncMethod,
    /// Skill 存储位置：cc_switch（默认）或 unified（~/.agents/skills/）
    #[serde(default)]
    pub skill_storage_location: SkillStorageLocation,

    // ===== WebDAV 同步设置 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav_sync: Option<WebDavSyncSettings>,

    // ===== S3 同步设置 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3_sync: Option<S3SyncSettings>,

    // ===== WebDAV 备份设置（旧版，保留向后兼容）=====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav_backup: Option<serde_json::Value>,

    // ===== 备份策略设置 =====
    /// Auto-backup interval in hours (default 24, 0 = disabled)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_interval_hours: Option<u32>,
    /// Maximum number of backup files to retain (default 10)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_retain_count: Option<u32>,

    // ===== 终端设置 =====
    /// 首选终端应用（可选，默认使用系统默认终端）
    /// - macOS: "terminal" | "iterm2" | "warp" | "alacritty" | "kitty" | "ghostty" | "otty" | "wezterm" | "kaku"
    /// - Windows: "cmd" | "powershell" | "wt" (Windows Terminal)
    /// - Linux: "gnome-terminal" | "konsole" | "xfce4-terminal" | "alacritty" | "kitty" | "ghostty"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_terminal: Option<String>,

    // ===== 本机自动迁移状态 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_migrations: Option<LocalMigrations>,
}

fn default_show_in_tray() -> bool {
    true
}

fn default_minimize_to_tray_on_close() -> bool {
    true
}

fn default_session_auto_sync_enabled() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            show_in_tray: true,
            minimize_to_tray_on_close: true,
            use_app_window_controls: false,
            enable_claude_plugin_integration: false,
            skip_claude_onboarding: false,
            launch_on_startup: false,
            silent_startup: false,
            lightweight_mode: false,
            enable_local_proxy: false,
            enable_stack_mode: false,
            proxy_confirmed: None,
            usage_confirmed: None,
            usage_dashboard_refresh_interval_ms: None,
            usage_display: None,
            session_auto_sync_enabled: true,
            enable_failover_toggle: false,
            enable_remote_routing_toggle: false,
            enable_remote_failover_toggle: false,
            show_profile_switcher: false,
            show_provider_search: true,
            check_tool_updates_on_startup: false,
            native_tray_menu: false,
            preserve_codex_official_auth_on_switch: false,
            unify_codex_session_history: false,
            unify_codex_migrate_existing: None,
            codex_stack_classic_tools: true,
            codex_stack_subagent_model: None,
            codex_stack_subagent_reasoning_effort: None,
            codex_stack_auto_review_model: None,
            failover_confirmed: None,
            first_run_notice_confirmed: None,
            new_layout_notice_confirmed: None,
            whats_new_seen_version: None,
            common_config_confirmed: None,
            language: None,
            quota_display: None,
            visible_apps: None,
            app_order: None,
            claude_config_dir: None,
            codex_config_dir: None,
            gemini_config_dir: None,
            grok_config_dir: None,
            opencode_config_dir: None,
            openclaw_config_dir: None,
            hermes_config_dir: None,
            pi_config_dir: None,
            omp_config_dir: None,
            current_provider_claude: None,
            current_provider_claude_desktop: None,
            current_provider_codex: None,
            current_provider_gemini: None,
            current_provider_grokbuild: None,
            current_provider_opencode: None,
            current_provider_openclaw: None,
            current_provider_hermes: None,
            current_provider_agy: None,
            proxy_client_host: None,
            skill_sync_method: SyncMethod::default(),
            skill_storage_location: SkillStorageLocation::default(),
            webdav_sync: None,
            s3_sync: None,
            webdav_backup: None,
            backup_interval_hours: None,
            backup_retain_count: None,
            preferred_terminal: None,
            local_migrations: None,
        }
    }
}

impl AppSettings {
    /// 额度百分比按「已用」写（默认按剩余）
    pub fn quota_shows_used(&self) -> bool {
        self.quota_display.as_deref() == Some("used")
    }

    fn settings_path() -> Option<PathBuf> {
        // settings.json 保留用于旧版本迁移和无数据库场景
        Some(crate::config::get_app_config_dir().join("settings.json"))
    }

    fn normalize_paths(&mut self) {
        self.claude_config_dir = self
            .claude_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.codex_config_dir = self
            .codex_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.gemini_config_dir = self
            .gemini_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.grok_config_dir = self
            .grok_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.opencode_config_dir = self
            .opencode_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.openclaw_config_dir = self
            .openclaw_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.hermes_config_dir = self
            .hermes_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.pi_config_dir = self
            .pi_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.omp_config_dir = self
            .omp_config_dir
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        self.language = self
            .language
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| matches!(*s, "en" | "zh" | "zh-TW" | "ja" | "tr"))
            .map(|s| s.to_string());

        self.quota_display = self
            .quota_display
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| matches!(*s, "left" | "used"))
            .map(|s| s.to_string());

        if let Some(sync) = &mut self.webdav_sync {
            sync.normalize();
            if sync.is_empty() {
                self.webdav_sync = None;
            }
        }

        if let Some(s3) = &mut self.s3_sync {
            s3.normalize();
            if s3.is_empty() {
                self.s3_sync = None;
            }
        }
    }

    fn load_from_file() -> Self {
        let Some(path) = Self::settings_path() else {
            return Self::default();
        };
        let loaded = load_settings_from_path(&path);
        if loaded.lossy {
            match backup_settings_file(&path) {
                Ok(dest) => log::warn!("设置文件未能完整读取，原文件已备份到 {}", dest.display()),
                Err(err) => {
                    log::error!("设置文件未能完整读取，备份失败: {}: {err}", path.display())
                }
            }
        }
        let mut settings = loaded.settings;
        settings.normalize_paths();
        settings
    }
}

/// 读文件的 I/O 错误多是暂时的（Windows 上杀毒软件、同步盘短暂独占文件），重试几次再放弃。
const SETTINGS_READ_ATTEMPTS: u32 = 5;
const SETTINGS_READ_RETRY_DELAY: Duration = Duration::from_millis(200);

struct LoadedSettings {
    settings: AppSettings,
    /// 文件存在，但没有被完整读进来：读不了、不是合法 JSON，或丢弃了部分无效字段。
    lossy: bool,
}

fn load_settings_from_path(path: &Path) -> LoadedSettings {
    let bytes = match read_settings_bytes(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            return LoadedSettings {
                settings: AppSettings::default(),
                lossy: false,
            }
        }
        Err(err) => {
            log::error!(
                "读取设置文件失败，本次使用默认设置。路径: {}, 错误: {err}",
                path.display()
            );
            return LoadedSettings {
                settings: AppSettings::default(),
                lossy: true,
            };
        }
    };
    let (text, bad_utf8) = match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(err) => (String::from_utf8_lossy(err.as_bytes()).into_owned(), true),
    };
    let (settings, parse_lossy) = parse_settings_lenient(&text);
    LoadedSettings {
        settings,
        lossy: bad_utf8 || parse_lossy,
    }
}

/// 文件不存在时返回 `None`；其它 I/O 错误重试几次仍失败才返回。
fn read_settings_bytes(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let mut attempt = 1;
    loop {
        match fs::read(path) {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) if attempt >= SETTINGS_READ_ATTEMPTS => return Err(err),
            Err(err) => {
                log::warn!(
                    "读取设置文件失败（第 {attempt} 次），稍后重试: {}: {err}",
                    path.display()
                );
                std::thread::sleep(SETTINGS_READ_RETRY_DELAY);
                attempt += 1;
            }
        }
    }
}

/// 解析设置；整体解析失败时逐个字段挑出还能用的，只丢无效的那几项。
/// 返回值第二项表示是否有内容被丢弃。
fn parse_settings_lenient(content: &str) -> (AppSettings, bool) {
    // 记事本等编辑器会写 UTF-8 BOM，serde_json 不认它，去掉不算丢内容。
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let err = match serde_json::from_str::<AppSettings>(content) {
        Ok(settings) => return (settings, false),
        Err(err) => err,
    };
    // 旧版在个别 Windows 环境下保存时文件没被截短（#8429），新内容后面残留着旧内容的尾巴；
    // 开头那个完整的对象就是最后一次保存的内容，只取它，不因尾巴把整份设置丢掉。
    let first = serde_json::Deserializer::from_str(content)
        .into_iter::<serde_json::Value>()
        .next();
    let Some(Ok(serde_json::Value::Object(map))) = first else {
        log::warn!("设置文件不是合法的 JSON 对象，本次使用默认设置: {err}");
        return (AppSettings::default(), true);
    };

    // 每个字段都有默认值，单独一个键能反序列化就说明它本身是有效的。
    let mut kept = serde_json::Map::new();
    let mut dropped = Vec::new();
    for (key, value) in map {
        let single =
            serde_json::Value::Object(serde_json::Map::from_iter([(key.clone(), value.clone())]));
        if serde_json::from_value::<AppSettings>(single).is_ok() {
            kept.insert(key, value);
        } else {
            dropped.push(key);
        }
    }
    log::warn!("设置文件有无效字段，已丢弃 {dropped:?}，其余设置照常读取: {err}");
    let settings = serde_json::from_value(serde_json::Value::Object(kept)).unwrap_or_default();
    (settings, true)
}

/// 把原文件原样复制一份到同目录 `settings.json.broken-<时间>.bak`。
fn backup_settings_file(path: &Path) -> std::io::Result<PathBuf> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_string());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dest = path.with_file_name(format!("{file_name}.broken-{stamp}.bak"));
    // fs::copy 在 Unix 上连同权限位一起复制，副本和原文件一样是 0600（里面可能有同步密码）。
    fs::copy(path, &dest)?;
    Ok(dest)
}

fn open_settings_lock(path: &Path) -> Result<fs::File, AppError> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    options
        .open(path)
        .map_err(|error| AppError::io(path, error))
}

#[cfg(unix)]
fn try_lock_settings(file: &fs::File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    match error.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted => Ok(false),
        _ => Err(error),
    }
}

#[cfg(windows)]
fn try_lock_settings(file: &fs::File) -> std::io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::ERROR_LOCK_VIOLATION, Storage::FileSystem::LockFile};
    if unsafe { LockFile(file.as_raw_handle(), 0, 0, 1, 0) } != 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        Ok(false)
    } else {
        Err(error)
    }
}

/// The lock file is stable across atomic replacements of `settings.json` and
/// is never removed. The OS releases the lock when its handle closes.
struct SettingsFile {
    path: PathBuf,
    _lock: fs::File,
    document: Value,
    settings: AppSettings,
}

impl SettingsFile {
    fn begin(path: PathBuf) -> Result<Self, AppError> {
        let lock_path = path.with_extension("json.lock");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| AppError::io(parent, error))?;
        }
        let lock = open_settings_lock(&lock_path)?;
        let start = Instant::now();
        while !try_lock_settings(&lock).map_err(|error| AppError::io(&lock_path, error))? {
            if start.elapsed() >= Duration::from_secs(5) {
                return Err(AppError::io(
                    &lock_path,
                    std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "settings are locked by another writer",
                    ),
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let (document, mut settings) =
            match read_settings_bytes(&path).map_err(|error| AppError::io(&path, error))? {
                Some(bytes) => {
                    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
                    let document: Value = serde_json::from_slice(bytes)
                        .map_err(|error| AppError::json(&path, error))?;
                    if !document.is_object() {
                        return Err(AppError::Config(format!(
                            "Expected a settings object: {}",
                            path.display()
                        )));
                    }
                    let settings = serde_json::from_slice(bytes)
                        .map_err(|error| AppError::json(&path, error))?;
                    (document, settings)
                }
                None => {
                    let defaults = AppSettings::default();
                    (settings_as_json(&defaults)?, defaults)
                }
            };
        settings.normalize_paths();
        Ok(Self {
            path,
            _lock: lock,
            document,
            settings,
        })
    }

    fn current() -> Result<Self, AppError> {
        Self::begin(AppSettings::settings_path().expect("settings path"))
    }

    fn commit(self, next: AppSettings) -> Result<(), AppError> {
        self.commit_with(next, crate::config::atomic_write_private)
    }

    fn commit_with(
        mut self,
        mut next: AppSettings,
        write: impl FnOnce(&Path, &[u8]) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        next.normalize_paths();
        let previous = settings_as_json(&self.settings)?;
        let updated = settings_as_json(&next)?;
        if previous == updated && self.path.is_file() {
            publish_settings(&self.path, self.settings);
            return Ok(());
        }
        apply_settings_delta(&mut self.document, &previous, &updated, false);
        let json = serde_json::to_vec_pretty(&self.document)
            .map_err(|source| AppError::JsonSerialize { source })?;
        write(&self.path, &json)?;
        publish_settings(&self.path, next);
        Ok(())
    }
}

fn settings_as_json(settings: &AppSettings) -> Result<Value, AppError> {
    serde_json::to_value(settings).map_err(|source| AppError::JsonSerialize { source })
}

/// Apply only changed known fields to the original JSON, keeping unknown keys.
/// During rollback, revert only values that still match the failed save.
fn apply_settings_delta(current: &mut Value, before: &Value, after: &Value, compare: bool) {
    let (Some(current), Some(before), Some(after)) = (
        current.as_object_mut(),
        before.as_object(),
        after.as_object(),
    ) else {
        return;
    };
    for key in before
        .keys()
        .chain(after.keys().filter(|key| !before.contains_key(*key)))
    {
        let previous = before.get(key);
        let next = after.get(key);
        if previous == next {
            continue;
        }
        if let (
            Some(previous @ Value::Object(_)),
            Some(next @ Value::Object(_)),
            Some(value @ Value::Object(_)),
        ) = (previous, next, current.get_mut(key))
        {
            apply_settings_delta(value, previous, next, compare);
        } else if !compare || current.get(key) == previous {
            match next {
                Some(value) => {
                    current.insert(key.clone(), value.clone());
                }
                None => {
                    current.remove(key);
                }
            }
        }
    }
}

#[cfg(test)]
fn save_settings_file_at_path(
    settings: &AppSettings,
    path: &Path,
    failure: Option<crate::config::AtomicWriteFailure>,
) -> Result<(), AppError> {
    let mut normalized = settings.clone();
    normalized.normalize_paths();
    let json = serde_json::to_string_pretty(&normalized)
        .map_err(|e| AppError::JsonSerialize { source: e })?;
    match failure {
        Some(failure) => {
            crate::config::atomic_write_private_with_failure(path, json.as_bytes(), failure)
        }
        None => crate::config::atomic_write_private(path, json.as_bytes()),
    }
}

static SETTINGS_STORE: OnceLock<RwLock<AppSettings>> = OnceLock::new();
static SETTINGS_TRANSACTION: OnceLock<Mutex<()>> = OnceLock::new();
static FULL_SETTINGS_SAVE: Mutex<()> = Mutex::new(());

fn settings_store() -> &'static RwLock<AppSettings> {
    SETTINGS_STORE.get_or_init(|| RwLock::new(AppSettings::load_from_file()))
}

fn publish_settings(path: &Path, settings: AppSettings) {
    if AppSettings::settings_path().as_deref() != Some(path) {
        return;
    }
    let mut guard = SETTINGS_STORE
        .get_or_init(|| RwLock::new(settings.clone()))
        .write()
        .unwrap_or_else(|error| error.into_inner());
    *guard = settings;
}

fn settings_transaction() -> MutexGuard<'static, ()> {
    SETTINGS_TRANSACTION
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| {
            log::warn!("设置事务锁已毒化，继续使用恢复值: {error}");
            error.into_inner()
        })
}

pub(crate) fn resolve_override_path(raw: &str) -> PathBuf {
    let join_home = |home: PathBuf, suffix: &str| {
        suffix
            .split(['/', '\\'])
            .filter(|component| !component.is_empty())
            .fold(home, |path, component| path.join(component))
    };

    if raw == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(stripped) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return join_home(home, stripped);
        }
    } else if let Some(stripped) = raw.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return join_home(home, stripped);
        }
    }

    PathBuf::from(raw)
}

pub fn get_settings() -> AppSettings {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .clone()
}

pub fn get_settings_for_frontend() -> AppSettings {
    let mut settings = read_settings_snapshot();
    if let Some(sync) = &mut settings.webdav_sync {
        sync.password.clear();
    }
    if let Some(s3) = &mut settings.s3_sync {
        s3.secret_access_key.clear();
    }
    settings.webdav_backup = None;
    settings
}

fn read_settings_snapshot() -> AppSettings {
    let mut settings = AppSettings::settings_path()
        .map(|path| load_settings_from_path(&path).settings)
        .unwrap_or_default();
    settings.normalize_paths();
    settings
}

pub(crate) fn merge_settings_for_save(
    mut incoming: AppSettings,
    existing: &AppSettings,
) -> AppSettings {
    match (&mut incoming.webdav_sync, &existing.webdav_sync) {
        (None, _) => incoming.webdav_sync = existing.webdav_sync.clone(),
        (Some(incoming_sync), Some(existing_sync)) => {
            if incoming_sync.password.is_empty() && !existing_sync.password.is_empty() {
                incoming_sync.password = existing_sync.password.clone();
            }
            // Sync workers own progress/error/etag/hash state. The frontend can
            // legitimately submit an older full settings snapshot, so it must
            // never write this status back over the transaction's latest value.
            incoming_sync.status = existing_sync.status.clone();
        }
        _ => {}
    }
    match (&mut incoming.s3_sync, &existing.s3_sync) {
        (None, _) => incoming.s3_sync = existing.s3_sync.clone(),
        (Some(incoming_sync), Some(existing_sync)) => {
            if incoming_sync.secret_access_key.is_empty()
                && !existing_sync.secret_access_key.is_empty()
            {
                incoming_sync.secret_access_key = existing_sync.secret_access_key.clone();
            }
            incoming_sync.status = existing_sync.status.clone();
        }
        _ => {}
    }
    // The compatibility payload is deliberately hidden by the frontend getter;
    // only the backend can carry it forward or migrate it.
    incoming.webdav_backup = existing.webdav_backup.clone();
    // Migration markers are backend-owned. A stale/redacted frontend payload
    // must neither clear nor resurrect them.
    incoming.local_migrations = existing.local_migrations.clone();
    incoming.proxy_client_host = existing.proxy_client_host.clone();
    incoming.lightweight_mode = existing.lightweight_mode;
    incoming.current_provider_claude = existing.current_provider_claude.clone();
    incoming.current_provider_claude_desktop = existing.current_provider_claude_desktop.clone();
    incoming.current_provider_codex = existing.current_provider_codex.clone();
    incoming.current_provider_gemini = existing.current_provider_gemini.clone();
    incoming.current_provider_grokbuild = existing.current_provider_grokbuild.clone();
    incoming.current_provider_opencode = existing.current_provider_opencode.clone();
    incoming.current_provider_openclaw = existing.current_provider_openclaw.clone();
    incoming.current_provider_hermes = existing.current_provider_hermes.clone();
    incoming.current_provider_agy = existing.current_provider_agy.clone();
    incoming
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSaveWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSaveResult {
    pub saved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<SettingsSaveWarning>,
}

impl<'de> Deserialize<'de> for SettingsSaveResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StructuredResult {
            saved: bool,
            #[serde(default)]
            warning: Option<SettingsSaveWarning>,
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum WireResult {
            Structured(StructuredResult),
            Legacy(bool),
        }

        match WireResult::deserialize(deserializer)? {
            WireResult::Structured(result) => Ok(Self {
                saved: result.saved,
                warning: result.warning,
            }),
            WireResult::Legacy(saved) => Ok(Self {
                saved,
                warning: None,
            }),
        }
    }
}

/// Serialize disk updates separately from live Codex work: provider operations
/// can hold the Codex mode lock while acquiring the settings writer lock.
pub(crate) fn save_settings_with_state(
    state: &crate::store::AppState,
    settings: AppSettings,
) -> Result<SettingsSaveResult, String> {
    save_settings_with_state_and_migration_runner(state, settings, || {
        retry_pending_codex_history_migration()
    })
}

pub(crate) fn save_settings_with_state_and_migration_runner<F>(
    state: &crate::store::AppState,
    settings: AppSettings,
    migration_runner: F,
) -> Result<SettingsSaveResult, String>
where
    F: FnOnce() -> Result<(), AppError>,
{
    let save = FULL_SETTINGS_SAVE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let transaction = settings_transaction();
    let file = SettingsFile::current().map_err(|err| err.to_string())?;
    let path = file.path.clone();
    let existing = file.settings.clone();
    let mut merged = merge_settings_for_save(settings, &existing);
    let unify_codex_changed =
        merged.unify_codex_session_history != existing.unify_codex_session_history;
    let unify_codex_enabled = merged.unify_codex_session_history;
    let stack_settings_changed = merged.codex_stack_classic_tools
        != existing.codex_stack_classic_tools
        || merged.codex_stack_subagent_model != existing.codex_stack_subagent_model
        || merged.codex_stack_subagent_reasoning_effort
            != existing.codex_stack_subagent_reasoning_effort
        || merged.codex_stack_auto_review_model != existing.codex_stack_auto_review_model;

    if unify_codex_changed && !unify_codex_enabled {
        if let Some(migrations) = merged.local_migrations.as_mut() {
            migrations.codex_official_history_unify_v1 = None;
        }
        merged.unify_codex_migrate_existing = None;
    }
    merged.normalize_paths();
    file.commit(merged.clone()).map_err(|e| e.to_string())?;
    drop(transaction);
    if stack_settings_changed {
        if let Err(error) =
            futures::executor::block_on(crate::mode::controller::resync_codex_stack_catalog(state))
        {
            let mut rollback = merged.clone();
            rollback.codex_stack_classic_tools = existing.codex_stack_classic_tools;
            rollback.codex_stack_subagent_model = existing.codex_stack_subagent_model.clone();
            rollback.codex_stack_subagent_reasoning_effort =
                existing.codex_stack_subagent_reasoning_effort.clone();
            rollback.codex_stack_auto_review_model = existing.codex_stack_auto_review_model.clone();
            rollback_settings(&path, &merged, &rollback)
                .map_err(|e| format!("{error}; settings rollback failed: {e}"))?;
            return Err(format!(
                "The aggregation setting did not take effect: {error}"
            ));
        }
    }

    if unify_codex_changed {
        if let Err(err) = crate::services::provider::reapply_current_codex_official_live(state) {
            log::warn!("统一 Codex 会话历史开关变更后重写 live 配置失败，回滚设置: {err}");
            if let Err(rollback_err) = rollback_settings(&path, &merged, &existing) {
                log::error!("回滚统一会话开关设置失败: {rollback_err}");
            }
            return Err(format!(
                "统一 Codex 会话历史开关未生效（live 配置重写失败）: {err}"
            ));
        }
    }
    drop(save);
    let warning = if unify_codex_changed && unify_codex_enabled {
        migration_runner().err().map(|error| {
            let message = format!("设置已保存，但 Codex 历史迁移仍待重试: {error}");
            log::warn!("{message}");
            SettingsSaveWarning {
                code: "codex_history_migration_pending".to_string(),
                message,
            }
        })
    } else {
        None
    };
    Ok(SettingsSaveResult {
        saved: true,
        warning,
    })
}

fn retry_pending_codex_history_migration_with<F>(runner: F) -> Result<(), AppError>
where
    F: FnOnce() -> Result<(), AppError>,
{
    if !unify_codex_session_history() || !unify_codex_migrate_existing_requested() {
        return Ok(());
    }
    runner()
}

pub(crate) fn retry_pending_codex_history_migration() -> Result<(), AppError> {
    retry_pending_codex_history_migration_with(|| {
        let outcome =
            crate::codex_history_migration::maybe_migrate_codex_official_history_to_unified_bucket(
            )?;
        if let Some(reason) = outcome.skipped_reason {
            log::debug!("○ Codex official history unify migration skipped: {reason}");
        } else {
            log::info!(
                "✓ Codex official history unify migration completed: jsonl_files={}, state_rows={}",
                outcome.migrated_jsonl_files,
                outcome.migrated_state_rows
            );
        }
        Ok(())
    })
}

/// Explicit replacement of known fields; unlike the UI save this also replaces
/// backend-owned fields. Do not pass a cached snapshot to mutate a setting.
pub fn update_settings(new_settings: AppSettings) -> Result<(), AppError> {
    let _transaction = settings_transaction();
    SettingsFile::current()?.commit(new_settings)
}

fn rollback_settings(
    path: &Path,
    written: &AppSettings,
    previous: &AppSettings,
) -> Result<(), AppError> {
    let _transaction = settings_transaction();
    let file = SettingsFile::begin(path.to_path_buf())?;
    let mut rollback = settings_as_json(&file.settings)?;
    apply_settings_delta(
        &mut rollback,
        &settings_as_json(written)?,
        &settings_as_json(previous)?,
        true,
    );
    let rollback = serde_json::from_value(rollback).map_err(|error| AppError::json(path, error))?;
    file.commit(rollback)
}

fn mutate_settings<F>(mutator: F) -> Result<(), AppError>
where
    F: FnOnce(&mut AppSettings),
{
    let _transaction = settings_transaction();
    let file = SettingsFile::current()?;
    let mut next = file.settings.clone();
    mutator(&mut next);
    file.commit(next)
}

pub fn is_codex_third_party_history_provider_bucket_migrated() -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| {
            migrations
                .codex_third_party_history_provider_bucket_v1
                .as_ref()
        })
        .is_some_and(|m| m.scanned_history_files)
}

pub fn mark_codex_third_party_history_provider_bucket_migrated(
    migration: CodexThirdPartyHistoryProviderBucketMigration,
) -> Result<(), AppError> {
    mutate_settings(|settings| {
        let migrations = settings
            .local_migrations
            .get_or_insert_with(Default::default);
        migrations.codex_third_party_history_provider_bucket_v1 = Some(migration);
    })
}

pub fn is_codex_provider_template_migrated() -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| migrations.codex_provider_template_v1.as_ref())
        .is_some()
}

pub fn mark_codex_provider_template_migrated(
    migration: CodexProviderTemplateMigration,
) -> Result<(), AppError> {
    mutate_settings(|settings| {
        let migrations = settings
            .local_migrations
            .get_or_insert_with(Default::default);
        migrations.codex_provider_template_v1 = Some(migration);
    })
}

/// 统一会话迁移标记是否覆盖指定目录。标记里没记目录（不应出现的旧格式）
/// 视为不匹配——重跑迁移是幂等的，宁可重迁也不漏迁。
pub fn is_codex_official_history_unify_migrated_for_dir(codex_dir: &str) -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| migrations.codex_official_history_unify_v1.as_ref())
        .is_some_and(|migration| migration.codex_config_dir.as_deref() == Some(codex_dir))
}

/// 条件写入迁移完成标记：仅当此刻开关仍开启且迁移意愿仍在时才写。
/// 检查与写入在 settings 写锁内原子完成，与关闭开关路径
/// （`update_settings` / 清标记）串行，消除"迁移线程复查开关后、写标记前
/// 用户恰好关闭开关"的竞态窗口。返回是否实际写入。
pub fn mark_codex_official_history_unify_migrated_if_enabled(
    migration: CodexOfficialHistoryUnifyMigration,
) -> Result<bool, AppError> {
    let mut written = false;
    mutate_settings(|settings| {
        if settings.unify_codex_session_history
            && settings.unify_codex_migrate_existing.unwrap_or(false)
        {
            settings
                .local_migrations
                .get_or_insert_with(Default::default)
                .codex_official_history_unify_v1 = Some(migration);
            written = true;
        }
    })?;
    Ok(written)
}

pub fn is_codex_legacy_official_history_bucket_migrated_for_dir(codex_dir: &str) -> bool {
    get_settings()
        .local_migrations
        .as_ref()
        .and_then(|migrations| migrations.codex_legacy_official_history_bucket_v1.as_ref())
        .is_some_and(|migration| migration.codex_config_dir.as_deref() == Some(codex_dir))
}

pub fn mark_codex_legacy_official_history_bucket_migrated(
    migration: CodexLegacyOfficialHistoryBucketMigration,
) -> Result<(), AppError> {
    mutate_settings(|settings| {
        settings
            .local_migrations
            .get_or_insert_with(Default::default)
            .codex_legacy_official_history_bucket_v1 = Some(migration);
    })
}

pub fn unify_codex_migrate_existing_requested() -> bool {
    codex_live_settings()
        .unify_codex_migrate_existing
        .unwrap_or(false)
}

/// 记下当前是否处于轻量模式（见 [`AppSettings::lightweight_mode`]），值没变就不写盘。
pub fn set_lightweight_mode(enabled: bool) -> Result<(), AppError> {
    mutate_settings(|settings| settings.lightweight_mode = enabled)
}

/// 客户端地址（见 [`AppSettings::proxy_client_host`]），去掉首尾空白；没设或为空时是 `None`。
pub fn get_proxy_client_host() -> Option<String> {
    get_settings()
        .proxy_client_host
        .map(|host| host.trim().to_string())
        .filter(|host| !host.is_empty())
}

pub fn set_proxy_client_host(host: &str) -> Result<(), AppError> {
    let host = host.trim();
    mutate_settings(|settings| {
        settings.proxy_client_host = (!host.is_empty()).then(|| host.to_string());
    })
}

/// 从文件重新加载设置到内存缓存
/// 用于导入配置等场景，确保内存缓存与文件同步
pub fn reload_settings() -> Result<(), AppError> {
    let _transaction = settings_transaction();
    let path = AppSettings::settings_path().expect("settings path");
    publish_settings(&path, AppSettings::load_from_file());
    Ok(())
}

#[cfg(test)]
fn save_settings_payload_with_snapshot_barrier<F>(
    settings: AppSettings,
    after_snapshot: F,
) -> Result<(), AppError>
where
    F: FnOnce(),
{
    let _transaction = settings_transaction();
    let file = SettingsFile::current()?;
    let merged = merge_settings_for_save(settings, &file.settings);
    after_snapshot();
    file.commit(merged)
}

pub fn get_claude_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .claude_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_codex_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .codex_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_gemini_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .gemini_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_grok_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .grok_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_opencode_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .opencode_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_openclaw_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .openclaw_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_hermes_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .hermes_config_dir
        .as_ref()
        .map(|p| resolve_override_path(p))
}

pub fn get_pi_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .pi_config_dir
        .as_ref()
        .map(|path| resolve_override_path(path))
}
pub fn get_omp_override_dir() -> Option<PathBuf> {
    let settings = settings_store().read().ok()?;
    settings
        .omp_config_dir
        .as_ref()
        .map(|path| resolve_override_path(path))
}

pub fn preserve_codex_official_auth_on_switch() -> bool {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .preserve_codex_official_auth_on_switch
}

pub fn unify_codex_session_history() -> bool {
    codex_live_settings().unify_codex_session_history
}

pub fn codex_stack_classic_tools() -> bool {
    codex_live_settings().codex_stack_classic_tools
}

/// Codex 聚合模式下的子 agent 设置：(模型 slug, 推理强度)，空串当作没设。
pub fn codex_stack_subagent() -> (Option<String>, Option<String>) {
    let settings = codex_live_settings();
    let non_empty = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    (
        non_empty(&settings.codex_stack_subagent_model),
        non_empty(&settings.codex_stack_subagent_reasoning_effort),
    )
}

/// Codex 聚合模式下的自动审批模型 slug，空串当作没设。
pub fn codex_stack_auto_review_model() -> Option<String> {
    codex_live_settings()
        .codex_stack_auto_review_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

fn codex_live_settings() -> AppSettings {
    let path = AppSettings::settings_path().expect("settings path");
    let loaded = load_settings_from_path(&path);
    if loaded.lossy {
        return get_settings();
    }
    loaded.settings
}

// ===== 当前供应商管理函数 =====

/// 获取指定应用类型的当前供应商 ID（从本地 settings 读取）
///
/// 这是设备级别的设置，不随数据库同步。
/// 如果本地没有设置，调用者应该 fallback 到数据库的 `is_current` 字段。
pub fn get_current_provider(app_type: &AppType) -> Option<String> {
    if matches!(
        app_type,
        AppType::Pi | AppType::Mcode | AppType::Kimi | AppType::Omp
    ) {
        return None;
    }
    let path = AppSettings::settings_path()?;
    let loaded = load_settings_from_path(&path);
    if loaded.lossy {
        return None;
    }
    let settings = loaded.settings;
    match app_type {
        AppType::Claude => settings.current_provider_claude.clone(),
        AppType::ClaudeDesktop => settings.current_provider_claude_desktop.clone(),
        AppType::Codex => settings.current_provider_codex.clone(),
        AppType::Gemini => settings.current_provider_gemini.clone(),
        AppType::GrokBuild => settings.current_provider_grokbuild.clone(),
        AppType::OpenCode => settings.current_provider_opencode.clone(),
        AppType::OpenClaw => settings.current_provider_openclaw.clone(),
        AppType::Hermes => settings.current_provider_hermes.clone(),
        AppType::Agy => settings.current_provider_agy.clone(),
        AppType::Pi | AppType::Mcode | AppType::Kimi | AppType::Omp => None,
    }
}

/// 设置指定应用类型的当前供应商 ID（保存到本地 settings）
///
/// 这是设备级别的设置，不随数据库同步。
/// 传入 `None` 会清除当前供应商设置。
pub fn set_current_provider(app_type: &AppType, id: Option<&str>) -> Result<(), AppError> {
    let id_owned = id.map(|s| s.to_string());
    mutate_settings(|settings| match app_type {
        AppType::Claude => settings.current_provider_claude = id_owned.clone(),
        AppType::ClaudeDesktop => settings.current_provider_claude_desktop = id_owned.clone(),
        AppType::Codex => settings.current_provider_codex = id_owned.clone(),
        AppType::Gemini => settings.current_provider_gemini = id_owned.clone(),
        AppType::GrokBuild => settings.current_provider_grokbuild = id_owned.clone(),
        AppType::OpenCode => settings.current_provider_opencode = id_owned.clone(),
        AppType::OpenClaw => settings.current_provider_openclaw = id_owned.clone(),
        AppType::Hermes => settings.current_provider_hermes = id_owned.clone(),
        AppType::Agy => settings.current_provider_agy = id_owned.clone(),
        AppType::Pi | AppType::Mcode | AppType::Kimi | AppType::Omp => {}
    })
}

/// 获取有效的当前供应商 ID（验证存在性）
///
/// 逻辑：
/// 1. 从本地 settings 读取当前供应商 ID
/// 2. 验证该 ID 在数据库中存在
/// 3. 如果不存在则直接 fallback 到数据库的 is_current，不改写设置
///
/// 这确保了返回的 ID 一定是有效的（在数据库中存在）。
/// 多设备云同步场景下，配置导入后本地 ID 可能失效。
pub fn get_effective_current_provider(
    db: &crate::database::Database,
    app_type: &AppType,
) -> Result<Option<String>, AppError> {
    // 1. 从本地 settings 读取
    if let Some(local_id) = get_current_provider(app_type) {
        // 2. 验证该 ID 在数据库中存在
        if db
            .get_provider_by_id(&local_id, app_type.as_str())?
            .is_some()
        {
            // 存在，直接返回
            return Ok(Some(local_id));
        }

        log::warn!(
            "本地 settings 中的供应商 {} ({}) 在数据库中不存在，fallback 到数据库",
            local_id,
            app_type.as_str()
        );
    }

    // Fallback 到数据库的 is_current
    db.get_current_provider(app_type.as_str())
}

// ===== Skill 同步方式管理函数 =====

/// 获取 Skill 同步方式配置
pub fn get_skill_sync_method() -> SyncMethod {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .skill_sync_method
}

// ===== Skill 存储位置管理函数 =====

/// 获取 Skill 存储位置配置
pub fn get_skill_storage_location() -> SkillStorageLocation {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .skill_storage_location
}

/// 设置 Skill 存储位置
pub fn set_skill_storage_location(location: SkillStorageLocation) -> Result<(), AppError> {
    mutate_settings(|s| {
        s.skill_storage_location = location;
    })
}

// ===== 备份策略管理函数 =====

/// Get the effective auto-backup interval in hours (default 24)
pub fn effective_backup_interval_hours() -> u32 {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .backup_interval_hours
        .unwrap_or(24)
}

/// Get the effective backup retain count (default 10, minimum 1)
pub fn effective_backup_retain_count() -> usize {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .backup_retain_count
        .map(|n| (n as usize).max(1))
        .unwrap_or(10)
}

// ===== 终端设置管理函数 =====

/// 获取首选终端应用
pub fn get_preferred_terminal() -> Option<String> {
    settings_store()
        .read()
        .unwrap_or_else(|e| {
            log::warn!("设置锁已毒化，使用恢复值: {e}");
            e.into_inner()
        })
        .preferred_terminal
        .clone()
}

// ===== WebDAV 同步设置管理函数 =====

/// 获取 WebDAV 同步设置
pub fn get_webdav_sync_settings() -> Option<WebDavSyncSettings> {
    settings_store().read().ok()?.webdav_sync.clone()
}

/// 保存 WebDAV 同步设置
pub fn set_webdav_sync_settings(settings: Option<WebDavSyncSettings>) -> Result<(), AppError> {
    mutate_settings(|current| {
        current.webdav_sync = settings;
    })
}

/// 仅更新 WebDAV 同步状态，避免覆写 credentials/root/profile 等字段
pub fn update_webdav_sync_status(status: WebDavSyncStatus) -> Result<(), AppError> {
    mutate_settings(|current| {
        if let Some(sync) = current.webdav_sync.as_mut() {
            sync.status = status;
        }
    })
}

// ===== S3 同步设置管理函数 =====

pub fn get_s3_sync_settings() -> Option<S3SyncSettings> {
    settings_store().read().ok()?.s3_sync.clone()
}

pub fn set_s3_sync_settings(settings: Option<S3SyncSettings>) -> Result<(), AppError> {
    mutate_settings(|current| {
        current.s3_sync = settings;
    })
}

pub fn update_s3_sync_status(status: WebDavSyncStatus) -> Result<(), AppError> {
    mutate_settings(|current| {
        if let Some(s3) = current.s3_sync.as_mut() {
            s3.status = status;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::AppType;
    use serial_test::serial;
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;

    struct TestHomeGuard(Option<std::ffi::OsString>);

    impl TestHomeGuard {
        fn set(path: &std::path::Path) -> Self {
            let previous = std::env::var_os("CC_SWITCH_TEST_HOME");
            std::env::set_var("CC_SWITCH_TEST_HOME", path);
            Self(previous)
        }
    }

    impl Drop for TestHomeGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    #[test]
    #[serial]
    fn settings_file_uses_fork_config_dir_without_touching_upstream_file() {
        let home = tempfile::tempdir().expect("temporary home");
        let _guard = TestHomeGuard::set(home.path());
        let upstream_path = home.path().join(".cc-switch/settings.json");
        std::fs::create_dir_all(upstream_path.parent().expect("upstream parent"))
            .expect("create upstream directory");
        std::fs::write(&upstream_path, b"upstream-settings-sentinel")
            .expect("write upstream sentinel");

        assert_eq!(
            AppSettings::settings_path(),
            Some(home.path().join(".cc-switch-remote/settings.json"))
        );
        update_settings(AppSettings::default()).expect("save fork settings");

        assert_eq!(
            std::fs::read(&upstream_path).expect("read upstream sentinel"),
            b"upstream-settings-sentinel"
        );
        assert!(home.path().join(".cc-switch-remote/settings.json").exists());
    }

    #[test]
    #[serial]
    fn settings_lock_and_pointer_follow_config_directory_override() {
        struct ResetOverride;
        impl Drop for ResetOverride {
            fn drop(&mut self) {
                crate::app_store::set_app_config_dir_override_for_cli(None).unwrap();
            }
        }

        let home = tempfile::tempdir().unwrap();
        let _guard = TestHomeGuard::set(home.path());
        let default_path = AppSettings::settings_path().unwrap();
        set_current_provider(&AppType::Claude, Some("default")).unwrap();
        let bytes = fs::read(&default_path).unwrap();
        let custom_dir = home.path().join("alternate");
        crate::app_store::set_app_config_dir_override_for_cli(custom_dir.to_str()).unwrap();
        let _override_guard = ResetOverride;
        assert!(get_current_provider(&AppType::Claude).is_none());
        set_current_provider(&AppType::Claude, Some("alternate")).unwrap();
        assert_eq!(
            get_current_provider(&AppType::Claude).as_deref(),
            Some("alternate")
        );
        assert!(custom_dir.join("settings.json.lock").is_file());
        assert_eq!(fs::read(default_path).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn settings_atomic_write_uses_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        save_settings_file_at_path(&AppSettings::default(), &path, None)
            .expect("atomic settings save");

        assert_eq!(
            std::fs::metadata(&path)
                .expect("settings metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn settings_temp_write_failure_preserves_previous_bytes() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let old = b"previous-settings-bytes";
        std::fs::write(&path, old).expect("seed settings");

        let result = save_settings_file_at_path(
            &AppSettings::default(),
            &path,
            Some(crate::config::AtomicWriteFailure::TempWrite),
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).expect("read settings"), old);
        assert_eq!(std::fs::read_dir(dir.path()).expect("list dir").count(), 1);
    }

    #[test]
    fn settings_rename_failure_preserves_previous_bytes() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let old = b"previous-settings-bytes";
        std::fs::write(&path, old).expect("seed settings");

        let result = save_settings_file_at_path(
            &AppSettings::default(),
            &path,
            Some(crate::config::AtomicWriteFailure::Rename),
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).expect("read settings"), old);
        assert_eq!(std::fs::read_dir(dir.path()).expect("list dir").count(), 1);
    }

    #[test]
    #[serial]
    fn frontend_save_serializes_with_backend_owned_marker_mutation() {
        let home = tempfile::tempdir().expect("temporary home");
        let _guard = TestHomeGuard::set(home.path());
        update_settings(AppSettings::default()).expect("seed settings");

        let start = Arc::new(Barrier::new(2));
        let (finished_tx, finished_rx) = mpsc::channel();
        let backend = std::thread::spawn({
            let start = start.clone();
            move || {
                start.wait();
                mark_codex_provider_template_migrated(CodexProviderTemplateMigration {
                    completed_at: "2026-08-10T00:00:00Z".to_string(),
                    migrated_provider_ids: vec!["backend-marker".to_string()],
                })
                .expect("backend marker mutation");
                finished_tx.send(()).expect("signal backend completion");
            }
        });

        let mut incoming = AppSettings::default();
        incoming.language = Some("zh".to_string());
        save_settings_payload_with_snapshot_barrier(incoming, || {
            start.wait();
            assert!(
                finished_rx.recv_timeout(Duration::from_millis(50)).is_err(),
                "backend mutation must remain blocked until the frontend transaction commits"
            );
        })
        .expect("frontend settings save");
        backend.join().expect("backend thread");

        let final_settings = get_settings();
        assert_eq!(final_settings.language.as_deref(), Some("zh"));
        assert_eq!(
            final_settings
                .local_migrations
                .and_then(|migrations| migrations.codex_provider_template_v1)
                .expect("backend marker survives")
                .migrated_provider_ids,
            vec!["backend-marker"]
        );
    }

    #[test]
    #[serial]
    fn stale_frontend_payload_preserves_latest_backend_sync_state() {
        let home = tempfile::tempdir().expect("temporary home");
        let _guard = TestHomeGuard::set(home.path());
        let mut initial = AppSettings {
            webdav_sync: Some(WebDavSyncSettings {
                base_url: "https://dav.example.com".to_string(),
                username: "alice".to_string(),
                password: "dav-secret".to_string(),
                ..WebDavSyncSettings::default()
            }),
            s3_sync: Some(S3SyncSettings {
                region: "us-test-1".to_string(),
                bucket: "bucket".to_string(),
                access_key_id: "access-key".to_string(),
                secret_access_key: "s3-secret".to_string(),
                ..S3SyncSettings::default()
            }),
            webdav_backup: Some(serde_json::json!({ "legacyEtag": "before" })),
            ..AppSettings::default()
        };
        update_settings(initial.clone()).expect("seed settings");

        // This is exactly the redacted/full object a frontend can keep while a
        // backend sync updates status and legacy backup metadata.
        let mut stale_frontend = get_settings_for_frontend();
        assert!(stale_frontend.webdav_backup.is_none());

        let start = Arc::new(Barrier::new(2));
        let backend = std::thread::spawn({
            let start = start.clone();
            move || {
                start.wait();
                mutate_settings(|current| {
                    current.webdav_sync.as_mut().expect("webdav").status = WebDavSyncStatus {
                        last_sync_at: Some(101),
                        last_remote_etag: Some("dav-etag".to_string()),
                        ..WebDavSyncStatus::default()
                    };
                    current.s3_sync.as_mut().expect("s3").status = WebDavSyncStatus {
                        last_sync_at: Some(202),
                        last_local_manifest_hash: Some("s3-local-hash".to_string()),
                        ..WebDavSyncStatus::default()
                    };
                    current.webdav_backup =
                        Some(serde_json::json!({ "legacyEtag": "backend-latest" }));
                })
                .expect("backend sync mutation");
            }
        });

        start.wait();
        backend.join().expect("backend mutation thread");
        stale_frontend.language = Some("zh".to_string());
        save_settings_payload_with_snapshot_barrier(stale_frontend, || {})
            .expect("save stale frontend payload");

        initial = get_settings();
        assert_eq!(initial.language.as_deref(), Some("zh"));
        assert_eq!(
            initial
                .webdav_sync
                .as_ref()
                .and_then(|sync| sync.status.last_remote_etag.as_deref()),
            Some("dav-etag")
        );
        assert_eq!(
            initial
                .s3_sync
                .as_ref()
                .and_then(|sync| sync.status.last_local_manifest_hash.as_deref()),
            Some("s3-local-hash")
        );
        assert_eq!(
            initial.webdav_backup,
            Some(serde_json::json!({ "legacyEtag": "backend-latest" }))
        );
    }

    #[test]
    #[serial]
    fn pending_codex_history_migration_runner_is_synchronous() {
        let home = tempfile::tempdir().expect("temporary home");
        let _guard = TestHomeGuard::set(home.path());
        let mut settings = AppSettings::default();
        settings.unify_codex_session_history = true;
        settings.unify_codex_migrate_existing = Some(true);
        update_settings(settings).expect("seed pending migration");

        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let task = std::thread::spawn(move || {
            let result = retry_pending_codex_history_migration_with(|| {
                started_tx.send(()).expect("signal migration start");
                release_rx.recv().expect("wait for migration release");
                Ok(())
            });
            finished_tx.send(result).expect("signal migration finish");
        });

        started_rx.recv().expect("migration started");
        assert!(
            finished_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "one-shot helper save must not detach a pending migration"
        );
        release_tx.send(()).expect("release migration");
        assert!(finished_rx.recv().expect("migration result").is_ok());
        task.join().expect("migration task");
    }

    #[test]
    #[serial]
    fn failed_pending_codex_history_migration_remains_retryable() {
        let home = tempfile::tempdir().expect("temporary home");
        let _guard = TestHomeGuard::set(home.path());
        let mut settings = AppSettings::default();
        settings.unify_codex_session_history = true;
        settings.unify_codex_migrate_existing = Some(true);
        update_settings(settings).expect("seed pending migration");

        let failed = retry_pending_codex_history_migration_with(|| {
            Err(AppError::Message("injected migration failure".to_string()))
        });
        assert!(failed.is_err());
        assert!(unify_codex_migrate_existing_requested());

        let attempts = std::sync::atomic::AtomicUsize::new(0);
        assert!(retry_pending_codex_history_migration_with(|| {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .is_ok());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn codex_stack_classic_tools_default_on_and_ignore_the_old_off_key() {
        // v4.0.10–4.0.12 每次保存都写下默认关的旧键：不再读它，升级后按开。
        let old: AppSettings =
            serde_json::from_value(serde_json::json!({ "codexStackClassicSubagents": false }))
                .expect("old settings");
        assert!(old.codex_stack_classic_tools);
        assert!(AppSettings::default().codex_stack_classic_tools);

        let off: AppSettings =
            serde_json::from_value(serde_json::json!({ "codexStackClassicTools": false }))
                .expect("new settings");
        assert!(!off.codex_stack_classic_tools);
        let saved = serde_json::to_value(&off).expect("serialize");
        assert_eq!(saved["codexStackClassicTools"], false);
        assert!(saved.get("codexStackClassicSubagents").is_none());
    }

    #[test]
    fn usage_display_round_trips_and_stays_out_of_old_files() {
        let old: AppSettings = serde_json::from_value(serde_json::json!({})).expect("old settings");
        assert!(old.usage_display.is_none());
        assert!(serde_json::to_value(&old)
            .expect("serialize")
            .get("usageDisplay")
            .is_none());

        let saved: AppSettings = serde_json::from_value(serde_json::json!({
            "usageDisplay": {
                "currency": "CNY",
                "exchangeRates": { "CNY": 6.8 },
                "sidebarTodayItems": ["cost", "requests"],
                "requestLogColumns": { "statusCode": true, "app": false },
                "trendChartType": "area"
            }
        }))
        .expect("usage display");
        let display = saved.usage_display.as_ref().expect("usage display");
        assert_eq!(display.currency.as_deref(), Some("CNY"));
        assert_eq!(display.exchange_rates.get("CNY"), Some(&6.8));
        assert_eq!(
            display.sidebar_today_items.as_deref(),
            Some(&["cost".to_string(), "requests".to_string()][..])
        );
        assert_eq!(display.request_log_columns.get("app"), Some(&false));
        assert_eq!(display.trend_chart_type.as_deref(), Some("area"));
        assert_eq!(
            serde_json::to_value(&saved).expect("serialize")["usageDisplay"],
            serde_json::json!({
                "currency": "CNY",
                "exchangeRates": { "CNY": 6.8 },
                "sidebarTodayItems": ["cost", "requests"],
                "requestLogColumns": { "app": false, "statusCode": true },
                "trendChartType": "area"
            })
        );

        // 侧栏「今日」一项都不勾＝不显示：空列表要原样写回，不能当成没设置
        let hidden: UsageDisplaySettings =
            serde_json::from_value(serde_json::json!({ "sidebarTodayItems": [] }))
                .expect("hidden today label");
        assert_eq!(
            serde_json::to_value(&hidden).expect("serialize"),
            serde_json::json!({ "sidebarTodayItems": [] })
        );
    }

    #[test]
    fn app_order_round_trips_as_camel_case() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({
            "appOrder": ["codex", "claude", "future-app"]
        }))
        .expect("parse settings");
        assert_eq!(
            settings.app_order.as_deref(),
            Some(
                &[
                    "codex".to_string(),
                    "claude".to_string(),
                    "future-app".to_string()
                ][..]
            )
        );
        let value = serde_json::to_value(&settings).expect("serialize settings");
        assert_eq!(
            value["appOrder"],
            serde_json::json!(["codex", "claude", "future-app"])
        );
        let default = serde_json::to_value(AppSettings::default()).expect("serialize default");
        assert!(default.get("appOrder").is_none());
    }

    #[test]
    fn visible_apps_old_settings_default_claude_desktop_visible() {
        let visible: VisibleApps = serde_json::from_value(serde_json::json!({
            "claude": true,
            "codex": true,
            "gemini": true,
            "opencode": true,
            "openclaw": true,
            "hermes": true
        }))
        .expect("visible apps");

        assert!(visible.is_visible(&AppType::ClaudeDesktop));
    }

    #[test]
    fn visible_apps_accepts_claude_desktop_aliases() {
        let visible: VisibleApps = serde_json::from_value(serde_json::json!({
            "claude": true,
            "claudeDesktop": false,
            "codex": true,
            "gemini": true,
            "opencode": true,
            "openclaw": true,
            "hermes": true
        }))
        .expect("visible apps");

        assert!(!visible.is_visible(&AppType::ClaudeDesktop));
    }

    #[test]
    fn settings_save_result_accepts_legacy_boolean_helper_acknowledgement() {
        let result: SettingsSaveResult =
            serde_json::from_value(serde_json::json!(true)).expect("legacy helper result");

        assert!(result.saved);
        assert!(result.warning.is_none());
    }

    #[test]
    fn override_paths_expand_windows_style_tilde_separators() {
        let home = dirs::home_dir().expect("home directory");
        assert_eq!(
            resolve_override_path(r"~\pi\agent"),
            home.join("pi").join("agent")
        );
    }

    #[test]
    fn native_tray_menu_defaults_off_and_keeps_a_saved_menu_choice() {
        assert!(!AppSettings::default().native_tray_menu);
        let missing: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(!missing.native_tray_menu);
        let menu: AppSettings = serde_json::from_str(r#"{"nativeTrayMenu":true}"#).unwrap();
        assert!(menu.native_tray_menu);
    }

    #[test]
    fn lenient_parse_keeps_valid_fields_when_one_is_invalid() {
        let content = serde_json::json!({
            "claudeConfigDir": r"\\wsl$\Ubuntu\home\me\.claude",
            "visibleApps": { "hermes": true, "pi": false },
            "backupIntervalHours": -1,
            "language": "zh"
        })
        .to_string();

        let (settings, lossy) = parse_settings_lenient(&content);
        assert!(lossy);
        assert_eq!(
            settings.claude_config_dir.as_deref(),
            Some(r"\\wsl$\Ubuntu\home\me\.claude")
        );
        let visible = settings.visible_apps.expect("visible apps kept");
        assert!(visible.hermes);
        assert!(!visible.pi);
        assert_eq!(settings.language.as_deref(), Some("zh"));
        assert!(settings.backup_interval_hours.is_none());
    }

    #[test]
    fn lenient_parse_keeps_first_object_when_old_tail_is_left_behind() {
        // #8429：保存较短内容时文件没被截短，合法 JSON 后面跟着旧内容的尾巴。
        let content = format!(
            "{}\n}}\n  \"tail\": true\n}}",
            serde_json::json!({
                "claudeConfigDir": "/tmp/claude",
                "visibleApps": { "claude-desktop": false, "gemini": false }
            })
        );
        assert!(serde_json::from_str::<AppSettings>(&content).is_err());

        let (settings, lossy) = parse_settings_lenient(&content);
        assert!(
            lossy,
            "trailing data still counts as lossy so the file is backed up"
        );
        assert_eq!(settings.claude_config_dir.as_deref(), Some("/tmp/claude"));
        let visible = settings.visible_apps.expect("visible apps kept");
        assert!(!visible.claude_desktop);
        assert!(!visible.gemini);
        assert!(visible.codex);
    }

    #[test]
    fn lenient_parse_strips_utf8_bom_without_losing_anything() {
        let content = format!(
            "\u{feff}{}",
            serde_json::json!({ "claudeConfigDir": "/tmp/claude" })
        );
        let (settings, lossy) = parse_settings_lenient(&content);
        assert!(!lossy);
        assert_eq!(settings.claude_config_dir.as_deref(), Some("/tmp/claude"));
    }

    #[test]
    fn load_reports_missing_file_as_clean_and_garbage_as_lossy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        assert!(!load_settings_from_path(&path).lossy);

        fs::write(&path, "{\"claudeConfigDir\": \"/x\"").expect("write truncated");
        let loaded = load_settings_from_path(&path);
        assert!(loaded.lossy);
        assert!(loaded.settings.claude_config_dir.is_none());
    }

    #[test]
    fn backup_copies_the_original_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::write(&path, "not json").expect("write");
        let dest = backup_settings_file(&path).expect("backup");
        assert_ne!(dest, path);
        assert_eq!(fs::read_to_string(&dest).expect("read backup"), "not json");
    }

    #[test]
    #[serial]
    fn settings_mutations_refuse_corrupt_disk_data_without_changing_cache() {
        let home = tempfile::tempdir().expect("temporary home");
        let _guard = TestHomeGuard::set(home.path());
        let path = AppSettings::settings_path().expect("settings path");
        set_current_provider(&AppType::Claude, Some("cached")).expect("seed settings");
        let original = settings_as_json(&get_settings()).expect("cached settings");

        for corrupt in ["original", r#"{"silentStartup": "true"}"#] {
            fs::write(&path, corrupt).expect("write corrupt fixture");
            assert!(set_current_provider(&AppType::Claude, None).is_err());
            assert!(update_settings(AppSettings::default()).is_err());
            assert_eq!(fs::read_to_string(&path).expect("read settings"), corrupt);
            assert_eq!(settings_as_json(&get_settings()).unwrap(), original);
        }
    }

    #[test]
    fn settings_write_is_refused_when_disk_read_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::create_dir(&path).expect("mkdir");
        assert!(SettingsFile::begin(path.clone()).is_err());
        assert!(path.is_dir());
    }

    #[test]
    #[serial]
    fn settings_failed_atomic_commit_does_not_publish_unwritten_cache() {
        let home = tempfile::tempdir().expect("temporary home");
        let _guard = TestHomeGuard::set(home.path());
        set_current_provider(&AppType::Claude, Some("before")).expect("seed settings");
        let file = SettingsFile::current().expect("settings file");
        let path = file.path.clone();
        let bytes = fs::read(&path).expect("before bytes");
        let mut next = file.settings.clone();
        next.current_provider_claude = Some("after".to_string());
        let result = file.commit_with(next, |path, bytes| {
            crate::config::atomic_write_private_with_failure(
                path,
                bytes,
                crate::config::AtomicWriteFailure::Rename,
            )
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).expect("after bytes"), bytes);
        assert_eq!(
            get_settings().current_provider_claude.as_deref(),
            Some("before")
        );
    }

    #[test]
    fn settings_waits_for_other_writer_before_taking_snapshot() {
        const CHILD_SETTINGS_PATH: &str = "CC_SWITCH_SETTINGS_LOCK_TEST_CHILD";
        if let Some(path) = std::env::var_os(CHILD_SETTINGS_PATH) {
            use std::io::Write;
            let path = PathBuf::from(path);
            let lock = open_settings_lock(&path.with_extension("json.lock")).unwrap();
            assert!(
                !try_lock_settings(&lock).unwrap(),
                "parent must hold the OS lock"
            );
            drop(lock);
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "settings transaction ready").unwrap();
            stdout.flush().unwrap();
            drop(stdout);
            let file = SettingsFile::begin(path).expect("child writer");
            assert!(file.settings.silent_startup);
            let mut next = file.settings.clone();
            next.current_provider_codex = Some("child".to_string());
            file.commit(next).expect("child commit");
            return;
        }

        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("settings.json");
        let first = SettingsFile::begin(path.clone()).expect("first writer");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "settings::tests::settings_waits_for_other_writer_before_taking_snapshot",
                "--nocapture",
            ])
            .env(CHILD_SETTINGS_PATH, &path)
            .env("CC_SWITCH_TEST_HOME", dir.path())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn second writer process");
        let (ready_tx, ready_rx) = mpsc::channel();
        let pipe = child.stdout.take().unwrap();
        let output = std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut captured = String::new();
            while reader.read_line(&mut captured).unwrap() != 0 {
                if captured.contains("settings transaction ready\n") {
                    let _ = ready_tx.send(());
                    break;
                }
            }
            use std::io::Read;
            reader.read_to_string(&mut captured).unwrap();
            captured
        });

        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("child reached lock");
        std::thread::sleep(Duration::from_millis(150));
        assert!(child.try_wait().unwrap().is_none());
        assert!(!path.exists());
        let mut next = first.settings.clone();
        next.silent_startup = true;
        first.commit(next).expect("first commit");
        let status = child.wait().expect("wait for child writer");
        assert!(status.success(), "{}", output.join().unwrap());
        let final_settings = SettingsFile::begin(path).unwrap().settings;
        assert!(final_settings.silent_startup);
        assert_eq!(
            final_settings.current_provider_codex.as_deref(),
            Some("child")
        );
    }

    #[test]
    fn settings_update_keeps_unknown_keys_in_retained_objects() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("settings.json");
        let original = serde_json::json!({
            "currentProviderClaude": "before",
            "futureKey": { "options": [1, 2] },
            "webdavSync": {
                "baseUrl": "https://fixture.invalid",
                "futureSyncKey": "keep",
                "status": { "futureStatusKey": "keep", "lastSyncAt": 100 }
            }
        });
        fs::write(&path, original.to_string()).unwrap();
        let file = SettingsFile::begin(path.clone()).expect("settings file");
        let mut next = file.settings.clone();
        next.current_provider_claude = None;
        next.webdav_sync.as_mut().unwrap().status.last_sync_at = Some(200);
        file.commit(next).expect("commit");

        let actual: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let mut expected = original;
        expected
            .as_object_mut()
            .unwrap()
            .remove("currentProviderClaude");
        expected["webdavSync"]["status"]["lastSyncAt"] = 200.into();
        assert_eq!(actual, expected);
    }

    #[test]
    fn settings_rollback_keeps_newer_changes() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("settings.json");
        let initial = SettingsFile::begin(path.clone()).expect("first writer");
        let before = initial.settings.clone();
        let mut saved = before.clone();
        saved.silent_startup = true;
        saved.language = Some("en".to_string());
        initial.commit(saved.clone()).expect("save setup");

        let concurrent = SettingsFile::begin(path.clone()).expect("second writer");
        let mut next = concurrent.settings.clone();
        next.language = Some("zh".to_string());
        next.current_provider_codex = Some("new".to_string());
        concurrent.commit(next).expect("concurrent save");

        rollback_settings(&path, &saved, &before).expect("rollback");
        let result = SettingsFile::begin(path).unwrap();
        assert!(!result.settings.silent_startup);
        assert_eq!(result.settings.language.as_deref(), Some("zh"));
        assert_eq!(
            result.settings.current_provider_codex.as_deref(),
            Some("new")
        );
    }
}
