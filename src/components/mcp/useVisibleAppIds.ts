import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppId } from "@/lib/api/types";
import { settingsApi } from "@/lib/api";
import type { ManagementTarget } from "@/lib/api/remote";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import { useTargetCapability } from "@/hooks/useTargetCapability";
import { DEFAULT_VISIBLE_APPS } from "@/config/appConfig";

/** The selected host owns app visibility. Unsupported remote apps stay hidden. */
export function useVisibleAppIds<T extends AppId>(
  appIds: readonly T[],
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
): T[] {
  const { data: settings } = useQuery({
    queryKey:
      target.type === "local"
        ? ["settings"]
        : ["settings", getManagementTargetKey(target)],
    queryFn: () => settingsApi.get(target),
  });
  const ompSupported = useTargetCapability(target, "omp");
  const visibleApps = settings?.visibleApps;
  return useMemo(() => {
    const visible = { ...DEFAULT_VISIBLE_APPS, ...visibleApps };
    return appIds.filter(
      (app) =>
        visible[app] &&
        (target.type === "local" ||
          (app !== "claude-desktop" &&
            app !== "agy" &&
            app !== "kimi" &&
            (app !== "omp" || ompSupported))),
    );
  }, [appIds, visibleApps, target.type, ompSupported]);
}
