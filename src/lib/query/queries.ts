import { useRef } from "react";
import { resolveDisplayUsage, type LastGoodUsage } from "./keepLastGood";
export * from "./keepLastGood";
import {
  useQuery,
  type UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  providersApi,
  settingsApi,
  usageApi,
  sessionsApi,
  type AppId,
  type ManagementTarget,
} from "@/lib/api";
import type { Provider, Settings, UsageResult, SessionMeta } from "@/types";
import { usageScriptResultKey } from "@/lib/query/usage";
import {
  extractErrorMessage,
  isRemotePasswordRequiredError,
} from "@/utils/errorUtils";

const targetKey = (target: ManagementTarget) =>
  target.type === "remote" ? `remote:${target.profile.id}` : "local";

const sortProviders = (
  providers: Record<string, Provider>,
): Record<string, Provider> => {
  const sortedEntries = Object.values(providers)
    .sort((a, b) => {
      const indexA = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
      const indexB = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
      if (indexA !== indexB) {
        return indexA - indexB;
      }

      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      if (timeA === timeB) {
        return a.name.localeCompare(b.name, "zh-CN");
      }
      return timeA - timeB;
    })
    .map((provider) => [provider.id, provider] as const);

  return Object.fromEntries(sortedEntries);
};

export interface ProvidersQueryData {
  providers: Record<string, Provider>;
  currentProviderId: string;
}

interface ProviderQueryReaders {
  getState?: typeof providersApi.getState;
  getAll: typeof providersApi.getAll;
  getCurrent: typeof providersApi.getCurrent;
}

export async function loadProvidersQueryData(
  appId: AppId,
  target: ManagementTarget,
  readers: ProviderQueryReaders = providersApi,
): Promise<ProvidersQueryData> {
  let providers: Record<string, Provider> = {};
  let currentProviderId = "";

  if (target.type === "remote" && readers.getState) {
    const state = await readers.getState(appId, target);
    return {
      providers: sortProviders(state.providers),
      currentProviderId: state.currentProviderId,
    };
  }

  try {
    providers = await readers.getAll(appId, target);
  } catch (error) {
    if (target.type === "remote") {
      throw error;
    }
    console.error("获取供应商列表失败:", error);
  }

  try {
    currentProviderId = await readers.getCurrent(appId, target);
  } catch (error) {
    if (target.type === "remote") {
      throw error;
    }
    console.error("获取当前供应商失败:", error);
  }

  return {
    providers: sortProviders(providers),
    currentProviderId,
  };
}

export interface UseProvidersQueryOptions {
  enabled?: boolean;
  isProxyRunning?: boolean; // 代理服务是否运行中
  target?: ManagementTarget;
}

/**
 * 供应商列表的查询键与读取函数。App 启动后用它把其他应用的列表预取进缓存，
 * 第一次切过去时直接有数据，不用先画骨架。
 */
export const providersQueryOptions = (
  appId: AppId,
  target: ManagementTarget = { type: "local" },
) => ({
  queryKey: ["providers", appId, targetKey(target)] as const,
  // 列表很小：没人订阅时也一直留在缓存里，过了默认的 5 分钟再切过去也不画骨架
  gcTime: Infinity,
  queryFn: async (): Promise<ProvidersQueryData> =>
    loadProvidersQueryData(appId, target),
});

export const useProvidersQuery = (
  appId: AppId,
  options?: UseProvidersQueryOptions,
): UseQueryResult<ProvidersQueryData> => {
  const {
    enabled = true,
    isProxyRunning = false,
    target = { type: "local" },
  } = options || {};

  return useQuery({
    ...providersQueryOptions(appId, target),
    enabled,
    // Remote targets are separate machines. Showing the previous target while
    // the next one loads leaves stale provider cards actionable against the
    // newly selected connection. Keep upstream's smooth local refresh only.
    placeholderData: target.type === "local" ? keepPreviousData : undefined,
    staleTime: target.type === "remote" ? 30_000 : 0,
    refetchOnWindowFocus: target.type === "local",
    // 当代理服务运行时，每 10 秒刷新一次供应商列表
    // 这样可以自动反映后端熔断器自动禁用代理目标的变更
    refetchInterval:
      enabled && target.type === "local" && isProxyRunning ? 10000 : false,
    retry: (failureCount, error) => {
      if (target.type === "remote" && isRemotePasswordRequiredError(error)) {
        return false;
      }
      return failureCount < 1;
    },
  });
};

export const useSettingsQuery = (): UseQueryResult<Settings> => {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => settingsApi.get(),
  });
};

export interface UseUsageQueryOptions {
  enabled?: boolean;
  autoQueryInterval?: number; // 自动查询间隔（分钟），0 表示禁用
  target?: ManagementTarget;
}

export const useUsageQuery = (
  providerId: string,
  appId: AppId,
  options?: UseUsageQueryOptions,
) => {
  const {
    enabled = true,
    autoQueryInterval = 0,
    target = { type: "local" },
  } = options || {};

  // 计算 staleTime：如果有自动刷新间隔，使用该间隔；否则默认 5 分钟
  // 这样可以避免切换 app 页面时重复触发查询
  const staleTime =
    autoQueryInterval > 0
      ? autoQueryInterval * 60 * 1000 // 与刷新间隔保持一致
      : 5 * 60 * 1000; // 默认 5 分钟

  const query = useQuery<UsageResult>({
    queryKey: usageScriptResultKey(providerId, appId, target),
    queryFn: async () => usageApi.query(providerId, appId, target),
    enabled: enabled && !!providerId,
    refetchInterval:
      autoQueryInterval > 0
        ? Math.max(autoQueryInterval, 1) * 60 * 1000 // 最小1分钟
        : false,
    refetchIntervalInBackground: true, // 后台也继续定时查询
    refetchOnWindowFocus: false,
    // 用量查询面向跨境/第三方端点，单次网络抖动或瞬时 5xx 不应直接判失败。
    // 后端已把瞬时传输失败（网络/超时/读体中断）转成 Err → invoke reject，
    // retry 在此真正生效；reject 保留的旧 data 与 Ok(success:false) 的 5xx/429
    // 一样，只在 resolveDisplayUsage 的 keep-last-good 窗口内继续展示。
    retry: 1,
    retryDelay: 1500,
    staleTime, // 使用动态计算的缓存时间
    gcTime: 10 * 60 * 1000, // 缓存保留 10 分钟（组件卸载后）
  });

  // Keep-last-good：失败时在 10 分钟窗口内继续展示上一次成功值（见 resolveDisplayUsage）。
  // 每个 hook 实例各持一份 ref（按卡片维度）；ref 写入是幂等的（同份成功重复写无副作用）。
  const lastGoodRef = useRef<LastGoodUsage | null>(null);
  const { data, lastQueriedAt, lastGood } = resolveDisplayUsage(
    query.data,
    query.dataUpdatedAt,
    lastGoodRef.current,
    Date.now(),
    { rejected: query.isError },
  );
  lastGoodRef.current = lastGood;

  return {
    ...query,
    // reject 且无可展示值（首次查询即失败，或保留的旧成功已超窗）：合成失败占位，
    // 让 footer/卡片渲染失败态 + 重试入口，并透出 reject 的错误文案。
    data:
      data ??
      (query.isError
        ? {
            success: false,
            error: extractErrorMessage(query.error) || undefined,
          }
        : undefined),
    lastQueriedAt,
  };
};

export const useSessionsQuery = (
  target: ManagementTarget = { type: "local" },
) => {
  return useQuery<SessionMeta[]>({
    queryKey: ["sessions", targetKey(target)],
    queryFn: async () => sessionsApi.list(target),
    staleTime: 30 * 1000,
  });
};

// 会话消息查询在 ./sessions（阅读页数据层）实现，带管理目标参数；这里转发给旧调用方
// （会活的会话钩子、会话管理页复制等）。
export { useSessionMessagesQuery } from "./sessions";
