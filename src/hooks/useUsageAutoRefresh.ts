import { useCallback, useEffect, useRef } from "react";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import { usageApi } from "@/lib/api/usage";
import { usageKeys } from "@/lib/query/usage";
import type { SessionSyncResult } from "@/types/usage";

import type { ManagementTarget } from "@/lib/api/remote";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
interface UsageAutoRefreshOptions {
  target?: ManagementTarget;
  enabled?: boolean;
  refreshIntervalMs: number;
  sessionAutoSyncEnabled: boolean;
  paused?: boolean;
  /** 时间范围随「现在」移动（今天、最近 24 小时等） */
  rollingRange?: boolean;
}

/** 随时间移动的范围多久重算一次：跨过午夜、滚动窗口移出旧记录都靠它 */
const ROLLING_RANGE_REFRESH_MS = 60_000;

/**
 * 用量页打开期间按所选间隔扫描会话日志：打开即扫一次，之后每隔一段扫一次，
 * 窗口隐藏时停、重新显示时立刻补扫。后台只有 10 分钟一次的兜底扫描。
 * 导入新用量后后端会发 `usage-log-recorded`，统计由 useUsageEventBridge 刷新；
 * 这里每轮只刷新「上次同步」时间，没有新数据时不重读整页。
 * 范围随时间移动时另有每分钟一次的重查，否则没有新用量时跨过午夜「今天」还停在昨天。
 */
export function useUsageAutoRefresh({
  refreshIntervalMs,
  sessionAutoSyncEnabled,
  paused = false,
  rollingRange = false,
  target = LOCAL_MANAGEMENT_TARGET,
  enabled = true,
}: UsageAutoRefreshOptions) {
  const queryClient = useQueryClient();
  const targetKey = getManagementTargetKey(target);
  const pendingSync = useRef<{
    targetKey: string;
    promise: Promise<SessionSyncResult>;
  } | null>(null);

  // 手动同步复用尚未完成的静默扫描；慢扫描不会在后端互斥锁前排队累积。
  const syncSessionUsage = useCallback(() => {
    if (!enabled)
      return Promise.reject(
        new Error("Session usage sync is unavailable for this target"),
      );
    if (!pendingSync.current || pendingSync.current.targetKey !== targetKey) {
      const promise = usageApi.syncSessionUsage(target).finally(() => {
        if (pendingSync.current?.promise === promise)
          pendingSync.current = null;
      });
      pendingSync.current = { targetKey, promise };
    }
    return pendingSync.current.promise;
  }, [enabled, target, targetKey]);

  useEffect(() => {
    if (!enabled || !sessionAutoSyncEnabled || refreshIntervalMs <= 0 || paused)
      return;
    let disposed = false;

    const scan = async () => {
      if (
        !focusManager.isFocused() ||
        pendingSync.current?.targetKey === targetKey
      )
        return;
      try {
        const result = await syncSessionUsage();
        if (result.errors.length > 0) {
          console.warn(
            "[UsageDashboard] Session auto-sync errors",
            result.errors,
          );
        }
      } catch (error) {
        // 静默扫描失败不弹提示，下一轮继续重试
        console.warn("[UsageDashboard] Session auto-sync failed", error);
      }
      if (!disposed) {
        await queryClient.invalidateQueries({
          queryKey: [...usageKeys.all(target), "session-last-sync"],
        });
      }
    };

    void scan();
    const timer = window.setInterval(() => void scan(), refreshIntervalMs);
    const unsubscribe = focusManager.subscribe((focused) => {
      if (focused) void scan();
    });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [
    enabled,
    target,
    targetKey,
    paused,
    queryClient,
    refreshIntervalMs,
    sessionAutoSyncEnabled,
    syncSessionUsage,
  ]);

  useEffect(() => {
    if (!enabled || !rollingRange) return;
    const timer = window.setInterval(() => {
      if (focusManager.isFocused()) {
        void queryClient.invalidateQueries({ queryKey: usageKeys.all(target) });
      }
    }, ROLLING_RANGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, queryClient, rollingRange, target]);

  return { syncSessionUsage };
}
