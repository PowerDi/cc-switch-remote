//! 故障转移切换模块
//!
//! 处理故障转移成功后的供应商切换逻辑，包括：
//! - 去重控制（避免多个请求同时触发）
//! - 托盘菜单更新
//! - 前端事件发射

use crate::database::Database;
use crate::error::AppError;
use crate::proxy::{
    providers::codex_oauth_auth::CodexOAuthManager, switch_lock::SwitchLockManager, ProxyAppHandle,
};
use std::collections::HashSet;
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

/// 故障转移切换管理器
///
/// 负责处理故障转移成功后的供应商切换，确保 UI 能够直观反映当前使用的供应商。
#[derive(Clone)]
pub struct FailoverSwitchManager {
    /// 正在处理中的切换（key = "app_type:provider_id"）
    pending_switches: Arc<RwLock<HashSet<String>>>,
    #[cfg(not(feature = "desktop"))]
    db: Arc<Database>,
    #[cfg(not(feature = "desktop"))]
    codex_oauth_manager: Arc<CodexOAuthManager>,
    #[cfg(not(feature = "desktop"))]
    switch_locks: SwitchLockManager,
}

impl FailoverSwitchManager {
    pub fn new(db: Arc<Database>) -> Self {
        Self::new_with_dependencies(
            db,
            Arc::new(CodexOAuthManager::new(crate::config::get_app_config_dir())),
            SwitchLockManager::new(),
        )
    }

    pub fn new_with_dependencies(
        db: Arc<Database>,
        codex_oauth_manager: Arc<CodexOAuthManager>,
        switch_locks: SwitchLockManager,
    ) -> Self {
        #[cfg(feature = "desktop")]
        let _ = (&db, &codex_oauth_manager, &switch_locks);

        Self {
            pending_switches: Arc::new(RwLock::new(HashSet::new())),
            #[cfg(not(feature = "desktop"))]
            db,
            #[cfg(not(feature = "desktop"))]
            codex_oauth_manager,
            #[cfg(not(feature = "desktop"))]
            switch_locks,
        }
    }

    /// 尝试执行故障转移切换
    ///
    /// 如果相同的切换已在进行中，则跳过；否则执行切换逻辑。
    ///
    /// # Returns
    /// - `Ok(true)` - 切换成功执行
    /// - `Ok(false)` - 切换已在进行中，跳过
    /// - `Err(e)` - 切换过程中发生错误
    pub async fn try_switch(
        &self,
        app_handle: Option<&ProxyAppHandle>,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
    ) -> Result<bool, AppError> {
        let switch_key = format!("{app_type}:{provider_id}");

        // 去重检查：如果相同切换已在进行中，跳过
        {
            let mut pending = self.pending_switches.write().await;
            if pending.contains(&switch_key) {
                log::debug!("[Failover] 切换已在进行中，跳过: {app_type} -> {provider_id}");
                return Ok(false);
            }
            pending.insert(switch_key.clone());
        }

        // 执行切换（确保最后清理 pending 标记）
        let result = self
            .do_switch(app_handle, app_type, provider_id, provider_name)
            .await;

        // 清理 pending 标记
        {
            let mut pending = self.pending_switches.write().await;
            pending.remove(&switch_key);
        }

        result
    }

    async fn do_switch(
        &self,
        app_handle: Option<&ProxyAppHandle>,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
    ) -> Result<bool, AppError> {
        // 只有处于代理模式的应用才允许执行故障转移切换
        let Ok(app_enum) = app_type.parse::<crate::app_config::AppType>() else {
            return Ok(false);
        };
        if !crate::mode::current::is_proxy(&app_enum) {
            log::debug!("[Failover] {app_type} 不在路由模式，跳过切换");
            return Ok(false);
        }

        log::info!("[FO-001] 切换: {app_type} → {provider_name}");

        let mut switched = false;

        #[cfg(feature = "desktop")]
        {
            if let Some(app) = app_handle {
                if let Some(app_state) = app.try_state::<crate::store::AppState>() {
                    switched = crate::mode::controller::record_failover_route(
                        app_state.inner(),
                        &app_enum,
                        provider_id,
                    )
                    .await
                    .map_err(AppError::Message)?;

                    if !switched {
                        return Ok(false);
                    }

                    if let Ok(new_menu) = crate::tray::create_tray_menu(app, app_state.inner()) {
                        if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
                            if let Err(e) = tray.set_menu(Some(new_menu)) {
                                log::error!("[Failover] 更新托盘菜单失败: {e}");
                            }
                        }
                    }
                }

                // 发射事件到前端
                let event_data = serde_json::json!({
                    "appType": app_type,
                    "providerId": provider_id,
                    "source": "failover"  // 标识来源是故障转移
                });
                if let Err(e) = app.emit("provider-switched", event_data) {
                    log::error!("[Failover] 发射事件失败: {e}");
                }
            }
        }

        #[cfg(not(feature = "desktop"))]
        {
            let _ = app_handle;
            let proxy_service =
                crate::services::ProxyService::new_with_codex_oauth_manager_and_switch_locks(
                    self.db.clone(),
                    self.codex_oauth_manager.clone(),
                    self.switch_locks.clone(),
                );
            let state = crate::store::AppState {
                db: self.db.clone(),
                proxy_service,
                usage_cache: Arc::new(crate::services::UsageCache::new()),
                codex_oauth_manager: self.codex_oauth_manager.clone(),
            };
            // Shared controller preserves the direct pointer and ignores stale
            // failover completions after entering aggregation mode.
            switched =
                crate::mode::controller::record_failover_route(&state, &app_enum, provider_id)
                    .await
                    .map_err(AppError::Message)?;

            if !switched {
                return Ok(false);
            }
        }

        Ok(switched)
    }
}
