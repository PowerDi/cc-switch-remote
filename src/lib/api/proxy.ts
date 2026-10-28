import { invoke } from "@tauri-apps/api/core";
import type {
  RouteSwitchResult,
  ProxyStatus,
  ProxyServerInfo,
  ProxyTakeoverStatus,
  GlobalProxyConfig,
  AppProxyConfig,
  AppRoutingPreflight,
  ProxyStack,
  ProxyStackNotice,
  CodexDaemonRestartOutcome,
  AppModeView,
  StartupAttachFailure,
} from "@/types/proxy";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";
import { remoteApi, type ManagementTarget } from "./remote";

export const proxyApi = {
  // ========== 代理服务器控制 API ==========

  // 启动代理服务器
  async startProxyServer(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ProxyServerInfo> {
    if (target.type === "remote") {
      return remoteApi.startRoutingRuntime(target.profile, target.secret);
    }
    return invoke("start_proxy_server");
  },

  // 停止代理服务器（不恢复已接管配置）
  async stopProxyServer(): Promise<void> {
    return invoke("stop_proxy_server");
  },

  // 停止代理服务器并恢复配置
  async stopProxyWithRestore(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<void> {
    if (target.type === "remote") {
      await remoteApi.stopRoutingRuntime(target.profile, target.secret);
      return;
    }
    return invoke("stop_proxy_with_restore");
  },

  // 获取代理服务器状态
  async getProxyStatus(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ProxyStatus> {
    if (target.type === "remote") {
      return remoteApi.getRoutingRuntimeStatus(target.profile, target.secret);
    }
    return invoke("get_proxy_status");
  },

  // ========== 接管状态 API ==========

  // 获取各应用接管状态
  async getProxyTakeoverStatus(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ProxyTakeoverStatus> {
    if (target.type === "remote") {
      return remoteApi.getProxyTakeoverStatus(target.profile, target.secret);
    }
    return invoke("get_proxy_takeover_status");
  },

  // 为指定应用进入/退出代理模式。stack 为真时进入的是 Stack 模式（和路由模式二选一）；
  // route 是确认框里选的路由目标（Stack 模式下是默认那家），不传沿用上次的路由
  async setProxyTakeoverForApp(
    appType: string,
    enabled: boolean,
    stack = false,
    route?: string | null,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<void> {
    if (target.type === "remote") {
      return remoteApi.setAppMode(
        target.profile,
        appType,
        enabled,
        stack,
        route,
        target.secret,
      );
    }
    return invoke("set_proxy_takeover_for_app", {
      appType,
      enabled,
      stack,
      route: route ?? null,
    });
  },

  // 指定路由目标（聚合模式下是默认那家）：直连时只记下来、下次进入路由 / 聚合模式时用它，
  // 已经在路由 / 聚合模式时当场生效
  async setProxyRoute(
    appType: string,
    providerId: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<RouteSwitchResult> {
    if (target.type === "remote") {
      return remoteApi.setAppRoute(
        target.profile,
        appType,
        providerId,
        target.secret,
      );
    }
    return invoke("set_proxy_route", { appType, providerId });
  },

  // 应用页模式行：生效的模式、路由目标（直连时是上次路由的那家）、直连那家
  async getAppMode(
    appType: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<AppModeView> {
    if (target.type === "remote") {
      return remoteApi.getAppMode(target.profile, appType, target.secret);
    }
    return invoke("get_app_mode", { appType });
  },

  // 启动时没能接上代理、已退回直连的应用（取一次就清空）
  async takeStartupAttachFailures(): Promise<StartupAttachFailure[]> {
    return invoke("take_startup_attach_failures");
  },

  // 设置里在路由和 Stack 之间换时：处于另一种模式（stack 为真是 Stack 模式）的 Claude Code、
  // Codex 先退回直连。返回退回直连的应用
  async exitProxyAppsInMode(
    stack: boolean,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<string[]> {
    if (target.type === "remote") {
      return remoteApi.exitProxyAppsInMode(
        target.profile,
        stack,
        target.secret,
      );
    }
    return invoke("exit_proxy_apps_in_mode", { stack });
  },

  // 直连供应商：路由模式下退出路由时写回的那家（和路由到的那家互相独立）
  async getDirectProvider(
    appType: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<string | null> {
    if (target.type === "remote") {
      return remoteApi.getDirectProvider(
        target.profile,
        appType,
        target.secret,
      );
    }
    return invoke("get_direct_provider", { appType });
  },

  // ========== Stack 模型 API ==========

  // Stack 模型名单：每一家和它发布的模型 id，以及提示
  async getProxyStack(
    appType: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ProxyStack> {
    if (target.type === "remote") {
      return remoteApi.getProxyStack(target.profile, appType, target.secret);
    }
    return invoke("get_proxy_stack", { appType });
  },

  // 把一家加入或移出 Stack 模型（enabled 是目标值）。成功时返回客户端看不到或看不全 Stack 模型
  // 的提示；失败时抛出 ProxyStackWriteError
  async setProxyStackMember(
    appType: string,
    providerId: string,
    enabled: boolean,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ProxyStackNotice | null> {
    if (target.type === "remote") {
      return remoteApi.setProxyStackMember(
        target.profile,
        appType,
        providerId,
        enabled,
        target.secret,
      );
    }
    return invoke("set_proxy_stack_member", { appType, providerId, enabled });
  },

  // Codex 聚合的模型被别的模型目录挡住时，改用 CC Switch 生成的目录（去掉指向别的文件的
  // model_catalog_json）。返回之后还剩的提示
  async adoptCodexStackCatalog(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ProxyStackNotice | null> {
    if (target.type === "remote") {
      return remoteApi.adoptCodexStackCatalog(target.profile, target.secret);
    }
    return invoke("adopt_codex_stack_catalog");
  },

  // 重启 Codex 的托管守护进程（codex 命令行连的那个），让它重读模型目录。会中断正在运行的
  // 任务，只在用户确认之后调
  async restartCodexAppServerDaemon(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<CodexDaemonRestartOutcome> {
    if (target.type === "remote") {
      return remoteApi.restartCodexAppServerDaemon(
        target.profile,
        target.secret,
      );
    }
    return invoke("restart_codex_app_server_daemon");
  },

  // 关掉看不到进程时出的「Codex 可能还在用旧的」提示：后端记下现在的模型目录和登录，同一份
  // 不再提示
  async acknowledgeCodexStaleClients(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<void> {
    if (target.type === "remote")
      throw new Error("REMOTE_HELPER_UPGRADE_REQUIRED: codex-stale-clients");
    return invoke("acknowledge_codex_stale_clients");
  },

  // ========== v3+ 全局/应用级配置 API ==========

  // 获取全局代理配置
  async getGlobalProxyConfig(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<GlobalProxyConfig> {
    if (target.type === "remote") {
      return remoteApi.getRoutingGlobalConfig(target.profile, target.secret);
    }
    return invoke("get_global_proxy_config");
  },

  // 更新全局代理配置
  async updateGlobalProxyConfig(
    config: GlobalProxyConfig,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<void> {
    if (target.type === "remote") {
      return remoteApi.updateRoutingGlobalConfig(
        target.profile,
        config,
        target.secret,
      );
    }
    return invoke("update_global_proxy_config", { config });
  },

  // 获取客户端地址（写给客户端的代理主机，空表示按监听地址推）
  async getProxyClientHost(
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<string> {
    if (target.type === "remote")
      throw new Error("REMOTE_HELPER_UPGRADE_REQUIRED: routing-client-host");
    return invoke("get_proxy_client_host");
  },

  // 保存客户端地址，并按新地址重写接上路由的客户端
  async setProxyClientHost(
    host: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<void> {
    if (target.type === "remote")
      throw new Error("REMOTE_HELPER_UPGRADE_REQUIRED: routing-client-host");
    return invoke("set_proxy_client_host", { host });
  },

  // 获取指定应用的代理配置
  async getProxyConfigForApp(
    appType: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<AppProxyConfig> {
    if (target.type === "remote") {
      return remoteApi.getRoutingAppConfig(
        target.profile,
        appType,
        target.secret,
      );
    }
    return invoke("get_proxy_config_for_app", { appType });
  },

  async preflightRoutingApp(
    appType: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<AppRoutingPreflight> {
    if (target.type === "remote") {
      return remoteApi.preflightRoutingApp(
        target.profile,
        appType,
        target.secret,
      );
    }
    return { appType, canEnable: true, reason: null };
  },

  // 更新指定应用的代理配置
  async updateProxyConfigForApp(
    config: AppProxyConfig,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<void> {
    if (target.type === "remote") {
      return remoteApi.updateRoutingAppConfig(
        target.profile,
        config,
        target.secret,
      );
    }
    return invoke("update_proxy_config_for_app", { config });
  },

  // ========== 计费默认配置 API ==========

  // v4 取消了应用级默认成本倍率（改由供应商级倍率，见 PricingConfigPanel）。
  // helper 仍对旧桌面的请求显式拒绝，而这里不再暴露方法，避免前端出现一个必然失败的控制。

  async getPricingModelSource(
    appType: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<string> {
    if (target.type === "remote") {
      return remoteApi.getPricingModelSource(
        target.profile,
        appType,
        target.secret,
      );
    }
    return invoke("get_pricing_model_source", { appType });
  },

  // 设置计费模式来源
  async setPricingModelSource(
    appType: string,
    value: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<void> {
    if (target.type === "remote") {
      return remoteApi.setPricingModelSource(
        target.profile,
        appType,
        value,
        target.secret,
      );
    }
    return invoke("set_pricing_model_source", { appType, value });
  },
};
