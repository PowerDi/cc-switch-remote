import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import type { Provider } from "@/types";
import type { AppMode } from "@/types/proxy";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { AuthSettingsPanel } from "@/components/providers/AuthSettingsPanel";
import {
  openclawApi,
  providersApi,
  vscodeApi,
  type AppId,
  type ManagedAuthProvider,
  type ManagementTarget,
} from "@/lib/api";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";
import {
  extractCodexExperimentalBearerToken,
  hideRemoteProviderConfigSecretsForDisplay,
  restoreRemoteProviderConfigSecretsForSubmit,
} from "@/utils/providerConfigUtils";
import { useTargetCapability } from "@/hooks/useTargetCapability";
import type {
  EditorConflictPolicy,
  ProviderEditorSave,
  ProviderEditorView,
} from "@/lib/api/providers";
import { useLiveEditConflict } from "@/components/providers/LiveEditConflictDialog";
import { toastEditorViewFailed } from "@/components/providers/forms/hooks/useDraftEditorProjection";
import { usesEditorView } from "@/config/appConfig";

interface EditProviderDialogProps {
  open: boolean;
  provider: Provider | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: {
    provider: Provider;
    originalId?: string;
    editorSave?: ProviderEditorSave;
  }) => Promise<void> | void;
  appId: AppId;
  isProxyTakeover?: boolean; // 代理接管模式下不读取 live（避免显示被接管后的代理配置）
  /** 正在编辑的是当前生效的那家（切换式应用）：页头下提示保存后立即生效 */
  isCurrent?: boolean;
  /** 从供应商页哪一格打开的，见 ProviderForm 的同名参数 */
  modeView?: AppMode;
  /** 管理目标：本机走 Tauri，远端走 SSH helper（同一套表单与校验）。 */
  target?: ManagementTarget;
}

/** 直连时保存当前供应商会写进的配置文件 */
const LIVE_FILE: Partial<Record<AppId, string>> = {
  claude: "~/.claude/settings.json",
  codex: "~/.codex/config.toml",
  gemini: "~/.gemini/.env",
};
const SWITCH_APPS: AppId[] = [
  "claude",
  "codex",
  "gemini",
  "grokbuild",
  "claude-desktop",
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const hasAuthMaterial = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

/**
 * Rebuild the provider auth only for a current Codex provider's live snapshot.
 *
 * In official-auth-preservation mode, live config.toml owns the active
 * provider bearer while the shared auth.json may belong to another provider or
 * contain the user's ChatGPT login. Stored provider auth remains the template:
 * this mirrors the backend switch-away backfill and avoids copying shared auth
 * material into the provider row. DB snapshots and presets must keep their
 * normal auth-first precedence.
 */
const reconcileCodexLiveAuth = (
  liveSettings: Record<string, unknown>,
  storedSettings: Record<string, unknown> | null,
  category: string | undefined,
): Record<string, unknown> => {
  if (category === "official") return liveSettings;
  const configText =
    typeof liveSettings.config === "string" ? liveSettings.config : "";
  const bearer = extractCodexExperimentalBearerToken(configText);
  if (!bearer) return liveSettings;
  const storedAuth = asRecord(storedSettings?.auth);
  const authTemplate = storedAuth ?? asRecord(liveSettings.auth) ?? {};
  const hasProviderApiKey =
    typeof authTemplate.OPENAI_API_KEY === "string" &&
    authTemplate.OPENAI_API_KEY.trim().length > 0;
  const hasOauthLogin = Object.entries(authTemplate).some(
    ([key, value]) =>
      key !== "auth_mode" && key !== "OPENAI_API_KEY" && hasAuthMaterial(value),
  );
  // Match should_restore_codex_provider_token_for_backfill: an OAuth-only
  // provider must not be silently converted into an API-key provider.
  if (hasOauthLogin && !hasProviderApiKey) return liveSettings;
  return {
    ...liveSettings,
    auth: {
      ...authTemplate,
      OPENAI_API_KEY: bearer,
    },
  };
};

export function EditProviderDialog({
  open,
  provider,
  onOpenChange,
  onSubmit,
  appId,
  isProxyTakeover = false,
  isCurrent = false,
  modeView,
  target = LOCAL_MANAGEMENT_TARGET,
}: EditProviderDialogProps) {
  const { t } = useTranslation();
  // 远端编辑器投影由 helper 提供；旧 helper 没有该能力时退回库里那一行，不报底层错误。
  const isRemoteTarget = target.type === "remote";
  const usesRemoteEditorView = useTargetCapability(
    target,
    "provider-editor",
    usesEditorView(appId),
  );
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  // 表单用了聚合的简化布局：页头应用名后标「聚合模式」
  const [stackLayout, setStackLayout] = useState(false);
  const [authSettingsTarget, setAuthSettingsTarget] =
    useState<ManagedAuthProvider | null>(null);

  useEffect(() => {
    setAuthSettingsTarget(null);
  }, [appId, open, provider?.id]);

  const formReadyToken = useMemo(
    () => Symbol("provider-form-ready"),
    [appId, open, provider?.id],
  );
  const currentFormReadyToken = useRef(formReadyToken);
  currentFormReadyToken.current = formReadyToken;
  const [formReadyState, setFormReadyState] = useState({
    token: formReadyToken,
    ready: appId !== "pi",
  });
  const isFormReady =
    formReadyState.token === formReadyToken
      ? formReadyState.ready
      : appId !== "pi";
  const handleSubmitReadyChange = useCallback(
    (ready: boolean) => {
      if (currentFormReadyToken.current === formReadyToken) {
        setFormReadyState({ token: formReadyToken, ready });
      }
    },
    [formReadyToken],
  );

  // 默认使用传入的 provider.settingsConfig，若当前编辑对象是"当前生效供应商"，则尝试读取实时配置替换初始值
  const [liveSettings, setLiveSettings] = useState<Record<
    string,
    unknown
  > | null>(null);

  // 使用 ref 标记是否已经加载过，防止重复读取覆盖用户编辑
  const [hasLoadedLive, setHasLoadedLive] = useState(false);

  // Claude：底部 JSON 显示「切到这个供应商之后 settings.json 的样子」，保存时拿它做三方比较。
  const [editorView, setEditorView] = useState<ProviderEditorView | null>(null);
  const { submitWithConflictRetry, conflictDialog } = useLiveEditConflict();

  const closeDialog = useCallback(() => {
    setAuthSettingsTarget(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const handlePanelClose = useCallback(() => {
    if (authSettingsTarget) {
      setAuthSettingsTarget(null);
      return;
    }
    closeDialog();
  }, [authSettingsTarget, closeDialog]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!open || !provider) {
        setLiveSettings(null);
        setEditorView(null);
        setHasLoadedLive(false);
        return;
      }

      // 关键修复：只在首次打开时加载一次
      if (hasLoadedLive) {
        return;
      }

      // 切换式应用：编辑任何供应商都显示切换投影（关键字段、独有字段来自这一行，其余
      // 来自 live），代理模式下也一样 —— 投影用的是这一行自己的值，不是接管后的代理契约，
      // 所以代理接管时也要读（v4 行为）。远端需要 helper 广告 provider-editor；没有能力
      // 时退回库里那一行 SSOT，不把本机 live 配置混进远端编辑。
      if (usesEditorView(appId) && (!isRemoteTarget || usesRemoteEditorView)) {
        try {
          const view = await providersApi.getEditorView(
            appId,
            asRecord(provider.settingsConfig) ?? {},
            provider.category,
            provider.id,
            target,
          );
          if (!cancelled) {
            setEditorView(view);
            setLiveSettings(view.settings);
          }
        } catch (error) {
          // 读不了配置文件（比如手改坏了）：退回显示保存的供应商配置。
          if (!cancelled) {
            setEditorView(null);
            setLiveSettings(null);
            toastEditorViewFailed(t, error);
          }
        } finally {
          if (!cancelled) {
            setHasLoadedLive(true);
          }
        }
        return;
      }

      // 远端目标没有可读的本机 live 配置：直接回退到库里那一行 SSOT
      if (isRemoteTarget) {
        if (!cancelled) {
          setLiveSettings(null);
          setEditorView(null);
          setHasLoadedLive(true);
        }
        return;
      }

      // 代理接管模式：Live 配置已被代理改写，读取 live 会导致编辑界面展示代理地址/占位符等内容
      // 因此直接回退到 SSOT（数据库）配置，避免用户困惑与误保存
      if (isProxyTakeover) {
        if (!cancelled) {
          setLiveSettings(null);
          setHasLoadedLive(true);
        }
        return;
      }

      // OpenCode uses additive mode, while Pi's shared models.json is owned by
      // the catalog coordinator. Neither has a per-provider generic live
      // snapshot that may replace the DB aggregate in this form.
      if (appId === "opencode" || appId === "pi" || appId === "mcode") {
        if (!cancelled) {
          setLiveSettings(null);
          setHasLoadedLive(true);
        }
        return;
      }

      if (appId === "openclaw") {
        try {
          const live = await openclawApi.getLiveProvider(provider.id);
          if (!cancelled && live && typeof live === "object") {
            setLiveSettings(live);
          } else if (!cancelled) {
            setLiveSettings(null);
          }
        } catch {
          if (!cancelled) {
            setLiveSettings(null);
          }
        } finally {
          if (!cancelled) {
            setHasLoadedLive(true);
          }
        }
        return;
      }

      try {
        const currentId = await providersApi.getCurrent(appId);
        if (currentId && provider.id === currentId) {
          try {
            const live = (await vscodeApi.getLiveProviderSettings(
              appId,
            )) as Record<string, unknown>;
            if (!cancelled && live && typeof live === "object") {
              setLiveSettings(live);
              setHasLoadedLive(true);
            }
          } catch {
            // 读取实时配置失败则回退到 SSOT（不打断编辑流程）
            if (!cancelled) {
              setLiveSettings(null);
              setHasLoadedLive(true);
            }
          }
        } else {
          if (!cancelled) {
            setLiveSettings(null);
            setHasLoadedLive(true);
          }
        }
      } finally {
        // no-op
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    provider?.id,
    appId,
    hasLoadedLive,
    isProxyTakeover,
    target,
    usesRemoteEditorView,
  ]); // 只依赖 provider.id，不依赖整个 provider 对象

  const initialSettingsConfig = useMemo(() => {
    const storedSettings = asRecord(provider?.settingsConfig);
    const base =
      appId === "codex" && liveSettings
        ? reconcileCodexLiveAuth(
            liveSettings,
            storedSettings,
            provider?.category,
          )
        : (liveSettings ?? storedSettings ?? {});

    // Codex 的 modelCatalog 是 cc-switch 私有字段，SSOT 在数据库。Live 的 config.toml
    // 仅在写入时投影出 model_catalog_json 指针；Codex.app 改写配置、代理接管/恢复周期、
    // 来回切换供应商都可能让 Live 丢失该投影，从而 read_live_settings 反解为空。
    // 若放任 Live 覆盖，编辑界面会显示空映射表，保存后连同数据库里的映射一起清空（数据丢失）。
    // 因此始终以数据库 SSOT 的 modelCatalog 为准，仅在数据库确实没有时才回退到 Live 反解结果。
    if (
      appId === "codex" &&
      liveSettings &&
      provider?.settingsConfig &&
      typeof provider.settingsConfig === "object"
    ) {
      const dbCatalog = (provider.settingsConfig as Record<string, unknown>)
        .modelCatalog;
      if (dbCatalog !== undefined) {
        return { ...base, modelCatalog: dbCatalog };
      }
    }

    return base;
  }, [liveSettings, provider?.settingsConfig, provider?.category, appId]); // 只依赖表单初始化所需字段，不依赖整个 provider

  // 固定 initialData，防止 provider 对象更新时重置表单
  const initialData = useMemo(() => {
    if (!provider) return null;
    // 远端：展示前把密钥换成 `[redacted]`，同时把未脱敏的原值留在
    // secretReferenceConfig 里供校验/占位提示使用（不上屏）。
    const settingsConfig =
      target.type === "remote"
        ? hideRemoteProviderConfigSecretsForDisplay(
            appId,
            initialSettingsConfig,
          )
        : initialSettingsConfig;
    return {
      name: provider.name,
      notes: provider.notes,
      websiteUrl: provider.websiteUrl,
      settingsConfig,
      secretReferenceConfig:
        target.type === "remote" ? initialSettingsConfig : undefined,
      category: provider.category,
      meta: provider.meta,
      icon: provider.icon,
      iconColor: provider.iconColor,
    };
  }, [
    open, // 修复：编辑保存后再次打开显示旧数据，依赖 open 确保每次打开时重新读取最新 provider 数据
    provider?.id, // 只依赖 ID，provider 对象更新不会触发重新计算
    provider?.meta, // 供应商元数据变化时重新初始化表单
    initialSettingsConfig,
    target.type,
    appId,
  ]);

  const handleSubmit = useCallback(
    async (values: ProviderFormValues) => {
      if (!provider) return;

      // 注意：values.settingsConfig 已经是最终的配置字符串
      // ProviderForm 已经为不同的 app 类型（Claude/Codex/Gemini）正确组装了配置
      const parsedConfig = JSON.parse(values.settingsConfig) as Record<
        string,
        unknown
      >;
      const nextProviderId =
        (appId === "opencode" || appId === "openclaw" || appId === "pi") &&
        values.providerKey?.trim()
          ? values.providerKey.trim()
          : provider.id;

      const updatedProvider: Provider = {
        ...provider,
        id: nextProviderId,
        name: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        websiteUrl: values.websiteUrl?.trim() || undefined,
        settingsConfig:
          target.type === "remote"
            ? restoreRemoteProviderConfigSecretsForSubmit(
                appId,
                initialSettingsConfig,
                parsedConfig,
              )
            : parsedConfig,
        icon: values.icon?.trim() || undefined,
        iconColor: values.iconColor?.trim() || undefined,
        ...(values.presetCategory ? { category: values.presetCategory } : {}),
        // 保留或更新 meta 字段
        ...(values.meta ? { meta: values.meta } : {}),
      };

      const submit = async (onConflict: EditorConflictPolicy) => {
        await onSubmit({
          provider: updatedProvider,
          originalId: provider.id,
          ...(editorView
            ? { editorSave: { base: editorView.settings, onConflict } }
            : {}),
        });
        closeDialog();
      };
      await submitWithConflictRetry(submit);
    },
    [
      appId,
      onSubmit,
      closeDialog,
      provider,
      editorView,
      submitWithConflictRetry,
      initialSettingsConfig,
      target.type,
    ],
  );

  if (!provider || !initialData) {
    return null;
  }

  const waitingForEditorView = usesEditorView(appId) && !hasLoadedLive;

  const liveFile = !isProxyTakeover ? LIVE_FILE[appId] : undefined;
  const currentNotice =
    isCurrent && SWITCH_APPS.includes(appId) ? (
      <Notice
        tone="neutral"
        title={
          liveFile ? (
            <>
              {t("provider.editCurrentNoticeFile")}{" "}
              <code className="font-mono text-caption">{liveFile}</code>
              {t("provider.editCurrentNoticeFileEnd")}
            </>
          ) : (
            t("provider.editCurrentNotice")
          )
        }
      />
    ) : null;

  return (
    <FullScreenPanel
      isOpen={open}
      trackUnsavedChanges
      title={t("provider.editProviderNamed", { name: provider.name })}
      subtitle={
        stackLayout
          ? t("provider.formSubtitleStack", {
              app: APP_DISPLAY_NAME[appId],
              defaultValue: "{{app}}（聚合模式）",
            })
          : APP_DISPLAY_NAME[appId]
      }
      backLabel={t("provider.backToList")}
      onClose={handlePanelClose}
      contentClassName={appId === "pi" ? "pb-0 pt-4" : "pt-4"}
      footer={
        <>
          <Button
            type="button"
            variant="neutral"
            size="regular"
            onClick={closeDialog}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="provider-form"
            variant="solid"
            size="regular"
            disabled={isFormSubmitting || !isFormReady}
          >
            {isFormSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("common.save")}
          </Button>
        </>
      }
    >
      {currentNotice}
      {waitingForEditorView ? (
        <div className="py-12 text-center text-body text-fg-2">
          {t("common.loading")}
        </div>
      ) : (
        <ProviderForm
          appId={appId}
          providerId={provider.id}
          submitLabel={t("common.save")}
          onSubmit={handleSubmit}
          onCancel={closeDialog}
          onManageAuthAccounts={
            target.type === "local" ? setAuthSettingsTarget : undefined
          }
          onSubmittingChange={setIsFormSubmitting}
          onSubmitReadyChange={handleSubmitReadyChange}
          initialData={initialData}
          target={target}
          showButtons={false}
          isProxyTakeover={isProxyTakeover}
          inactiveFields={editorView?.inactive}
          modeView={modeView}
          onStackLayoutChange={setStackLayout}
        />
      )}
      {conflictDialog}
      <AuthSettingsPanel
        target={authSettingsTarget}
        onClose={() => setAuthSettingsTarget(null)}
      />
    </FullScreenPanel>
  );
}
