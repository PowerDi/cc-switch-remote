import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { useTranslation } from "react-i18next";
import {
  streamCheckProvider,
  type StreamCheckResult,
} from "@/lib/api/connectivity-check";
import type { AppId, ManagementTarget } from "@/lib/api";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import { remoteApi } from "@/lib/api/remote";
import { useTargetAsyncGeneration } from "@/hooks/useTargetAsyncGeneration";

/**
 * 供应商连通性检查。
 *
 * 只探测 base_url 是否可达（任何 HTTP 响应都算可达），不发真实大模型请求。
 * 刻意不重置故障转移熔断器：可达不等于配置正确，一个端口通但鉴权废的供应商
 * 不应被误判为健康而切回线上。熔断器只由真实转发流量驱动。
 */
export function useStreamCheck(
  appId: AppId,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const { t } = useTranslation();
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const targetKey = getManagementTargetKey(target);
  const { capture, isCurrent, revision } = useTargetAsyncGeneration(target);
  const appScopeRef = useRef({ appId });
  if (appScopeRef.current.appId !== appId) appScopeRef.current = { appId };
  const appScope = appScopeRef.current;
  const health = useQuery({
    queryKey: ["remote-health", targetKey, revision],
    queryFn: () =>
      target.type === "remote"
        ? remoteApi.checkHealth(target.profile, target.secret)
        : null,
    enabled: target.type === "remote",
    retry: false,
    staleTime: 30_000,
  });
  const canCheck =
    target.type === "local" ||
    health.data?.capabilities.includes("connectivity-check") === true;

  useEffect(() => {
    setCheckingIds(new Set());
  }, [appId, targetKey, revision]);

  const checkProvider = useCallback(
    async (
      providerId: string,
      providerName: string,
    ): Promise<StreamCheckResult | null> => {
      if (!canCheck) return null;
      const generation = capture();
      const isActive = () =>
        isCurrent(generation) &&
        generation.revision === revision &&
        appScopeRef.current === appScope;
      if (!isActive()) return null;
      setCheckingIds((prev) => new Set(prev).add(providerId));

      try {
        const result = await streamCheckProvider(appId, providerId, target);
        if (!isActive()) return null;

        if (result.status === "operational") {
          toast.success(
            t("streamCheck.reachable", {
              providerName: providerName,
              responseTimeMs: result.responseTimeMs,
              defaultValue: `${providerName} 连通正常 (${result.responseTimeMs}ms)`,
            }),
            { closeButton: true },
          );
        } else if (result.status === "degraded") {
          toast.warning(
            t("streamCheck.reachableSlow", {
              providerName: providerName,
              responseTimeMs: result.responseTimeMs,
              defaultValue: `${providerName} 连通但较慢 (${result.responseTimeMs}ms)`,
            }),
          );
        } else {
          // 仅当无法建立连接（DNS / 连接被拒 / TLS / 超时）才会到这里
          toast.error(
            t("streamCheck.unreachable", {
              providerName: providerName,
              message: result.message,
              defaultValue: `${providerName} 无法连通: ${result.message}`,
            }),
            {
              description: t("streamCheck.unreachableHint", {
                defaultValue:
                  "无法建立连接（DNS / 连接 / TLS / 超时）。请检查 base_url 与网络。",
              }),
              duration: 8000,
              closeButton: true,
            },
          );
        }

        return result;
      } catch (e) {
        if (!isActive()) return null;
        toast.error(
          t("streamCheck.error", {
            providerName: providerName,
            error: String(e),
            defaultValue: `${providerName} 检查出错: ${String(e)}`,
          }),
        );
        return null;
      } finally {
        if (isActive())
          setCheckingIds((prev) => {
            const next = new Set(prev);
            next.delete(providerId);
            return next;
          });
      }
    },
    [appId, t, target, canCheck, capture, isCurrent, revision, appScope],
  );

  const isChecking = useCallback(
    (providerId: string) => checkingIds.has(providerId),
    [checkingIds],
  );

  return { checkProvider, isChecking, canCheck };
}
