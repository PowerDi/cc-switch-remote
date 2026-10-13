import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";
import { remoteApi, type ManagementTarget } from "./remote";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";

// ===== 连通性检查类型 =====
// 注意：本检查只探测 base_url 是否可达，不发真实大模型请求，也不触碰故障转移熔断器。

export type HealthStatus = "operational" | "degraded" | "failed";

export interface StreamCheckResult {
  status: HealthStatus;
  success: boolean;
  message: string;
  responseTimeMs?: number;
  httpStatus?: number;
  testedAt: number;
  retryCount: number;
}

// ===== 连通性检查 API =====

/**
 * 连通性检查（单个供应商）
 */
export async function streamCheckProvider(
  appType: AppId,
  providerId: string,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
): Promise<StreamCheckResult> {
  if (target.type === "remote") {
    return remoteApi.streamCheckProvider(
      target.profile,
      appType,
      providerId,
      target.secret,
    );
  }
  return invoke("stream_check_provider", { appType, providerId });
}
