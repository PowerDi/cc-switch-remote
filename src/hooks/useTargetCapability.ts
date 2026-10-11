import { useQuery } from "@tanstack/react-query";
import { remoteApi, type ManagementTarget } from "@/lib/api/remote";
import { getManagementTargetKey } from "@/lib/managementTarget";
import { useTargetAsyncGeneration } from "./useTargetAsyncGeneration";

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
  const targetKey = getManagementTargetKey(target);
  const { revision } = useTargetAsyncGeneration(target);
  const health = useQuery({
    queryKey: ["remote-health", targetKey, revision],
    queryFn: () =>
      target.type === "remote"
        ? remoteApi.checkHealth(target.profile, target.secret)
        : null,
    enabled: enabled && target.type === "remote",
    staleTime: 30_000,
    retry: false,
  });
  return (
    enabled &&
    (target.type === "local" ||
      health.data?.capabilities.includes(capability) === true)
  );
}
