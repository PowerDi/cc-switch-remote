import { useEffect, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import type { Provider } from "@/types";
import type { AppMode, StartupAttachFailure } from "@/types/proxy";
import type { ManagementTarget } from "@/lib/api/remote";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";
import { getManagementTargetKey } from "@/lib/managementTarget";
import { useTargetCapability } from "@/hooks/useTargetCapability";
import type { ProxyAppId } from "@/config/appConfig";
import { isStackAppId } from "@/config/appConfig";
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
import { extractErrorMessage } from "@/utils/errorUtils";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderList } from "@/components/providers/ProviderList";
import { CodexStaleClientsNotice } from "@/components/providers/CodexStaleClientsNotice";
import { blockedFromRouting } from "@/components/providers/presentation";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { ModeTabs } from "./ModeTabs";
import { ModeDialog, type ModeDialogState } from "./ModeDialog";
import { RouteSettingsSheet } from "./RouteSettingsSheet";

type ListCallbacks = Pick<
  React.ComponentProps<typeof ProviderList>,
  | "onEdit"
  | "onDelete"
  | "onDuplicate"
  | "onConfigureUsage"
  | "onOpenWebsite"
  | "onOpenTerminal"
  | "onCreate"
>;

interface SwitchModePanelProps extends ListCallbacks {
  app: ProxyAppId;
  /** 管理目标：默认本机；远端目标时模式行读写该主机的模式状态（helper app-mode） */
  target?: ManagementTarget;
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
  onViewChange?: (app: ProxyAppId, view: AppMode) => void;
}

/** Gemini CLI、Grok Build 没有聚合模式（Q6）：那一格隐藏，前两格位置不变。 */
const modesFor = (app: ProxyAppId): AppMode[] =>
  isStackAppId(app) ? ["direct", "route", "stack"] : ["direct", "route"];

/**
 * 切换式应用的供应商页（v7 S1–S3）：模式行 → 通知槽 → 按查看的模式分区的列表。
 * tab 只负责查看；要生效必须点写明后果的按钮（确认框），回到直连一步完成、可撤销。
 */
export function SwitchModePanel({
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
  // 旧 helper 没有 mode 命令：如实说明，不给点了必然失败的模式行
  const appModeSupported = useTargetCapability(target, "app-mode");

  // 能力未知/不支持时先不查：旧 helper 不该收到任何模式命令
  const { data: modeView } = useAppMode(app, appModeSupported, target);
  const active: AppMode =
    modeView && modes.includes(modeView.mode) ? modeView.mode : "direct";
  const directId = modeView?.directProviderId ?? null;
  const routeId = modeView?.routeProviderId ?? null;

  // 离开页面再回来、或生效的模式变了，一律落在生效的那格（「查看中」不持久化）
  const [view, setView] = useState<AppMode>(active);
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
  const { data: failoverOn = false } = useAutoFailoverEnabled(app, target);
  const { data: queue } = useFailoverQueue(app, target);
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

  const [dialog, setDialog] = useState<ModeDialogState | null>(null);
  const [routeSettingsOpen, setRouteSettingsOpen] = useState(false);
  const [confirmFailover, setConfirmFailover] = useState(false);
  const [staleDismissed, setStaleDismissed] = useState(false);

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

  const previous = { mode: active, routeProviderId: routeId };

  const exitAndUse = (provider: Provider) =>
    void modeActions.exitToDirect({
      previous,
      directProviderId: directId,
      useProviderId: provider.id,
      providerName: provider.name,
    });

  const queueMove = async (provider: Provider, delta: -1 | 1) => {
    const items = queue ?? [];
    const index = items.findIndex((item) => item.providerId === provider.id);
    const dropIndex = index + delta;
    if (index < 0 || dropIndex < 0 || dropIndex >= items.length) return;
    const order = items.map((item) => item.providerId);
    order.splice(index, 1);
    order.splice(dropIndex, 0, provider.id);
    // 队列顺序就是供应商的排序：按原来占着的位置重新分配
    const slots = items
      .map(
        (item, i) =>
          item.sortIndex ?? providers[item.providerId]?.sortIndex ?? i,
      )
      .sort((a, b) => a - b);
    try {
      await providersApi.updateSortOrder(
        order.map((id, i) => ({ id, sortIndex: slots[i] })),
        app,
        target,
      );
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
      await proxyApi.setProxyRoute(app, provider.id, target);
      await queryClient.invalidateQueries({ queryKey: ["providers", app] });
      toast.success(
        t("mode.toast.defaultRemembered", { provider: provider.name }),
        { closeButton: true },
      );
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

  // 状态行：只在看生效的那格时显示；路由只写目标，不写本机地址和端口
  const routeTarget = failoverOn ? t("mode.status.byQueue") : nameOf(routeId);
  const otherMembers = (stack?.members ?? []).filter(
    (member) => member.providerId !== routeId,
  );
  const otherModels = otherMembers.reduce(
    (sum, member) => sum + member.modelIds.length,
    0,
  );
  const status =
    view !== active
      ? undefined
      : active === "direct"
        ? { lead: t("mode.status.directLead"), value: nameOf(directId) }
        : active === "route"
          ? {
              lead: t("mode.status.routeLead"),
              value: `→ ${routeTarget}`,
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

  const enterMode = async (mode: Exclude<AppMode, "direct">, pick: string) => {
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
              onClick={() =>
                void modeActions.exitToDirect({
                  previous,
                  directProviderId: directId,
                  providerName: nameOf(directId),
                })
              }
            >
              {t("mode.notice.backToDirect")}
            </Button>
          </>
        }
      />,
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
      />,
    );
  }
  if (
    view === "stack" &&
    active === "stack" &&
    app === "codex" &&
    stack?.staleClients &&
    (stack.staleClients.daemon || stack.staleClients.others) &&
    !staleDismissed
  ) {
    notices.push(
      <CodexStaleClientsNotice
        key="stale"
        staleClients={stack.staleClients}
        target={target}
        onDismiss={() => setStaleDismissed(true)}
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
              view === "direct"
                ? void modeActions.exitToDirect({
                    previous,
                    directProviderId: directId,
                    providerName: nameOf(directId),
                  })
                : setDialog({ kind: "enter", target: view })
            }
          >
            {cta}
          </Button>
        }
      />,
    );
  }

  // 旧 helper 没有 app-mode 命令：模式行换成一句说明，供应商列表照常可用
  if (!appModeSupported) {
    return (
      <>
        <div className="px-4 pb-3 text-sm text-fg-2" role="status">
          {t("remote.settings.routing.appModeUnsupported", {
            defaultValue:
              "当前远程 Helper 不支持按应用切换直连 / 路由 / 聚合模式。请更新到包含 app-mode capability 的新版 Helper。",
          })}
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
      <ModeTabs
        modes={modes}
        active={active}
        view={view}
        onView={setView}
        status={status}
        failover={
          view === "route" && active === "route"
            ? {
                enabled: failoverOn,
                disabled: setFailover.isPending,
                onChange: handleFailoverChange,
              }
            : undefined
        }
        onOpenRouteSettings={
          view === "route" && active === "route"
            ? () => setRouteSettingsOpen(true)
            : undefined
        }
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
        />
      </div>

      <ModeDialog
        app={app}
        state={dialog}
        active={active}
        providers={providerList}
        eligibleIds={eligibleIds}
        defaultPick={routeId ?? directId}
        stackMembers={(stack?.members ?? []).map((member) => ({
          id: member.providerId,
          name: nameOf(member.providerId),
          models: member.modelIds.length,
        }))}
        onClose={() => setDialog(null)}
        onEnter={enterMode}
        onSwitchDirect={(providerId) => {
          const provider = providers[providerId];
          if (provider) void onSwitch(provider, { acknowledgedRouting: true });
        }}
      />

      <RouteSettingsSheet
        app={app}
        open={routeSettingsOpen}
        onOpenChange={setRouteSettingsOpen}
        onOpenSettings={onOpenRoutingSettings}
      />

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
