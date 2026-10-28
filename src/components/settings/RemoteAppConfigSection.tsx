import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ManagementTarget } from "@/lib/api/remote";
import type { Settings } from "@/types";
import type {
  SettingsFormState,
  ResolvedDirectories,
} from "@/hooks/useSettings";
import type { DirectoryAppId } from "./DirectorySettings";
import { useTargetCapability } from "@/hooks/useTargetCapability";
import { getManagementTargetKey } from "@/lib/managementTarget";
import {
  AppConfigSection,
  DIRECTORY_APPS,
  DIRECTORY_FIELD,
} from "./sections/AppConfigSection";

/** Reuse the local module; directory changes are saved by the remote settings service. */
export function RemoteAppConfigSection({
  settings,
  target,
  isSaving,
  onSave,
}: {
  settings: Settings;
  target: Extract<ManagementTarget, { type: "remote" }>;
  isSaving: boolean;
  onSave: (updates: Partial<Settings>) => Promise<boolean>;
}) {
  const queryClient = useQueryClient();
  const ompSupported = useTargetCapability(target, "omp");
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const supportedApps = DIRECTORY_APPS.filter(
    (app) => app !== "omp" || ompSupported,
  );
  const changeDirectory = (app: DirectoryAppId, value?: string) => {
    setDraft((previous) => ({ ...previous, [DIRECTORY_FIELD[app]]: value }));
  };
  const saveDirectories = async (updates: Partial<Settings>) => {
    if (!(await onSave(updates))) return;
    const targetKey = getManagementTargetKey(target);
    await queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes(targetKey),
    });
  };
  const resolvedDirs = Object.fromEntries(
    ["appConfig", ...DIRECTORY_APPS].map((app) => [app, ""]),
  ) as unknown as ResolvedDirectories;
  return (
    <AppConfigSection
      target={target}
      supportedApps={supportedApps}
      settings={draft as SettingsFormState}
      savedSettings={settings}
      resolvedDirs={resolvedDirs}
      isSaving={isSaving}
      onAutoSave={(updates) => onSave(updates as Partial<Settings>)}
      onDirectoryChange={changeDirectory}
      onResetDirectory={async (app) => {
        if (await onSave({ [DIRECTORY_FIELD[app]]: undefined }))
          changeDirectory(app, undefined);
      }}
      onSaveDirectories={async () =>
        saveDirectories(
          Object.fromEntries(
            supportedApps.map((app) => {
              const field = DIRECTORY_FIELD[app];
              const value = draft[field];
              return [
                field,
                typeof value === "string" && value.trim()
                  ? value.trim()
                  : undefined,
              ];
            }),
          ),
        )
      }
    />
  );
}
