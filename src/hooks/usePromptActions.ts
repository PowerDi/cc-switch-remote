import { readLocalCache, writeLocalCache } from "@/lib/localCache";
import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { promptsApi, type Prompt, type AppId } from "@/lib/api";
import type { ManagementTarget } from "@/lib/api/remote";

const LOCAL_TARGET: ManagementTarget = { type: "local" };
const EMPTY_PROMPTS: Record<string, Prompt> = {};

const getContextKey = (appId: AppId, target: ManagementTarget) =>
  `${appId}:${target.type === "remote" ? `remote:${target.profile.id}` : "local"}`;

interface PromptActionsOptions {
  /** false：成功时不弹通用 toast（提示词页自己写带后果和撤销的 toast）；失败照样提示 */
  notify?: boolean;
}

export function usePromptActions(
  appId: AppId,
  target: ManagementTarget = LOCAL_TARGET,
  { notify = true }: PromptActionsOptions = {},
) {
  const { t } = useTranslation();
  const contextKey = getContextKey(appId, target);
  const [prompts, setPrompts] = useState<Record<string, Prompt>>({});
  const [promptsContextKey, setPromptsContextKey] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [currentFileContent, setCurrentFileContent] = useState<string | null>(
    null,
  );
  const [currentFileContextKey, setCurrentFileContextKey] = useState<
    string | null
  >(null);
  const reloadGenerationRef = useRef(0);
  const isLocalTarget = target.type === "local";
  const currentContextKeyRef = useRef(contextKey);
  const currentTargetRef = useRef(target);
  const promptsContextKeyRef = useRef<string | null>(null);
  // 最近一次从后端读到的列表（写操作之后调用方要拿新列表比对，比如启用时多出来的「原始提示词」）
  const latestLoadedRef = useRef<{
    contextKey: string;
    prompts: Record<string, Prompt>;
  } | null>(null);
  currentContextKeyRef.current = contextKey;
  currentTargetRef.current = target;

  const visiblePrompts =
    promptsContextKey === contextKey ? prompts : EMPTY_PROMPTS;
  const visibleCurrentFileContent =
    currentFileContextKey === contextKey ? currentFileContent : null;

  const updatePromptsForContext = useCallback(
    (
      targetContextKey: string,
      requestTarget: ManagementTarget,
      updater: (current: Record<string, Prompt>) => Record<string, Prompt>,
    ) => {
      if (
        currentContextKeyRef.current !== targetContextKey ||
        currentTargetRef.current !== requestTarget
      ) {
        return;
      }

      const previousContextKey = promptsContextKeyRef.current;
      setPrompts((current) =>
        updater(
          previousContextKey === targetContextKey ? current : EMPTY_PROMPTS,
        ),
      );
      promptsContextKeyRef.current = targetContextKey;
      setPromptsContextKey(targetContextKey);
    },
    [],
  );

  useEffect(
    () => () => {
      reloadGenerationRef.current += 1;
    },
    [],
  );

  const reload = useCallback(async (): Promise<boolean> => {
    const requestContextKey = contextKey;
    const requestTarget = target;
    if (
      currentContextKeyRef.current !== requestContextKey ||
      currentTargetRef.current !== requestTarget
    ) {
      return false;
    }

    const requestGeneration = ++reloadGenerationRef.current;
    const isCurrentRequest = () =>
      reloadGenerationRef.current === requestGeneration &&
      currentContextKeyRef.current === requestContextKey &&
      currentTargetRef.current === requestTarget;

    // 先显示上次的列表（本地缓存），后台读到最新的再替换；没有缓存才显示「加载中」。
    // 缓存只服务本机目标：远端主机的内容不写进本机 localStorage，避免跨主机串数据。
    const cacheKey = `prompts.${appId}.v1`;
    const cached = isLocalTarget
      ? readLocalCache<Record<string, Prompt>>(cacheKey)
      : null;
    if (cached && promptsContextKeyRef.current !== requestContextKey) {
      updatePromptsForContext(requestContextKey, requestTarget, () => cached);
    }
    setLoading(!cached);
    try {
      const data = await promptsApi.getPrompts(appId, requestTarget);
      if (!isCurrentRequest()) return false;
      latestLoadedRef.current = {
        contextKey: requestContextKey,
        prompts: data,
      };
      updatePromptsForContext(requestContextKey, requestTarget, () => data);
      if (isLocalTarget) {
        writeLocalCache(cacheKey, data);
      }

      try {
        const content = await promptsApi.getCurrentFileContent(
          appId,
          requestTarget,
        );
        if (!isCurrentRequest()) return false;
        setCurrentFileContent(content);
        setCurrentFileContextKey(requestContextKey);
      } catch (error) {
        if (isCurrentRequest()) {
          setCurrentFileContent(null);
          setCurrentFileContextKey(requestContextKey);
        }
      }
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        toast.error(t("prompts.loadFailed"));
      }
      return false;
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [appId, contextKey, t, target, updatePromptsForContext]);

  const savePrompt = useCallback(
    async (id: string, prompt: Prompt) => {
      const requestContextKey = contextKey;
      const requestTarget = target;
      try {
        await promptsApi.upsertPrompt(appId, id, prompt, requestTarget);
        updatePromptsForContext(
          requestContextKey,
          requestTarget,
          (current) => ({
            ...current,
            [id]: prompt,
          }),
        );
        const refreshed =
          currentContextKeyRef.current === requestContextKey &&
          currentTargetRef.current === requestTarget
            ? await reload()
            : false;
        if (notify) {
          toast.success(t("prompts.saveSuccess"), {
            closeButton: true,
            description:
              appId === "pi" && prompt.enabled
                ? t("pi.prompts.reloadNotice")
                : undefined,
          });
        }
        return refreshed;
      } catch (error) {
        toast.error(t("prompts.saveFailed"));
        throw error;
      }
    },
    [appId, contextKey, notify, reload, t, target, updatePromptsForContext],
  );

  const deletePrompt = useCallback(
    async (id: string) => {
      const requestContextKey = contextKey;
      const requestTarget = target;
      try {
        await promptsApi.deletePrompt(appId, id, requestTarget);
        updatePromptsForContext(requestContextKey, requestTarget, (current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        const refreshed =
          currentContextKeyRef.current === requestContextKey &&
          currentTargetRef.current === requestTarget
            ? await reload()
            : false;
        if (notify) {
          toast.success(t("prompts.deleteSuccess"), { closeButton: true });
        }
        return refreshed;
      } catch (error) {
        toast.error(t("prompts.deleteFailed"));
        throw error;
      }
    },
    [appId, contextKey, notify, reload, t, target, updatePromptsForContext],
  );

  const enablePrompt = useCallback(
    async (id: string) => {
      const requestContextKey = contextKey;
      const requestTarget = target;
      try {
        await promptsApi.enablePrompt(appId, id, requestTarget);
        updatePromptsForContext(requestContextKey, requestTarget, (current) =>
          Object.fromEntries(
            Object.entries(current).map(([key, prompt]) => [
              key,
              { ...prompt, enabled: key === id },
            ]),
          ),
        );
        const refreshed =
          currentContextKeyRef.current === requestContextKey &&
          currentTargetRef.current === requestTarget
            ? await reload()
            : false;
        if (notify) {
          toast.success(t("prompts.enableSuccess"), { closeButton: true });
        }
        return refreshed;
      } catch (error) {
        toast.error(t("prompts.enableFailed"));
        throw error;
      }
    },
    [appId, contextKey, notify, reload, t, target, updatePromptsForContext],
  );

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const requestContextKey = contextKey;
      const requestTarget = target;

      // Pi 的提示词开关是「换成这一条 / 换回原始提示词」，后端语义和别的应用不同，
      // 所以走单独分支，不做乐观更新。
      if (appId === "pi") {
        setTogglingId(id);
        try {
          if (enabled) {
            await promptsApi.enablePrompt(appId, id, requestTarget);
          } else {
            const prompt = visiblePrompts[id];
            if (!prompt) {
              throw new Error(`Prompt ${id} does not exist`);
            }
            await promptsApi.upsertPrompt(
              appId,
              id,
              {
                ...prompt,
                enabled: false,
              },
              requestTarget,
            );
          }
          const refreshed =
            currentContextKeyRef.current === requestContextKey &&
            currentTargetRef.current === requestTarget
              ? await reload()
              : false;
          if (notify) {
            toast.success(
              t(
                enabled
                  ? "pi.prompts.usePromptSuccess"
                  : "pi.prompts.stopUsingSuccess",
              ),
              {
                closeButton: true,
                description: t("pi.prompts.reloadNotice"),
              },
            );
          }
          return refreshed;
        } catch (error) {
          toast.error(
            enabled ? t("prompts.enableFailed") : t("prompts.disableFailed"),
          );
          throw error;
        } finally {
          setTogglingId(null);
        }
      }

      const previousPrompts = visiblePrompts;
      const mutationGeneration = reloadGenerationRef.current;

      // Pi 已在上面单独处理并返回，这里只走其它应用（乐观更新 + 失败回滚）。
      if (enabled) {
        const updatedPrompts = Object.keys(visiblePrompts).reduce(
          (acc, key) => {
            acc[key] = { ...visiblePrompts[key], enabled: key === id };
            return acc;
          },
          {} as Record<string, Prompt>,
        );
        updatePromptsForContext(
          requestContextKey,
          requestTarget,
          () => updatedPrompts,
        );
      } else {
        updatePromptsForContext(
          requestContextKey,
          requestTarget,
          (current) => ({
            ...current,
            [id]: { ...current[id], enabled: false },
          }),
        );
      }

      try {
        if (enabled) {
          await promptsApi.enablePrompt(appId, id, requestTarget);
          if (notify) {
            toast.success(t("prompts.enableSuccess"), { closeButton: true });
          }
        } else {
          await promptsApi.upsertPrompt(
            appId,
            id,
            { ...visiblePrompts[id], enabled: false },
            requestTarget,
          );
          if (notify) {
            toast.success(t("prompts.disableSuccess"), { closeButton: true });
          }
        }
        return currentContextKeyRef.current === requestContextKey &&
          currentTargetRef.current === requestTarget
          ? await reload()
          : false;
      } catch (error) {
        if (
          currentContextKeyRef.current === requestContextKey &&
          currentTargetRef.current === requestTarget &&
          reloadGenerationRef.current === mutationGeneration
        ) {
          updatePromptsForContext(
            requestContextKey,
            requestTarget,
            () => previousPrompts,
          );
        }
        toast.error(
          enabled ? t("prompts.enableFailed") : t("prompts.disableFailed"),
        );
        throw error;
      }
    },
    [
      appId,
      contextKey,
      notify,
      reload,
      t,
      target,
      updatePromptsForContext,
      visiblePrompts,
    ],
  );

  const importFromFile = useCallback(async () => {
    const requestContextKey = contextKey;
    const requestTarget = target;
    try {
      const id = await promptsApi.importFromFile(appId, requestTarget);
      if (
        currentContextKeyRef.current === requestContextKey &&
        currentTargetRef.current === requestTarget
      ) {
        await reload();
      }
      if (notify) {
        toast.success(t("prompts.importSuccess"), { closeButton: true });
      }
      return id;
    } catch (error) {
      toast.error(t("prompts.importFailed"));
      throw error;
    }
  }, [appId, contextKey, notify, reload, t, target]);

  /**
   * 最近一次读到的当前目标+应用列表；还没读过、或读的是别的目标/应用时返回 null。
   */
  const getLatestPrompts = useCallback((): Record<string, Prompt> | null => {
    const latest = latestLoadedRef.current;
    return latest && latest.contextKey === currentContextKeyRef.current
      ? latest.prompts
      : null;
  }, []);

  return {
    prompts: visiblePrompts,
    loading,
    currentFileContent: visibleCurrentFileContent,
    togglingId,
    reload,
    savePrompt,
    deletePrompt,
    enablePrompt,
    toggleEnabled,
    importFromFile,
    getLatestPrompts,
  };
}
