import { useQuery } from "@tanstack/react-query";
import { remoteApi, type ManagementTarget } from "@/lib/api/remote";
import { getManagementTargetKey } from "@/lib/managementTarget";
import { useTargetAsyncGeneration } from "./useTargetAsyncGeneration";
import { useLatestTarget } from "./useTargetQueryIdentityReset";
import { extractErrorMessage } from "@/utils/errorUtils";

/** Local operations need no helper. A remote-only control stays unavailable
 * until the selected connection advertises support: a helper from an older
 * release must hide the control instead of failing with a low-level error.
 * The installed-capabilities suffix isolates this SSH-only response from full
 * health checks that include release metadata. Both share the remote-health
 * prefix so a settings-page refresh invalidates them for the same connection.
 * A replaced host/credential must never inherit the old target's capabilities.
 */
export function useTargetCapability(
  target: ManagementTarget,
  capability: string,
  enabled = true,
): boolean {
  return useTargetCapabilityState(target, capability, enabled).supported;
}

/** Missing data or a failed SSH check is not evidence of a missing capability. */
export function useTargetCapabilityState(
  target: ManagementTarget,
  capability: string,
  enabled = true,
) {
  const targetKey = getManagementTargetKey(target);
  const latestTarget = useLatestTarget(target);
  const { revision } = useTargetAsyncGeneration(target);
  const health = useQuery({
    queryKey: ["remote-health", targetKey, revision, "installed-capabilities"],
    queryFn: () => {
      const current = latestTarget.current;
      return current.type === "remote"
        ? remoteApi.checkHealth(current.profile, current.secret, false)
        : null;
    },
    enabled: enabled && target.type === "remote",
    staleTime: 30_000,
    retry: false,
  });
  const remoteUnavailable =
    health.data?.reachable === false || health.data?.helperInstalled === false;
  const supported =
    enabled &&
    (target.type === "local" ||
      (!health.isError &&
        !remoteUnavailable &&
        health.data?.capabilities.includes(capability) === true));
  const state = !enabled
    ? "disabled"
    : target.type === "local"
      ? "supported"
      : health.isError
        ? "error"
        : !health.data
          ? "loading"
          : remoteUnavailable
            ? "error"
            : supported
              ? "supported"
              : "unsupported";

  return {
    state,
    supported,
    error: health.isError
      ? extractErrorMessage(health.error)
      : (health.data?.lastError ?? null),
    isFetching: health.isFetching,
    refetch: health.refetch,
  };
}
