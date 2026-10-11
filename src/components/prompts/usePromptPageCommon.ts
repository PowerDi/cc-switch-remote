import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { settingsApi, type AppId } from "@/lib/api";
import { promptKeys, usePromptFileLocationQuery } from "@/lib/query/prompts";
import { extractErrorMessage } from "@/utils/errorUtils";
import type { ManagementTarget } from "@/lib/api/remote";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";
import type { PromptMoreItem } from "./PromptPageFrame";
import { copyText, promptFileName, showPromptToast } from "./promptUtils";

/** 提示词页公用：目标文件位置、写完刷新别处的缓存、复制到其他应用。 */
export function usePromptPageCommon(
  appId: AppId,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isLocalTarget = target.type === "local";
  // Helper has no prompt file-location command: remote shows only the file name.
  const location = usePromptFileLocationQuery(appId, isLocalTarget);
  const fileName = promptFileName(appId);
  const displayPath = isLocalTarget
    ? (location.data?.displayPath ?? fileName)
    : fileName;

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: promptKeys.all });
  }, [queryClient]);

  const moreItems = (
    importItem: PromptMoreItem,
    copyPath: { label: string; path: string | undefined },
  ): PromptMoreItem[] =>
    isLocalTarget
      ? [
          importItem,
          {
            key: "open-folder",
            label: t("prompts.openFolder"),
            onSelect: () => {
              settingsApi.openConfigFolder(appId).catch((error: unknown) => {
                toast.error(t("prompts.openFolderFailed"), {
                  description: extractErrorMessage(error) || undefined,
                });
              });
            },
          },
          {
            key: "copy-path",
            label: copyPath.label,
            onSelect: () => {
              const path = copyPath.path;
              if (!path) return;
              void copyText(path).then((ok) => {
                if (ok)
                  showPromptToast(t, {
                    title: t("prompts.copiedPath", { path }),
                  });
                else toast.error(t("prompts.copyFailed"));
              });
            },
          },
        ]
      : [importItem];

  return { location, fileName, displayPath, invalidate, moreItems };
}

/** 启用 / 停用后 toast 的第二行：Hermes 写会话何时生效，Pi 写 /reload。 */
export function toggleEffectText(
  t: (key: string) => string,
  appId: AppId,
  enabled: boolean,
): string {
  if (appId === "hermes") {
    return t(enabled ? "prompts.toast.hermesOn" : "prompts.toast.hermesOff");
  }
  if (appId === "pi") return t("pi.prompts.reloadNotice");
  return "";
}
