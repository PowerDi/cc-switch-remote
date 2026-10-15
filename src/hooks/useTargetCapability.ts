import { useQuery } from "@tanstack/react-query";
import { remoteApi, type ManagementTarget } from "@/lib/api/remote";
import { getManagementTargetKey } from "@/lib/managementTarget";
import { useTargetAsyncGeneration } from "./useTargetAsyncGeneration";
import { useLatestTarget } from "./useTargetQueryIdentityReset";
import { extractErrorMessage } from "@/utils/errorUtils";

/** Local operations need no helper. A remote-only control stays unavailable
 * until the selected connection advertises support: a helper from an older
 * release must hide the control instead of failing with a low-level error.
 * Shares the health query key with useStreamCheck so one connection still
 * makes one health call, and a replaced host/credential can never lend its
 * capabilities to the new connection.
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
    queryKey: ["remote-health", targetKey, revision],
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
  const supported =
    enabled &&
    (target.type === "local" ||
      (!health.isError &&
        health.data?.reachable === true &&
        health.data.helperInstalled &&
        health.data.capabilities.includes(capability)));
  const state = !enabled
    ? "disabled"
    : target.type === "local"
      ? "supported"
      : health.isError
        ? "error"
        : !health.data
          ? "loading"
          : !health.data.reachable || !health.data.helperInstalled
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
