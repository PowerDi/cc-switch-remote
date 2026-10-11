import type { ManagementTarget } from "@/lib/api";

export const LOCAL_MANAGEMENT_TARGET: ManagementTarget = { type: "local" };

export function getManagementTargetKey(target: ManagementTarget): string {
  return target.type === "remote" ? `remote:${target.profile.id}` : "local";
}

export function shouldReadLocalLiveConfig(
  target: ManagementTarget,
  isProxyTakeover: boolean,
): boolean {
  return target.type === "local" && !isProxyTakeover;
}

// 远端目标下这些视图管理的是本机状态（本机路由运行时），helper 没有等价能力。
// 「应用」页已目标化（工具环境走 helper 的 tools 能力，见 AppsPage），不再列在这里。
const LOCAL_ONLY_VIEWS = new Set(["workspace"]);

export function isRemoteSafeView(view: string): boolean {
  return !LOCAL_ONLY_VIEWS.has(view);
}
