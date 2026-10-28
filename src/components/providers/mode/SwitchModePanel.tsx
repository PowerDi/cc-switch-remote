import { createPortal } from "react-dom";
import { badgeVariants } from "@/components/ui/badge";
import { HoverTip } from "@/components/ui/hover-tip";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import type { Provider } from "@/types";
import type { AppMode, StartupAttachFailure } from "@/types/proxy";
import type { ManagementTarget } from "@/lib/api/remote";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";
import { getManagementTargetKey } from "@/lib/managementTarget";
import { useTargetCapabilityState } from "@/hooks/useTargetCapability";
import type { ModeAppId } from "@/config/appConfig";
import { isProxyAppId, isStackAppId } from "@/config/appConfig";
import { settingsApi } from "@/lib/api";
import { providersApi } from "@/lib/api/providers";
import { proxyApi } from "@/lib/api/proxy";
import {
  proxyKeys,
  useAdoptCodexStackCatalog,
  useAppMode,
  useProxyStack,
  useProxyStatusQuery,
  useSetProxyStackMember,
} from "@/lib/query/proxy";
import {
  useAddToFailoverQueue,
  useAutoFailoverEnabled,
  useFailoverQueue,
  useRemoveFromFailoverQueue,
  useSetAutoFailoverEnabled,
} from "@/lib/query/failover";
import { useModeActions } from "@/hooks/useModeActions";
import { getRoutingReason } from "@/utils/routingReason";
import { CODEX_OFFICIAL_PROVIDER_ID } from "@/utils/providerCapabilities";
import { routeSwitchNotification } from "@/utils/routeSwitchNotification";
import { extractErrorMessage } from "@/utils/errorUtils";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderList } from "@/components/providers/ProviderList";
import { CodexStaleClientsNotice } from "@/components/providers/CodexStaleClientsNotice";
import {
  blockedFromRouting,
  queueMoveSortUpdates,
} from "@/components/providers/presentation";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { ModeTabs, MODE_TONE } from "./ModeTabs";
import { ModeDialog, type ModeDialogState } from "./ModeDialog";
import {
  sameStackSubagent,
  stackSubagentSettings,
  stackSubagentValue,
  type StackSubagentValue,
} from "./StackSubagentFields";
import { RouteSettingsSheet } from "./RouteSettingsSheet";
import { StackSettingsSheet } from "./StackSettingsSheet";
import { useDesktopConfigMessages } from "./useDesktopConfigMessages";

type ListCallbacks = Pick<
  React.ComponentProps<typeof ProviderList>,
  | "onEdit"
  | "onDelete"
  | "onDuplicate"
  | "onConfigureUsage"
  | "onOpenWebsite"
  | "onOpenTerminal"
  | "onCreate"
  | "searchOpen"
  | "onSearchOpenChange"
>;

interface SwitchModePanelProps extends ListCallbacks {
  app: ModeAppId;
  target?: ManagementTarget;
  statusSlot?: HTMLDivElement | null;
  providers: Record<string, Provider>;
  currentProviderId: string;
  isLoading: boolean;
  scrollRef?: RefObject<HTMLDivElement>;
  onSwitch: (
    provider: Provider,
    options?: { acknowledgedRouting?: boolean },
  ) => unknown;
  onOpenRoutingSettings: () => void;
  startupFailure?: StartupAttachFailure;
  onDismissStartupFailure?: () => void;
  /** 托盘里点了直连下需要路由的那家：到这页后弹同一个「需要路由」对话框 */
  needsRouteRequest?: { providerId: string; nonce: number };
  onNeedsRouteHandled?: () => void;
  /** 正在看的那格变了：新增 / 编辑供应商按它选表单布局。需要是稳定的回调 */
  onViewChange?: (app: ModeAppId, view: AppMode) => void;
}

/** Gemini CLI、Grok Build、Claude Desktop 没有聚合模式（Q6）：那一格隐藏，前两格位置不变。 */
const modesFor = (app: ModeAppId): AppMode[] =>
  isStackAppId(app) ? ["direct", "route", "stack"] : ["direct", "route"];

/**
 * 切换式应用的供应商页（v7 S1–S3）：模式行 → 通知槽 → 按查看的模式分区的列表。
 * tab 只负责查看；要生效必须点写明后果的按钮（确认框），回到直连也一样。
 */
export function SwitchModePanel({
  statusSlot,
  app,
  providers,
  currentProviderId,
  isLoading,
  scrollRef,
  onSwitch,
  onOpenRoutingSettings,
  startupFailure,
  onDismissStartupFailure,
  needsRouteRequest,
  onNeedsRouteHandled,
  onViewChange,
  target = LOCAL_MANAGEMENT_TARGET,
  ...listCallbacks
}: SwitchModePanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const appName = APP_DISPLAY_NAME[app];
  const modes = modesFor(app);
  const targetKey = getManagementTargetKey(target);
  const appModeCapability = useTargetCapabilityState(target, "app-mode");
  const appModeSupported = appModeCapability.supported;

  // 能力未知/不支持时先不查：旧 helper 不该收到任何模式命令
  const { data: modeView } = useAppMode(app, appModeSupported, target);
  const active: AppMode =
    modeView && modes.includes(modeView.mode) ? modeView.mode : "direct";
  const directId = modeView?.directProviderId ?? null;
  const routeId = modeView?.routeProviderId ?? null;

  // 离开页面再回来、或生效的模式变了，一律落在生效的那格（「查看中」不持久化）
  const [view, setView] = useState<AppMode>(active);
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setView(active);
  }, [app, active]);
  useEffect(() => {
    onViewChange?.(app, view);
  }, [app, view, onViewChange]);

  const { data: proxyStatus } = useProxyStatusQuery(target);
  const serviceRunning = proxyStatus?.running ?? false;
  const { data: settings } = useQuery({
    queryKey: ["settings", targetKey],
    queryFn: () => settingsApi.get(target),
  });
  const hasFailover = isProxyAppId(app);
  const { data: failoverOn = false } = useAutoFailoverEnabled(
    app,
    target,
    hasFailover,
  );
  const { data: queue } = useFailoverQueue(app, target, hasFailover);
  const setFailover = useSetAutoFailoverEnabled(target);
  const addToQueue = useAddToFailoverQueue(target);
  const removeFromQueue = useRemoveFromFailoverQueue(target);
  const { data: stack } = useProxyStack(
    app,
    appModeSupported && isStackAppId(app),
    target,
  );
  const setStackMember = useSetProxyStackMember(target);
  const adoptCatalog = useAdoptCodexStackCatalog(target);
  const modeActions = useModeActions(app, target);
  const desktopMessages = useDesktopConfigMessages(
    target.type === "local" && app === "claude-desktop",
  );

  const [dialog, setDialog] = useState<ModeDialogState | null>(null);
  const [routeSettingsOpen, setRouteSettingsOpen] = useState(false);
  const [stackSettingsOpen, setStackSettingsOpen] = useState(false);
  const [confirmFailover, setConfirmFailover] = useState(false);
  // 关掉的是哪一份提示（后端的 staleRevision）：目录或登录又变了就是新的一份，重新显示。
  const [staleDismissed, setStaleDismissed] = useState<string | null>(null);
  useEffect(() => {
    setStaleDismissed(null);
  }, [app, active, directId, routeId, stack?.staleClients?.auth]);
  const staleRevision = stack?.staleRevision ?? "";

  // 供应商还没加载完时先等着，到了再弹
  useEffect(() => {
    if (!needsRouteRequest) return;
    const provider = providers[needsRouteRequest.providerId];
    if (!provider) return;
    setDialog({
      kind: "needsRoute",
      providerId: provider.id,
      reason: getRoutingReason(app, provider, t) ?? "",
    });
    onNeedsRouteHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRouteRequest?.nonce, providers]);

  const providerList = useMemo(() => Object.values(providers), [providers]);
  const nameOf = (id: string | null) =>
    (id && providers[id]?.name) || t("mode.noProvider");

  const stackMembers = useMemo(() => {
    const members = new Map<string, number>();
    for (const member of stack?.members ?? []) {
      members.set(member.providerId, member.modelIds.length);
    }
    return members;
  }, [stack?.members]);

  const queueIds = useMemo(
    () => (queue ?? []).map((item) => item.providerId),
    [queue],
  );

  const exitAndUse = (provider: Provider) =>
    setDialog({ kind: "exit", useProviderId: provider.id });

  const queueMove = async (provider: Provider, delta: -1 | 1) => {
    const updates = queueMoveSortUpdates(
      queue ?? [],
      providers,
      provider.id,
      delta,
    );
    if (!updates) return;
    const dropIndex = updates.findIndex((update) => update.id === provider.id);
    try {
      await providersApi.updateSortOrder(updates, app, target);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["failoverQueue", app] }),
        queryClient.invalidateQueries({ queryKey: ["providers", app] }),
      ]);
      toast.success(
        t("mode.queueMoved", { name: provider.name, position: dropIndex + 1 }),
      );
    } catch (error) {
      toast.error(extractErrorMessage(error) || t("provider.sortUpdateFailed"));
    }
  };

  const rememberDefault = async (provider: Provider) => {
    try {
      const result = await proxyApi.setProxyRoute(app, provider.id, target);
      await queryClient.invalidateQueries({ queryKey: ["providers", app] });
      toast.success(routeSwitchNotification(result, app, provider.name, t), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(
        t("mode.toast.failed", {
          detail: extractErrorMessage(error) || t("common.unknown"),
        }),
      );
    }
  };

  const switchMode = {
    active,
    view,
    directId,
    routeId,
    failoverOn,
    queue: queueIds,
    stackMembers,
    serviceRunning,
    routingReason: (provider: Provider) =>
      getRoutingReason(app, provider, t) ?? "",
    actions: {
      switchDirect: (provider: Provider) => void onSwitch(provider),
      needsRouteDialog: (provider: Provider) =>
        setDialog({
          kind: "needsRoute",
          providerId: provider.id,
          reason: getRoutingReason(app, provider, t) ?? "",
        }),
      exitAndUse,
      routeTo: (provider: Provider) => void onSwitch(provider),
      queueAdd: (provider: Provider) =>
        addToQueue.mutate({ appType: app, providerId: provider.id }),
      queueRemove: (provider: Provider) =>
        removeFromQueue.mutate({ appType: app, providerId: provider.id }),
      queueMove: (provider: Provider, delta: -1 | 1) =>
        void queueMove(provider, delta),
      stackAdd: (provider: Provider) => {
        setStackMember.mutate({
          appType: app,
          providerId: provider.id,
          enabled: true,
        });
      },
      stackRemove: (provider: Provider) => {
        setStackMember.mutate({
          appType: app,
          providerId: provider.id,
          enabled: false,
        });
      },
      // 聚合生效时换默认当场生效（同切换供应商）；没生效时只记下选择，切换时的确认框预选它
      stackSetDefault: (provider: Provider) =>
        active === "stack"
          ? void onSwitch(provider)
          : void rememberDefault(provider),
    },
  };

  // 页头始终显示实际生效的连接，不跟随正在浏览的模式页签。
  const routeTarget = failoverOn ? t("mode.status.byQueue") : nameOf(routeId);
  const otherMembers = (stack?.members ?? []).filter(
    (member) => member.providerId !== routeId,
  );
  const otherModels = otherMembers.reduce(
    (sum, member) => sum + member.modelIds.length,
    0,
  );
  const status =
    active === "direct"
      ? { lead: t("mode.status.directLead"), value: nameOf(directId) }
      : active === "route"
        ? {
            lead: t("mode.status.routeLead"),
            value: routeTarget,
          }
        : {
            lead: t("mode.status.stackLead"),
            value: t("mode.status.stackValue", {
              name: nameOf(routeId),
              count: otherMembers.length,
              models: otherModels,
            }),
          };

  const handleFailoverChange = (enabled: boolean) => {
    if (enabled && !settings?.failoverConfirmed) {
      setConfirmFailover(true);
      return;
    }
    setFailover.mutate({ appType: app, enabled });
  };

  const confirmFailoverOn = async () => {
    setConfirmFailover(false);
    try {
      const current = await settingsApi.get(target);
      await settingsApi.saveForTarget(
        {
          ...current,
          failoverConfirmed: true,
        },
        target,
      );
      await queryClient.invalidateQueries({
        queryKey: ["settings", targetKey],
      });
    } catch (error) {
      console.error(
        "[SwitchModePanel] Failed to save failover confirmation",
        error,
      );
    }
    setFailover.mutate({ appType: app, enabled: true });
  };

  const enterMode = async (
    mode: Exclude<AppMode, "direct">,
    pick: string,
    subagent?: StackSubagentValue,
  ) => {
    if (
      subagent &&
      !sameStackSubagent(subagent, stackSubagentValue(settings))
    ) {
      const current = await settingsApi.get(target);
      await settingsApi.saveForTarget(
        { ...current, ...stackSubagentSettings(subagent) },
        target,
      );
      await queryClient.invalidateQueries({
        queryKey: ["settings", targetKey],
      });
    }
    await modeActions.enter(mode, pick, providers[pick]?.name);
  };

  const eligibleIds = providerList
    .filter((provider) => !blockedFromRouting(app, provider))
    .map((provider) => provider.id);

  const startService = async () => {
    try {
      await proxyApi.startProxyServer(target);
      await queryClient.invalidateQueries({
        queryKey: proxyKeys.status(target),
      });
    } catch (error) {
      toast.error(
        t("proxy.server.startFailed", {
          detail: extractErrorMessage(error) || t("common.unknown"),
        }),
      );
    }
  };

  const notices: React.ReactNode[] = [];
  if (active !== "direct" && proxyStatus !== undefined && !serviceRunning) {
    notices.push(
      <Notice
        key="broken"
        tone="warning"
        title={t("mode.notice.serviceDown", {
          app: appName,
          mode: t(`mode.names.${active}`),
        })}
        actions={
          <>
            <Button
              variant="neutral"
              size="compact"
              onClick={() => void startService()}
            >
              {t("mode.notice.startService")}
            </Button>
            <Button
              variant="neutral"
              size="compact"
              onClick={() => setDialog({ kind: "exit" })}
            >
              {t("mode.notice.backToDirect")}
            </Button>
          </>
        }
      />,
    );
  }
  if (desktopMessages.length > 0) {
    notices.push(
      <Notice
        key="desktopConfig"
        tone="warning"
        title={t("claudeDesktop.statusTitle")}
      >
        {desktopMessages.map((message) => (
          <span key={message} className="block">
            {message}
          </span>
        ))}
      </Notice>,
    );
  }
  if (startupFailure) {
    notices.push(
      <Notice
        key="startup"
        tone="warning"
        title={t("mode.notice.attachFailed", {
          app: appName,
          mode: t(`mode.names.${startupFailure.stack ? "stack" : "route"}`),
        })}
        onDismiss={onDismissStartupFailure}
        dismissLabel={t("common.close")}
        actions={
          <Button
            variant="neutral"
            size="compact"
            onClick={() =>
              void modeActions
                .enter(
                  startupFailure.stack ? "stack" : "route",
                  routeId,
                  nameOf(routeId),
                )
                .then(() => onDismissStartupFailure?.())
                .catch((error) =>
                  toast.error(
                    t("mode.toast.failed", {
                      detail: extractErrorMessage(error) || t("common.unknown"),
                    }),
                  ),
                )
            }
          >
            {t("common.retry")}
          </Button>
        }
      >
        {startupFailure.error}
      </Notice>,
    );
  }
  if (view === "stack" && active === "stack" && stack?.notice) {
    notices.push(
      <Notice
        key="stackNotice"
        tone="warning"
        title={t(`provider.${stack.notice}`)}
        actions={
          stack.notice === "routeOwnsCatalog" ? (
            <Button
              variant="neutral"
              size="compact"
              disabled={adoptCatalog.isPending}
              onClick={() => adoptCatalog.mutate()}
            >
              {t("provider.adoptCatalog")}
            </Button>
          ) : undefined
        }
      >
        {stack.noticeReasons?.length
          ? stack.noticeReasons.map((reason) => (
              <div key={reason}>
                {t(`provider.officialModelsReason.${reason}`)}
              </div>
            ))
          : undefined}
      </Notice>,
    );
  }
  if (
    app === "codex" &&
    stack?.staleClients &&
    (stack.staleClients.daemon || stack.staleClients.others) &&
    staleDismissed !== staleRevision
  ) {
    notices.push(
      <CodexStaleClientsNotice
        key="stale"
        staleClients={stack.staleClients}
        target={target}
        onDismiss={() => setStaleDismissed(staleRevision)}
      />,
    );
  }
  if (view !== active) {
    const cta =
      view === "route"
        ? t("mode.activate.route")
        : view === "stack"
          ? t("mode.activate.stack")
          : t("mode.activate.direct");
    notices.push(
      <Notice
        key="activate"
        tone="neutral"
        title={t("mode.activate.viewing", {
          view: t(`mode.names.${view}`),
          app: appName,
          active: t(`mode.names.${active}`),
        })}
        actions={
          <Button
            variant={view}
            size="regular"
            disabled={modeActions.pending}
            onClick={() =>
              setDialog(
                view === "direct"
                  ? { kind: "exit" }
                  : { kind: "enter", target: view },
              )
            }
          >
            {cta}
          </Button>
        }
      />,
    );
  }

  // Keep the list usable; only a successful status response can prove that
  // an installed helper lacks app-mode. Loading/transport errors are separate.
  if (!appModeSupported) {
    return (
      <>
        <div
          className="px-4 pb-3 text-sm text-fg-2"
          role={appModeCapability.state === "loading" ? undefined : "status"}
          aria-live="polite"
        >
          {appModeCapability.state === "loading"
            ? t("remote.settings.routing.appModeChecking")
            : appModeCapability.state === "error"
              ? t("remote.settings.routing.appModeCheckFailed", {
                  error:
                    appModeCapability.error ??
                    t("remote.settings.routing.appModeCheckUnavailable"),
                })
              : t("remote.settings.routing.appModeUnsupported", {
                  defaultValue:
                    "当前远程 Helper 不支持按应用切换直连 / 路由 / 聚合模式。请更新到包含 app-mode capability 的新版 Helper。",
                })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-2"
            disabled={appModeCapability.isFetching}
            onClick={() => void appModeCapability.refetch()}
          >
            {t("common.refresh")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-stable overflow-x-hidden px-6 pb-12">
          <ProviderList
            {...listCallbacks}
            providers={providers}
            currentProviderId={currentProviderId}
            appId={app}
            target={target}
            isLoading={isLoading}
            onSwitch={(provider) => void onSwitch(provider)}
            switchMode={switchMode}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {statusSlot &&
        createPortal(
          <HoverTip content={`${status.lead} ${status.value}`}>
            <span
              tabIndex={0}
              aria-label={`${status.lead} ${status.value}`}
              className={cn(
                badgeVariants({ variant: "outline" }),
                "max-w-full gap-1 border-border bg-surface px-2.5 py-1 text-body font-normal",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "me-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  (
                    active === "direct"
                      ? Boolean(directId && providers[directId])
                      : serviceRunning &&
                        modeView?.attached &&
                        Boolean(routeId && providers[routeId])
                  )
                    ? MODE_TONE[active].dot
                    : "bg-fg-3",
                )}
              />
              <span className="shrink-0 text-fg-2">
                {t(`mode.names.${active}`)}
              </span>
              <span aria-hidden="true" className="text-fg-3">
                ·
              </span>
              <span className="min-w-0 truncate font-medium text-fg-1">
                {active === "stack" ? nameOf(routeId) : status.value}
              </span>
            </span>
          </HoverTip>,
          statusSlot,
        )}
      <ModeTabs
        modes={modes}
        active={active}
        view={view}
        onView={setView}
        failover={
          hasFailover && view === "route" && active === "route"
            ? {
                enabled: failoverOn,
                disabled: setFailover.isPending,
                onChange: handleFailoverChange,
              }
            : undefined
        }
        onOpenRouteSettings={
          hasFailover && view === "route" && active === "route"
            ? () => setRouteSettingsOpen(true)
            : undefined
        }
        onOpenStackSettings={
          app === "codex" && view === "stack" && active === "stack"
            ? () => setStackSettingsOpen(true)
            : undefined
        }
        searchSlotRef={setSearchSlot}
      />
      <div
        ref={scrollRef}
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable overflow-x-hidden px-6 pb-12 pt-3"
      >
        {notices.length > 0 && (
          <div role="status" className="mb-3 flex flex-col gap-2">
            {notices}
          </div>
        )}
        <ProviderList
          {...listCallbacks}
          providers={providers}
          currentProviderId={currentProviderId}
          appId={app}
          target={target}
          isLoading={isLoading}
          onSwitch={(provider) => void onSwitch(provider)}
          switchMode={switchMode}
          searchSlot={searchSlot}
        />
      </div>

      <ModeDialog
        app={app}
        state={dialog}
        active={active}
        providers={providerList}
        directId={directId}
        eligibleIds={eligibleIds}
        defaultPick={routeId ?? directId}
        stackMembers={(stack?.members ?? []).map((member) => ({
          id: member.providerId,
          name: nameOf(member.providerId),
          models: member.memberModels,
        }))}
        stackSubagent={
          app === "codex" && settings
            ? {
                models: stack?.subagentModels ?? [],
                value: stackSubagentValue(settings),
              }
            : undefined
        }
        onClose={() => setDialog(null)}
        onEnter={enterMode}
        onExit={(useProviderId) =>
          modeActions.exitToDirect({
            directProviderId: directId,
            useProviderId,
            providerName: nameOf(useProviderId ?? directId),
          })
        }
        onSwitchDirect={(providerId) => {
          const provider = providers[providerId];
          if (provider) void onSwitch(provider, { acknowledgedRouting: true });
        }}
      />

      {isProxyAppId(app) && (
        <RouteSettingsSheet
          target={target}
          app={app}
          open={routeSettingsOpen}
          onOpenChange={setRouteSettingsOpen}
          onOpenSettings={onOpenRoutingSettings}
        />
      )}

      {app === "codex" && (
        <StackSettingsSheet
          target={target}
          open={stackSettingsOpen}
          onOpenChange={setStackSettingsOpen}
          // 默认那家不发布 `ccs-*` 模型
          models={(stack?.subagentModels ?? []).filter(
            (model) => model.providerId !== routeId,
          )}
          // 官方做默认那家时，合并目录里有官方的 codex-auto-review，自动审批默认用它
          routeOfficial={
            !!routeId &&
            (routeId === CODEX_OFFICIAL_PROVIDER_ID ||
              providers[routeId]?.category === "official")
          }
        />
      )}

      <ConfirmDialog
        isOpen={confirmFailover}
        variant="info"
        title={t("confirm.failover.title")}
        message={t("confirm.failover.message")}
        confirmText={t("confirm.failover.confirm")}
        onConfirm={() => void confirmFailoverOn()}
        onCancel={() => setConfirmFailover(false)}
      />
    </>
  );
}
