import { useCallback } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { hermesApi } from "@/lib/api/hermes";
import { providersApi } from "@/lib/api/providers";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import { settingsApi } from "@/lib/api/settings";
import type { HermesMemoryKind } from "@/types";
import type { ManagementTarget } from "@/lib/api";
import { extractErrorMessage } from "@/utils/errorUtils";
import { useTargetMutation } from "./useTargetMutation";
import {
  useTargetConnectionEpoch,
  withConnectionEpoch,
} from "./useTargetConnectionEpoch";

/**
 * Error code returned by the Rust `open_hermes_web_ui` command when probing
 * `/api/status` fails. Must match the string constant in
 * `src-tauri/src/commands/hermes.rs`.
 */
export const HERMES_WEB_OFFLINE_ERROR = "hermes_web_offline";

/**
 * Centralized query keys for all Hermes-related queries.
 * Import this from any file that needs to invalidate Hermes caches.
 */
export const hermesKeys = {
  all: ["hermes"] as const,
  liveProviderIds: (targetKey = "local") =>
    ["hermes", "liveProviderIds", targetKey] as const,
  modelConfig: (targetKey = "local") =>
    ["hermes", "modelConfig", targetKey] as const,
  memory: (kind: HermesMemoryKind, targetKey = "local") =>
    ["hermes", "memory", targetKey, kind] as const,
  memoryLimits: (targetKey = "local") =>
    ["hermes", "memoryLimits", targetKey] as const,
  configDir: (targetKey = "local") =>
    ["hermes", "configDir", targetKey] as const,
};

/**
 * Invalidate all Hermes caches that may change when a provider is
 * added/updated/deleted/switched. Runs invalidations in parallel so the
 * caller doesn't await three sequential refetches.
 */
export function invalidateHermesProviderCaches(
  queryClient: QueryClient,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const targetKey = getManagementTargetKey(target);
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: hermesKeys.liveProviderIds(targetKey),
    }),
    queryClient.invalidateQueries({
      queryKey: hermesKeys.modelConfig(targetKey),
    }),
  ]);
}

// ============================================================
// Query hooks
// ============================================================

export function useHermesLiveProviderIds(
  enabled: boolean,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const targetKey = getManagementTargetKey(target);
  return useQuery({
    queryKey: hermesKeys.liveProviderIds(targetKey),
    queryFn: () => providersApi.getHermesLiveProviderIds(target),
    enabled,
  });
}

export function useHermesModelConfig(
  enabled: boolean,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const targetKey = getManagementTargetKey(target);
  return useQuery({
    queryKey: hermesKeys.modelConfig(targetKey),
    queryFn: () => hermesApi.getModelConfig(target),
    enabled,
  });
}

export function useHermesMemory(
  kind: HermesMemoryKind,
  enabled: boolean,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const targetKey = getManagementTargetKey(target);
  const epoch = useTargetConnectionEpoch(target);
  return useQuery({
    queryKey: withConnectionEpoch(hermesKeys.memory(kind, targetKey), epoch),
    queryFn: () => hermesApi.getMemory(kind, target),
    enabled,
  });
}

export function useHermesMemoryLimits(
  enabled: boolean,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const targetKey = getManagementTargetKey(target);
  const epoch = useTargetConnectionEpoch(target);
  return useQuery({
    queryKey: withConnectionEpoch(hermesKeys.memoryLimits(targetKey), epoch),
    queryFn: () => hermesApi.getMemoryLimits(target),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Hermes 的配置目录（设置里可改，也认 HERMES_HOME），记忆页用来显示
 * memories/MEMORY.md 的真实路径。
 */
export function useHermesConfigDir(
  enabled: boolean,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const targetKey = getManagementTargetKey(target);
  // 本机读的是 Hermes 自己的配置目录；helper 现在只有 `settings app-config-dir`
  // （cc-switch-remote 的数据目录），两者不是一回事。远端先不显示这条路径，
  // 而不是拿数据目录冒充 Hermes 目录（见实施记录 B3c 的未完成项）。
  return useQuery({
    queryKey: hermesKeys.configDir(targetKey),
    queryFn: () => settingsApi.getConfigDir("hermes"),
    staleTime: 60_000,
    enabled: enabled && target.type === "local",
  });
}

// ============================================================
// Mutation hooks
// ============================================================

/**
 * Save a Hermes memory file atomically and refresh the corresponding query.
 * Error toasts are emitted here so caller components don't need their own
 * try/catch; success toasts are intentionally left to the caller (to pick
 * the right localized message per tab).
 */
export function useSaveHermesMemory(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useTargetMutation<void, { kind: HermesMemoryKind; content: string }>(
    target,
    {
      mutationFn: ({ kind, content }, scope) =>
        hermesApi.setMemory(kind, content, scope.target),
      onSuccess: async (_data, variables, scope) => {
        await queryClient.invalidateQueries({
          queryKey: withConnectionEpoch(
            hermesKeys.memory(
              variables.kind,
              getManagementTargetKey(scope.target),
            ),
            scope.epoch,
          ),
          exact: true,
        });
      },
      onError: (error) => {
        toast.error(t("hermes.memory.saveFailed"), {
          description: extractErrorMessage(error) || undefined,
        });
      },
    },
  );
}

/**
 * Toggle one memory blob's on/off flag in Hermes' `config.yaml`. Invalidates
 * the limits query so the switch UI and disabled banner update immediately.
 */
export function useToggleHermesMemoryEnabled(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useTargetMutation<void, { kind: HermesMemoryKind; enabled: boolean }>(
    target,
    {
      mutationFn: ({ kind, enabled }, scope) =>
        hermesApi.setMemoryEnabled(kind, enabled, scope.target),
      onSuccess: async (_data, _variables, scope) => {
        await queryClient.invalidateQueries({
          queryKey: withConnectionEpoch(
            hermesKeys.memoryLimits(getManagementTargetKey(scope.target)),
            scope.epoch,
          ),
          exact: true,
        });
      },
      onError: (error) => {
        toast.error(t("hermes.memory.toggleFailed"), {
          description: extractErrorMessage(error) || undefined,
        });
      },
    },
  );
}

/**
 * Returns a handler that probes the local Hermes Web UI, opens it in the
 * system browser, and surfaces a localized toast on failure. When
 * `onOffline` is provided, it replaces the default offline toast —
 * callers can use this to open a launch-dashboard confirm dialog instead.
 */
export function useOpenHermesWebUI(onOffline?: () => void) {
  const { t } = useTranslation();
  return useCallback(
    async (path?: string) => {
      try {
        await hermesApi.openWebUI(path);
      } catch (error) {
        const detail = extractErrorMessage(error);
        if (detail === HERMES_WEB_OFFLINE_ERROR) {
          if (onOffline) {
            onOffline();
          } else {
            toast.error(t("hermes.webui.offline"));
          }
        } else {
          toast.error(t("hermes.webui.openFailed"), {
            description: detail || undefined,
          });
        }
      }
    },
    [t, onOffline],
  );
}
