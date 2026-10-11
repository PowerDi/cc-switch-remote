import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type InvalidateQueryFilters,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { providersApi } from "@/lib/api";
import { profilesApi, type ProfileScope } from "@/lib/api/profiles";
import type { ManagementTarget } from "@/lib/api/remote";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  useTargetMutation,
  type TargetMutationScope,
} from "@/hooks/useTargetMutation";
import {
  isCurrentTargetConnection,
  useTargetConnectionEpoch,
  withConnectionEpoch,
} from "@/hooks/useTargetConnectionEpoch";
import { promptAppOf, promptKeys } from "./prompts";

export const profileQueryKey = (target: ManagementTarget, epoch?: number) =>
  withConnectionEpoch(["profiles", getManagementTargetKey(target)], epoch);

export const useProfilesQuery = (
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) => {
  const epoch = useTargetConnectionEpoch(target);
  return useQuery({
    queryKey: profileQueryKey(target, epoch),
    queryFn: () => profilesApi.list(target),
  });
};

async function refreshProfileState(
  client: QueryClient,
  submitted: TargetMutationScope,
  appliedScope?: ProfileScope,
) {
  const { target, epoch } = submitted;
  // Some existing feature keys are not yet epoch-qualified. An old completion
  // must never invalidate their replacement connection under the same host ID.
  const invalidate = async (filters: InvalidateQueryFilters) => {
    // Recheck after every awaited refetch: the user can edit this connection
    // while the previous domain is still loading.
    if (!isCurrentTargetConnection(client, target, epoch)) return;
    await client.invalidateQueries(filters);
  };
  await invalidate({
    queryKey: profileQueryKey(target, epoch),
    exact: true,
  });
  if (appliedScope) {
    const key = getManagementTargetKey(target);
    await invalidate({
      queryKey: ["providers", appliedScope, key],
    });
    if (target.type === "local") {
      // v4 local prefetch/observers use this base key until the provider query
      // merge is complete. Exact matching must not invalidate remote suffixes.
      await invalidate({ queryKey: ["providers", appliedScope], exact: true });
      await invalidate({
        queryKey: ["providers", appliedScope, "mode"],
      });
    }
    await invalidate({ queryKey: ["mcp", "all", key] });
    // Never invalidate all hosts' skills (or the global online catalog).
    for (const collection of ["installed", "unmanaged", "backups"]) {
      await invalidate({ queryKey: ["skills", collection, key] });
    }
    const promptApp = promptAppOf(appliedScope);
    if (promptApp) {
      await invalidate({
        queryKey: withConnectionEpoch(
          promptKeys.list(promptApp, target),
          epoch,
        ),
        exact: true,
      });
    }
  }
  if (target.type === "local") {
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("Failed to update tray menu after profile change", error);
    }
  }
}

/** Common target binding/feedback; all operations still use the same Rust
 * ProfileService through the existing local or SSH API adapter. */
function useProfileMutation<TData, TVariables>(
  target: ManagementTarget,
  operation: "create" | "update" | "delete" | "clear" | "apply",
  run: (variables: TVariables, target: ManagementTarget) => Promise<TData>,
  effects?: {
    appliedScope: (variables: TVariables) => ProfileScope;
    warnings: (data: TData) => string[];
  },
) {
  const client = useQueryClient();
  const { t } = useTranslation();
  return useTargetMutation(target, {
    mutationFn: (variables: TVariables, submitted) =>
      run(variables, submitted.target),
    onSuccess: async (data, variables, submitted) => {
      await refreshProfileState(
        client,
        submitted,
        effects?.appliedScope(variables),
      );
      const warnings = effects?.warnings(data) ?? [];
      if (warnings.length > 0) {
        toast.warning(
          t("profiles.applyWarnings", {
            warningCount: warnings.length,
            details: warnings.join("\n"),
          }),
          { closeButton: true, duration: 10000 },
        );
      } else {
        toast.success(t(`profiles.${operation}Success`), { closeButton: true });
      }
    },
    onError: (error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(
        t(`profiles.${operation === "clear" ? "apply" : operation}Failed`, {
          detail,
        }),
        { closeButton: true },
      );
    },
  });
}

export const useCreateProfileMutation = (
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) =>
  useProfileMutation(
    target,
    "create",
    ({ name, scope }: { name: string; scope: ProfileScope }, submitted) =>
      profilesApi.create(name, scope, submitted),
  );

export const useUpdateProfileMutation = (
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) =>
  useProfileMutation(
    target,
    "update",
    (
      {
        id,
        name,
        resnapshot,
        scope,
      }: {
        id: string;
        name?: string;
        resnapshot?: boolean;
        scope?: ProfileScope;
      },
      submitted,
    ) => profilesApi.update(id, { name, resnapshot, scope }, submitted),
  );

export const useDeleteProfileMutation = (
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) =>
  useProfileMutation(target, "delete", (id: string, submitted) =>
    profilesApi.delete(id, submitted),
  );

export const useClearProfileMutation = (
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) =>
  useProfileMutation(target, "clear", (scope: ProfileScope, submitted) =>
    profilesApi.clearCurrent(scope, submitted),
  );

export const useApplyProfileMutation = (
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) =>
  useProfileMutation(
    target,
    "apply",
    ({ id, scope }: { id: string; scope: ProfileScope }, submitted) =>
      profilesApi.apply(id, scope, submitted),
    {
      appliedScope: ({ scope }) => scope,
      warnings: (warnings) => warnings,
    },
  );
