import { useQuery, type QueryClient } from "@tanstack/react-query";
import { piApi, type PiFamilyAppId } from "@/lib/api/pi";
import type { ManagementTarget } from "@/lib/api/remote";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import {
  useTargetConnectionEpoch,
  withConnectionEpoch,
} from "@/hooks/useTargetConnectionEpoch";
import { useTargetCapability } from "@/hooks/useTargetCapability";
import { useLatestTarget } from "@/hooks/useTargetQueryIdentityReset";

export const piKeys = {
  all: ["pi"] as const,
  currentState: ["pi", "currentState"] as const,
  sessionDiscovery: ["pi", "sessionDiscovery"] as const,
};

export const invalidatePiProviderCaches = async (
  queryClient: QueryClient,
  app: PiFamilyAppId = "pi",
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) => {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: [app, "currentState", getManagementTargetKey(target)],
    }),
    queryClient.invalidateQueries({
      queryKey: ["providers", app, getManagementTargetKey(target)],
    }),
  ]);
};

export const invalidatePiDirectoryCaches = async (
  queryClient: QueryClient,
  app: PiFamilyAppId = "pi",
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [app] }),
    queryClient.invalidateQueries({
      queryKey: ["providers", app, getManagementTargetKey(target)],
    }),
    queryClient.invalidateQueries({ queryKey: ["skills", "installed"] }),
    queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  ]);
};

export function usePiCurrentState(
  enabled = true,
  app: PiFamilyAppId = "pi",
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const supported = useTargetCapability(target, "pi-native-state", enabled);
  const epoch = useTargetConnectionEpoch(target);
  const latestTarget = useLatestTarget(target);
  return useQuery({
    queryKey: withConnectionEpoch(
      [app, "currentState", getManagementTargetKey(target)],
      epoch,
    ),
    queryFn: () => piApi.getCurrentState(app, latestTarget.current),
    enabled: enabled && supported,
  });
}
