import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { proxyApi } from "@/lib/api/proxy";
import { toast } from "@/lib/toast";
import { useTranslation } from "react-i18next";
import type {
  AppModeView,
  GlobalProxyConfig,
  AppProxyConfig,
  ProxyStackWriteError,
  ProxyTakeoverStatus,
} from "@/types/proxy";
import type { ManagementTarget } from "@/lib/api/remote";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import { extractErrorMessage } from "@/utils/errorUtils";
import { getAppLabel } from "@/config/appConfig";

export const proxyKeys = {
  status: (target: ManagementTarget = LOCAL_MANAGEMENT_TARGET) =>
    ["proxyStatus", getManagementTargetKey(target)] as const,
  takeoverStatus: (target: ManagementTarget = LOCAL_MANAGEMENT_TARGET) =>
    ["proxyTakeoverStatus", getManagementTargetKey(target)] as const,
  globalConfig: (target: ManagementTarget = LOCAL_MANAGEMENT_TARGET) =>
    ["globalProxyConfig", getManagementTargetKey(target)] as const,
  appConfig: (
    appType: string,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ) => ["appProxyConfig", getManagementTargetKey(target), appType] as const,
};

// ========== 代理服务器状态 Hooks ==========

/**
 * 获取代理服务器状态
 */
export function useProxyStatusQuery(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  return useQuery({
    queryKey: proxyKeys.status(target),
    queryFn: () => proxyApi.getProxyStatus(target),
    // 仅在服务运行时轮询
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
    // 保持之前的数据，避免闪烁
    placeholderData: (previousData) => previousData,
  });
}

/**
 * 获取各应用接管状态
 */
export function useProxyTakeoverStatus(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  poll = true,
) {
  return useQuery({
    queryKey: proxyKeys.takeoverStatus(target),
    queryFn: () => proxyApi.getProxyTakeoverStatus(target),
    enabled: true,
    refetchInterval: poll ? 2000 : false,
    ...(poll
      ? {}
      : {
          placeholderData: (previousData: ProxyTakeoverStatus | undefined) =>
            previousData,
        }),
  });
}

/**
 * 应用的模式状态（直连 / 路由 / 聚合、路由目标、直连那家）。放在 ["providers", appId] 前缀下：
 * 进出模式、切换供应商时随供应商列表一起失效。
 */
export function useAppMode(
  appType: string,
  enabled = true,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  return useQuery({
    queryKey: [
      "providers",
      appType,
      getManagementTargetKey(target),
      "mode",
    ] as const,
    queryFn: () => proxyApi.getAppMode(appType, target),
    enabled,
    placeholderData: (previous: AppModeView | undefined) => previous,
  });
}

/**
 * 直连供应商（路由模式下退出路由时写回的那家）。
 * 放在 ["providers", appId] 前缀下：切换、编辑供应商时随供应商列表一起失效。
 */
export function useDirectProviderId(
  appType: string,
  enabled: boolean,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  return useQuery({
    queryKey: [
      "providers",
      appType,
      getManagementTargetKey(target),
      "direct",
    ] as const,
    queryFn: () => proxyApi.getDirectProvider(appType, target),
    enabled,
  });
}

/**
 * Stack 模型名单。放在 ["providers", appId] 前缀下：编辑、删除供应商时随列表一起失效。
 */
export function useProxyStack(
  appType: string,
  enabled: boolean,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  return useQuery({
    queryKey: [
      "providers",
      appType,
      getManagementTargetKey(target),
      "stack",
    ] as const,
    queryFn: () => proxyApi.getProxyStack(appType, target),
    enabled,
  });
}

function isStackWriteError(error: unknown): error is ProxyStackWriteError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as ProxyStackWriteError).partial === "boolean"
  );
}

/**
 * 把一家加入或移出 Stack 模型。Claude Code 运行中就会读到改过的 settings.json，Codex 只在
 * 启动时读模型目录，成功后提示重启。失败分两种：
 * 什么都没改（弹后端的错误），已部分写入（下次操作或重启 CC Switch 时补完）。两种都按
 * 后端的状态重新显示，不在前端假设名单不变。
 */
export function useSetProxyStackMember(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: ({
      appType,
      providerId,
      enabled,
    }: {
      appType: string;
      providerId: string;
      enabled: boolean;
    }) => proxyApi.setProxyStackMember(appType, providerId, enabled, target),
    onSuccess: (notice, variables) => {
      toast.success(
        t(
          variables.appType === "codex"
            ? "provider.stackSaved"
            : "provider.stackSavedLive",
          { client: getAppLabel(variables.appType) },
        ),
        {
          description: variables.enabled
            ? t("provider.stackReselectHint")
            : undefined,
          closeButton: true,
        },
      );
      if (notice) {
        toast.warning(t(`provider.${notice}`), { closeButton: true });
      }
    },
    onError: (error: unknown) => {
      if (isStackWriteError(error) && error.partial) {
        toast.warning(t("provider.stackPartial"), {
          description: error.message,
          closeButton: true,
        });
        return;
      }
      toast.error(
        t("provider.stackFailed", { error: extractErrorMessage(error) }),
      );
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["providers", variables.appType],
      });
    },
  });
}

/**
 * Codex 聚合的模型被路由供应商自己的模型目录挡住（routeOwnsCatalog）时，改用 CC Switch
 * 生成的目录。客户端只在启动时读模型目录，成功后提示重启；还剩别的提示照样弹出。
 */
export function useAdoptCodexStackCatalog(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: () => proxyApi.adoptCodexStackCatalog(target),
    onSuccess: (notice) => {
      toast.success(t("provider.adoptCatalogDone"), { closeButton: true });
      if (notice) {
        toast.warning(t(`provider.${notice}`), { closeButton: true });
      }
    },
    onError: (error: unknown) => {
      toast.error(
        t("provider.adoptCatalogFailed", {
          error: extractErrorMessage(error),
        }),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    },
  });
}

/**
 * 重启 Codex 的托管守护进程，让它重读模型目录。结束后重新查 Stack 名单：重启成功时
 * 「还在用旧模型列表」的提示随之消失。
 */
export function useRestartCodexAppServerDaemon(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: () => proxyApi.restartCodexAppServerDaemon(target),
    onSuccess: (outcome) => {
      if (outcome === "notRunning") {
        toast.info(t("proxy.stackMode.codexStale.notRunning"), {
          closeButton: true,
        });
        return;
      }
      toast.success(t("proxy.stackMode.codexStale.restarted"), {
        closeButton: true,
      });
    },
    onError: (error: unknown) => {
      toast.error(
        t("proxy.stackMode.codexStale.failed", {
          error: extractErrorMessage(error),
        }),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    },
  });
}

// ========== 代理服务器控制 Hooks ==========

/**
 * 设置应用接管状态
 */
export function useSetProxyTakeoverForApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      appType,
      enabled,
      stack = false,
    }: {
      appType: string;
      enabled: boolean;
      stack?: boolean;
    }) => proxyApi.setProxyTakeoverForApp(appType, enabled, stack),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: proxyKeys.takeoverStatus(),
      });
      // 进出路由模式会改「当前」显示的供应商（路由模式下是路由到的那家）。
      queryClient.invalidateQueries({
        queryKey: ["providers", variables.appType],
      });
    },
  });
}

// ========== v3+ 全局/应用级配置 Hooks ==========

/**
 * 获取全局代理配置
 */
export function useGlobalProxyConfig(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  return useQuery({
    queryKey: proxyKeys.globalConfig(target),
    queryFn: () => proxyApi.getGlobalProxyConfig(target),
  });
}

/**
 * 更新全局代理配置
 */
export function useUpdateGlobalProxyConfig(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (config: GlobalProxyConfig) =>
      proxyApi.updateGlobalProxyConfig(config, target),
    onSuccess: () => {
      toast.success(t("proxy.settings.toast.saved"), { closeButton: true });
      queryClient.invalidateQueries({
        queryKey: proxyKeys.globalConfig(target),
      });
      queryClient.invalidateQueries({
        queryKey: proxyKeys.status(target),
      });
      if (target.type === "local") {
        queryClient.invalidateQueries({ queryKey: ["proxyConfig"] });
        queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
      }
    },
    onError: (error: Error) => {
      toast.error(
        t("proxy.settings.toast.saveFailed", { error: error.message }),
      );
    },
  });
}

/**
 * 获取指定应用的代理配置
 */
export function useAppProxyConfig(
  appType: string,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  enabled = true,
) {
  return useQuery({
    queryKey: proxyKeys.appConfig(appType, target),
    queryFn: () => proxyApi.getProxyConfigForApp(appType, target),
    enabled: enabled && !!appType,
  });
}

/**
 * 获取指定应用启用远程路由的前置条件
 */
export function useRoutingAppPreflight(
  appType: string,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  enabled = true,
) {
  const targetKey = getManagementTargetKey(target);
  return useQuery({
    queryKey: ["routingAppPreflight", targetKey, appType],
    queryFn: () => proxyApi.preflightRoutingApp(appType, target),
    enabled: enabled && !!appType,
    staleTime: target.type === "remote" ? 10_000 : Infinity,
  });
}

/**
 * 更新指定应用的代理配置
 */
export function useUpdateAppProxyConfig(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const targetKey = getManagementTargetKey(target);

  return useMutation({
    mutationFn: (config: AppProxyConfig) =>
      proxyApi.updateProxyConfigForApp(config, target),
    onSuccess: (_, variables) => {
      toast.success(t("proxy.settings.toast.saved"), { closeButton: true });
      queryClient.invalidateQueries({
        queryKey: proxyKeys.appConfig(variables.appType, target),
      });
      queryClient.invalidateQueries({
        queryKey: ["routingAppPreflight", targetKey, variables.appType],
      });
      queryClient.invalidateQueries({
        queryKey: proxyKeys.status(target),
      });
      queryClient.invalidateQueries({
        queryKey: ["autoFailoverEnabled", targetKey, variables.appType],
      });
      if (target.type === "local") {
        queryClient.invalidateQueries({
          queryKey: ["autoFailoverEnabled", variables.appType],
        });
        queryClient.invalidateQueries({ queryKey: ["proxyConfig"] });
        queryClient.invalidateQueries({ queryKey: ["circuitBreakerConfig"] });
        queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
      }
    },
    onError: (error: Error) => {
      toast.error(
        t("proxy.settings.toast.saveFailed", { error: error.message }),
      );
    },
  });
}
