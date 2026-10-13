import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Download,
  Globe,
  Loader2,
  RefreshCw,
  Server,
  ShieldAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleRow } from "@/components/ui/toggle-row";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";
import { CodexAuthSettings } from "@/components/settings/CodexAuthSettings";
import { ImportExportSection } from "@/components/settings/ImportExportSection";
import { BackupListSection } from "@/components/settings/BackupListSection";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import {
  SettingsBlock,
  SettingsCard,
} from "@/components/settings/SettingsLayout";
import { APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { APP_IDS } from "@/config/appConfig";
import { DEFAULT_VISIBLE_APPS } from "@/config/appConfig";
import type { VisibleApps } from "@/types";
import { RoutingSection } from "@/components/settings/sections/RoutingSection";
import type { SettingsFormState } from "@/hooks/useSettings";
import { AdvancedSettingsAccordion } from "@/components/settings/AdvancedSettingsAccordion";
import { RemoteDirectorySettings } from "@/components/settings/RemoteDirectorySettings";
import { WebdavSyncSection } from "@/components/settings/WebdavSyncSection";
import { LogConfigPanel } from "@/components/settings/LogConfigPanel";
import { UsageDashboard } from "@/components/usage/UsageDashboard";
import { GlobalProxySettings } from "@/components/settings/GlobalProxySettings";
import { useImportExport } from "@/hooks/useImportExport";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { useRemoteSettings } from "@/hooks/useRemoteSettings";
import { useTargetAsyncGeneration } from "@/hooks/useTargetAsyncGeneration";
import { remoteApi } from "@/lib/api";
import type { AppId } from "@/lib/api/types";
import type { ManagementTarget, RemoteHealth } from "@/lib/api";
import {
  formatRemoteCapabilitySummary,
  formatRemoteHelperBuild,
  formatRemoteHelperLatest,
  formatRemoteHelperLatestBuild,
  formatRemoteHelperUpdateError,
  formatRemoteHelperVersion,
  formatRemotePlatform,
} from "@/lib/remoteHealth";
import { extractErrorMessage } from "@/utils/errorUtils";
import type { Settings } from "@/types";
import { shouldConfirmRemoteFailoverToggle } from "@/components/settings/remoteRoutingGuards";

interface RemoteSettingsPageProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess?: () => void | Promise<void>;
  onSettingsSaved?: (settings: Settings) => void;
  onInteractionBlockedChange?: (blocked: boolean) => void;
  /** 「应用」页入口：工具环境已统一到那里（按当前管理目标执行） */
  onOpenApps?: () => void;
  /** 从路由页的「正在使用」行跳到对应应用页（与本地设置页同一个行为） */
  onOpenApp?: (app: AppId) => void;
  defaultTab?: string;
  target: Extract<ManagementTarget, { type: "remote" }>;
}

function coerceRemoteTab(tab: string | undefined): string {
  if (tab === "proxy") return "routing";
  if (tab === "data") return "advanced";
  if (tab === "about") return "environment";
  return tab === "general" ||
    tab === "advanced" ||
    tab === "environment" ||
    tab === "auth" ||
    tab === "routing" ||
    tab === "usage"
    ? tab
    : "environment";
}

export function RemoteSettingsPage({
  open,
  onImportSuccess,
  onSettingsSaved,
  onInteractionBlockedChange,
  defaultTab = "environment",
  onOpenApps,
  onOpenApp,
  target,
}: RemoteSettingsPageProps) {
  const { t } = useTranslation();
  const { capture, isCurrent, revision } = useTargetAsyncGeneration(target);
  const [activeTab, setActiveTab] = useState(coerceRemoteTab(defaultTab));

  const [health, setHealth] = useState<RemoteHealth | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [isInstallingHelper, setIsInstallingHelper] = useState(false);
  const [activeRemoteTask, setActiveRemoteTask] = useState<string | null>(null);
  const [authCenterBusy, setAuthCenterBusy] = useState(false);

  useEffect(() => {
    setHealth(null);
    setIsCheckingHealth(false);
    setIsInstallingHelper(false);
    setActiveRemoteTask(null);
    setAuthCenterBusy(false);
  }, [revision]);

  const importExport = useImportExport({ onImportSuccess, target });
  const {
    settings: remoteSettings,
    isLoading: isLoadingRemoteSettings,
    isSaving: isSavingRemoteSettings,
    activeTask: remoteSettingsTask,
    loadSettings: loadRemoteSettings,
    clearSettings: clearRemoteSettings,
    saveSettings: saveRemoteSettings,
  } = useRemoteSettings({ target, onSettingsSaved });

  const interactionBlocked =
    isCheckingHealth ||
    isInstallingHelper ||
    isLoadingRemoteSettings ||
    isSavingRemoteSettings ||
    authCenterBusy ||
    importExport.isSelectingFile ||
    importExport.isImporting ||
    importExport.isExporting;
  useEffect(() => {
    onInteractionBlockedChange?.(interactionBlocked);
    return () => onInteractionBlockedChange?.(false);
  }, [interactionBlocked, onInteractionBlockedChange]);

  const toolsCapability = health?.capabilities.includes("tools") ?? false;
  const settingsCapability = health?.capabilities.includes("settings") ?? false;
  const appConfigDirCapability =
    health?.capabilities.includes("settings-app-config-dir") ?? false;
  const importExportCapability =
    health?.capabilities.includes("import-export") ?? false;
  const cloudSyncCapability =
    health?.capabilities.includes("cloud-sync") ?? false;
  const usageCapability = health?.capabilities.includes("usage") ?? false;
  const usageManualSessionSyncCapability =
    health?.capabilities.includes("usage-manual-session-sync") ?? false;
  const usageModelPricingSyncCapability =
    health?.capabilities.includes("usage-model-pricing-sync") ?? false;
  const authCapability = health?.capabilities.includes("auth") ?? false;
  const routingCapability =
    health?.capabilities.includes("routing-config") ?? false;
  const routingRuntimeCapability =
    health?.capabilities.includes("routing-runtime") ?? false;
  const helperReady = Boolean(health?.reachable && health.helperInstalled);
  const loadHealth = useCallback(async () => {
    const generation = capture();
    setIsCheckingHealth(true);
    setActiveRemoteTask(
      t("remote.settings.tasks.checkHealth", {
        defaultValue: "正在通过 SSH 检查远程 Helper 状态...",
      }),
    );
    try {
      const result = await remoteApi.checkHealth(target.profile, target.secret);
      if (!isCurrent(generation)) return null;
      setHealth(result);
      return result;
    } catch (error) {
      if (!isCurrent(generation)) return null;
      console.error("[RemoteSettingsPage] Failed to check health", error);
      setHealth({
        reachable: false,
        helperInstalled: false,
        capabilities: [],
        lastError: extractErrorMessage(error),
      });
      return null;
    } finally {
      if (isCurrent(generation)) {
        setIsCheckingHealth(false);
        setActiveRemoteTask(null);
      }
    }
  }, [capture, isCurrent, t, target.profile, target.secret]);

  const refreshRemoteState = useCallback(async () => {
    const result = await loadHealth();
    const canLoadSettings =
      result?.reachable &&
      result.helperInstalled &&
      result.capabilities.includes("settings");
    if (canLoadSettings) {
      await loadRemoteSettings(result.capabilities.includes("skills"));
    } else {
      clearRemoteSettings();
    }
  }, [clearRemoteSettings, loadHealth, loadRemoteSettings]);

  useEffect(() => {
    if (!open) return;
    setActiveTab(coerceRemoteTab(defaultTab));
  }, [defaultTab, open]);

  useEffect(() => {
    if (!open) return;
    void refreshRemoteState();
  }, [open, refreshRemoteState]);

  const installHelper = async () => {
    const generation = capture();
    setIsInstallingHelper(true);
    setActiveRemoteTask(
      t("remote.settings.tasks.installHelper", {
        defaultValue: "正在安装远程 Helper：连接 SSH、下载二进制并验证能力...",
      }),
    );
    try {
      const result = await remoteApi.installHelper(
        target.profile,
        target.secret,
      );
      if (!isCurrent(generation)) return;
      setHealth(result);
      toast.success(
        t("remote.health.installSuccess", {
          defaultValue: "远程 Helper 已安装",
        }),
      );
    } catch (error) {
      if (!isCurrent(generation)) return;
      console.error("[RemoteSettingsPage] Failed to install helper", error);
      toast.error(
        t("remote.health.installFailed", {
          defaultValue: "安装远程 Helper 失败: {{error}}",
          error: extractErrorMessage(error),
        }),
      );
    } finally {
      if (isCurrent(generation)) {
        setIsInstallingHelper(false);
        setActiveRemoteTask(null);
      }
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden px-6">
      <span data-testid="settings-target" className="sr-only">
        remote
      </span>
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex flex-col h-full"
      >
        <TabsList className="grid w-full grid-cols-6 mb-6 glass rounded-lg">
          <TabsTrigger value="environment">
            {t("remote.settings.tabs.remote", { defaultValue: "远程" })}
          </TabsTrigger>
          <TabsTrigger value="general">
            {t("settings.tabGeneral", { defaultValue: "通用" })}
          </TabsTrigger>
          <TabsTrigger value="routing">
            {t("settings.tabProxy", { defaultValue: "代理" })}
          </TabsTrigger>
          <TabsTrigger value="auth">
            {t("settings.tabAuth", { defaultValue: "认证" })}
          </TabsTrigger>
          <TabsTrigger value="advanced">
            {t("settings.tabAdvanced", { defaultValue: "高级" })}
          </TabsTrigger>
          <TabsTrigger value="usage">{t("usage.title")}</TabsTrigger>
        </TabsList>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-2">
          <TabsContent value="environment" className="space-y-4 mt-0 pb-4">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <RemoteHealthSection
                health={health}
                isChecking={isCheckingHealth}
                isInstalling={isInstallingHelper}
                onRefresh={() => {
                  void loadHealth();
                }}
                onInstallHelper={installHelper}
                profileName={target.profile.name || target.profile.host}
              />
              <RemoteTaskBanner
                message={activeRemoteTask ?? remoteSettingsTask}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                <span>
                  {toolsCapability
                    ? t("remote.settings.environment.toolsMovedHint", {
                        defaultValue:
                          "工具环境的安装与升级已统一在「应用」页，并按当前管理目标执行。",
                      })
                    : t("remote.settings.environment.helperUnsupported", {
                        defaultValue:
                          "当前远程 Helper 不支持环境检查更新。请安装包含 tools capability 的新版 Helper。",
                      })}
                </span>
                {onOpenApps ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 text-xs"
                    onClick={onOpenApps}
                  >
                    {t("nav.apps")}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </motion.div>
          </TabsContent>

          <TabsContent value="general" className="space-y-4 mt-0 pb-4">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-6"
            >
              <RemoteGeneralSettingsSection
                helperReady={helperReady}
                settingsCapability={settingsCapability}
                target={target}
                settings={remoteSettings}
                isLoading={isLoadingRemoteSettings}
                onSave={(updates) => {
                  void saveRemoteSettings(updates);
                }}
              />
            </motion.div>
          </TabsContent>

          <TabsContent value="routing" className="space-y-4 mt-0 pb-4">
            <RemoteRoutingSettingsSection
              helperReady={helperReady}
              routingCapability={routingCapability}
              routingRuntimeCapability={routingRuntimeCapability}
              settings={remoteSettings}
              isSavingSettings={isSavingRemoteSettings}
              onSaveSettings={saveRemoteSettings}
              target={target}
              onOpenApp={onOpenApp}
            />
          </TabsContent>

          <TabsContent value="auth" className="space-y-4 mt-0 pb-4">
            {!helperReady || !authCapability ? (
              <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                {!helperReady
                  ? t("remote.settings.environment.helperRequired", {
                      defaultValue: "请先完成健康检查并安装可用的远程 Helper。",
                    })
                  : t("remote.settings.auth.unsupported", {
                      defaultValue:
                        "当前远程 Helper 不支持认证管理。请更新到包含 auth capability 的新版 Helper。",
                    })}
              </div>
            ) : (
              <AuthCenterPanel
                target={target}
                onBusyChange={setAuthCenterBusy}
              />
            )}
          </TabsContent>

          <TabsContent value="usage" className="mt-0 pb-4">
            {!helperReady || !usageCapability ? (
              <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                {!helperReady
                  ? t("remote.settings.environment.helperRequired", {
                      defaultValue: "请先完成健康检查并安装可用的远程 Helper。",
                    })
                  : t("remote.settings.usage.unsupported", {
                      defaultValue:
                        "当前远程 Helper 不支持使用统计。请更新到包含 usage capability 的新版 Helper。",
                    })}
              </div>
            ) : (
              <UsageDashboard
                target={target}
                modelsDevSyncSupported={usageModelPricingSyncCapability}
                sessionManualSyncSupported={usageManualSessionSyncCapability}
                refreshIntervalMs={
                  remoteSettings?.usageDashboardRefreshIntervalMs
                }
                onRefreshIntervalChange={(usageDashboardRefreshIntervalMs) => {
                  void saveRemoteSettings({ usageDashboardRefreshIntervalMs });
                }}
              />
            )}
          </TabsContent>

          <TabsContent value="advanced" className="space-y-4 mt-0 pb-4">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <AdvancedSettingsAccordion
                targetMode="remote"
                defaultValue={["data"]}
                descriptions={{
                  data: t("remote.settings.data.description", {
                    defaultValue:
                      "导入或导出当前远程服务器自己的 CC Switch 数据",
                  }),
                }}
                childrenBySection={{
                  directory:
                    !helperReady || !settingsCapability ? (
                      <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        {!helperReady
                          ? t("remote.settings.environment.helperRequired", {
                              defaultValue:
                                "请先完成健康检查并安装可用的远程 Helper。",
                            })
                          : t("remote.settings.general.unsupported", {
                              defaultValue:
                                "当前远程 Helper 不支持通用设置管理。请更新到包含 settings capability 的新版 Helper。",
                            })}
                      </div>
                    ) : isLoadingRemoteSettings || !remoteSettings ? (
                      <div className="flex items-center gap-2 rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("remote.settings.general.loading", {
                          defaultValue: "正在加载远程设置...",
                        })}
                      </div>
                    ) : (
                      <RemoteDirectorySettings
                        target={target}
                        supportsAppConfigDir={appConfigDirCapability}
                        settings={remoteSettings}
                        isSaving={isSavingRemoteSettings}
                        onSave={saveRemoteSettings}
                      />
                    ),
                  data:
                    !helperReady || !importExportCapability ? (
                      <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        {!helperReady
                          ? t("remote.settings.environment.helperRequired", {
                              defaultValue:
                                "请先完成健康检查并安装可用的远程 Helper。",
                            })
                          : t(
                              "remote.settings.advanced.unsupported.importExport",
                              {
                                defaultValue:
                                  "当前远程 Helper 不支持导入导出。请更新到包含 import-export capability 的新版 Helper。",
                              },
                            )}
                      </div>
                    ) : (
                      <ImportExportSection
                        status={importExport.status}
                        selectedFile={importExport.selectedFile}
                        errorMessage={importExport.errorMessage}
                        backupId={importExport.backupId}
                        isImporting={importExport.isImporting}
                        restorePreflightReport={
                          importExport.restorePreflightReport
                        }
                        isRestorePreflightOpen={
                          importExport.isRestorePreflightOpen
                        }
                        onSelectFile={importExport.selectImportFile}
                        onImport={importExport.importConfig}
                        onImportWithRestoreMode={
                          importExport.importWithRestoreMode
                        }
                        onCancelRestorePreflight={
                          importExport.cancelRestorePreflight
                        }
                        onExport={importExport.exportConfig}
                        onClear={importExport.clearSelection}
                      />
                    ),
                  backup:
                    !helperReady ||
                    !importExportCapability ||
                    !settingsCapability ? (
                      <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        {!helperReady
                          ? t("remote.settings.environment.helperRequired", {
                              defaultValue:
                                "请先完成健康检查并安装可用的远程 Helper。",
                            })
                          : !importExportCapability
                            ? t("remote.settings.advanced.unsupported.backup", {
                                defaultValue:
                                  "当前远程 Helper 不支持备份与恢复。请更新到包含 import-export capability 的新版 Helper。",
                              })
                            : t("remote.settings.general.unsupported", {
                                defaultValue:
                                  "当前远程 Helper 不支持通用设置管理。请更新到包含 settings capability 的新版 Helper。",
                              })}
                      </div>
                    ) : isLoadingRemoteSettings || !remoteSettings ? (
                      <div className="flex items-center gap-2 rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("remote.settings.general.loading", {
                          defaultValue: "正在加载远程设置...",
                        })}
                      </div>
                    ) : (
                      <BackupListSection
                        target={target}
                        backupIntervalHours={remoteSettings.backupIntervalHours}
                        backupRetainCount={remoteSettings.backupRetainCount}
                        onSettingsChange={(updates) => {
                          void saveRemoteSettings(updates);
                        }}
                      />
                    ),
                  cloudSync:
                    !helperReady ||
                    !settingsCapability ||
                    !cloudSyncCapability ? (
                      <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        {!helperReady
                          ? t("remote.settings.environment.helperRequired", {
                              defaultValue:
                                "请先完成健康检查并安装可用的远程 Helper。",
                            })
                          : !settingsCapability
                            ? t("remote.settings.general.unsupported", {
                                defaultValue:
                                  "当前远程 Helper 不支持通用设置管理。请更新到包含 settings capability 的新版 Helper。",
                              })
                            : t(
                                "remote.settings.advanced.unsupported.cloudSync",
                                {
                                  defaultValue:
                                    "当前远程 Helper 不支持云同步。请更新到包含 cloud-sync capability 的新版 Helper。",
                                },
                              )}
                      </div>
                    ) : isLoadingRemoteSettings || !remoteSettings ? (
                      <div className="flex items-center gap-2 rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("remote.settings.general.loading", {
                          defaultValue: "正在加载远程设置...",
                        })}
                      </div>
                    ) : (
                      <WebdavSyncSection
                        target={target}
                        config={remoteSettings.webdavSync}
                        s3Config={remoteSettings.s3Sync}
                        settings={remoteSettings}
                        onAutoSave={async (updates) => {
                          await saveRemoteSettings(updates);
                        }}
                      />
                    ),
                  logConfig:
                    !helperReady || !settingsCapability ? (
                      <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
                        {!helperReady
                          ? t("remote.settings.environment.helperRequired", {
                              defaultValue:
                                "请先完成健康检查并安装可用的远程 Helper。",
                            })
                          : t(
                              "remote.settings.advanced.unsupported.logConfig",
                              {
                                defaultValue:
                                  "当前远程 Helper 不支持日志配置。请更新到包含 settings capability 的新版 Helper。",
                              },
                            )}
                      </div>
                    ) : (
                      <LogConfigPanel target={target} />
                    ),
                }}
              />
            </motion.div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

interface RemoteRoutingRuntimePanelProps {
  target: Extract<ManagementTarget, { type: "remote" }>;
  enabled: boolean;
  settings: Settings | null;
  isSavingSettings: boolean;
  onSaveSettings: (
    updates: Partial<Settings>,
  ) => boolean | void | Promise<boolean | void>;
  /** 从路由页的「正在使用」行跳到对应应用页 */
  onOpenApp?: (app: AppId) => void;
}

function RemoteRoutingRuntimePanel({
  target,
  enabled,
  settings,
  isSavingSettings,
  onSaveSettings,
  onOpenApp,
}: RemoteRoutingRuntimePanelProps) {
  const { t } = useTranslation();

  if (!enabled) {
    return (
      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-700 dark:text-yellow-300">
        {t("remote.settings.routing.runtimeUnsupported", {
          defaultValue:
            "当前远程 Helper 仅支持远程路由配置读写；启动、停止和运行状态需要包含 routing-runtime capability 的新版 Helper。",
        })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {settings ? (
        <ToggleRow
          icon={<Server className="h-4 w-4 text-green-500" />}
          title={t("remote.settings.routing.showRemoteRoutingToggle", {
            defaultValue: "在主页面显示远程路由开关",
          })}
          description={t(
            "remote.settings.routing.showRemoteRoutingToggleDescription",
            {
              defaultValue:
                "开启后，主页面顶部显示当前应用的远程路由开关；开启应用路由时远程路由服务会自动启动。",
            },
          )}
          checked={!!settings.enableRemoteRoutingToggle}
          disabled={isSavingSettings}
          onCheckedChange={(value) =>
            onSaveSettings({ enableRemoteRoutingToggle: value })
          }
        />
      ) : null}
      {/* 远端路由服务（启动/停止/状态/监听/日志）、故障转移参数与整流都复用本机同一套
          RoutingSection，只是 target 指向远端；应用级模式视图在应用页的模式面板里。 */}
      <RoutingSection target={target} onOpenApp={onOpenApp} />
    </div>
  );
}

interface RemoteRoutingSettingsSectionProps {
  helperReady: boolean;
  routingCapability: boolean;
  routingRuntimeCapability: boolean;
  settings: Settings | null;
  isSavingSettings: boolean;
  onSaveSettings: (
    updates: Partial<Settings>,
  ) => boolean | void | Promise<boolean | void>;
  /** 从路由页的「正在使用」行跳到对应应用页 */
  onOpenApp?: (app: AppId) => void;
  target: Extract<ManagementTarget, { type: "remote" }>;
}

function RemoteRoutingSettingsSection({
  helperReady,
  routingCapability,
  routingRuntimeCapability,
  settings,
  isSavingSettings,
  onSaveSettings,
  onOpenApp,
  target,
}: RemoteRoutingSettingsSectionProps) {
  const { t } = useTranslation();
  const [showFailoverConfirm, setShowFailoverConfirm] = useState(false);
  const { isRunning } = useProxyStatus(target);
  const disabledMessage = !helperReady
    ? t("remote.settings.environment.helperRequired", {
        defaultValue: "请先完成健康检查并安装可用的远程 Helper。",
      })
    : t("remote.settings.routing.unsupported", {
        defaultValue:
          "当前远程 Helper 不支持路由配置。请安装包含 routing-config capability 的新版 Helper。",
      });

  if (!helperReady || !routingCapability) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        {disabledMessage}
      </div>
    );
  }

  const handleRemoteFailoverToggleChange = (checked: boolean) => {
    if (shouldConfirmRemoteFailoverToggle(settings, checked)) {
      setShowFailoverConfirm(true);
      return;
    }
    void onSaveSettings({ enableRemoteFailoverToggle: checked });
  };

  const handleFailoverConfirm = async () => {
    setShowFailoverConfirm(false);
    await onSaveSettings({
      failoverConfirmed: true,
      enableRemoteFailoverToggle: true,
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-4"
    >
      <Accordion type="multiple" defaultValue={[]} className="w-full space-y-4">
        <AccordionItem
          value="proxy"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Server className="h-5 w-5 text-green-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.proxy.title")}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.proxy.description")}
                </p>
              </div>
              <Badge
                variant={isRunning ? "default" : "secondary"}
                className="gap-1.5 h-6 ml-auto mr-2"
              >
                <Activity
                  className={`h-3 w-3 ${isRunning ? "status-heartbeat" : ""}`}
                />
                {isRunning
                  ? t("settings.advanced.proxy.running")
                  : t("settings.advanced.proxy.stopped")}
              </Badge>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-6 pt-4 border-t border-border/50">
            <RemoteRoutingRuntimePanel
              target={target}
              enabled={routingRuntimeCapability}
              settings={settings}
              isSavingSettings={isSavingSettings}
              onSaveSettings={onSaveSettings}
              onOpenApp={onOpenApp}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="failover"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-orange-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("remote.settings.routing.homepageTitle", {
                    defaultValue: "主页面开关",
                  })}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t(
                    "remote.settings.routing.showRemoteFailoverToggleDescription",
                    {
                      defaultValue:
                        "开启后，主页面顶部显示当前应用的远程故障转移开关；需要当前应用已启用远程路由。",
                    },
                  )}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-6 pt-4 border-t border-border/50">
            <div className="space-y-5">
              {settings ? (
                <ToggleRow
                  icon={<ShieldAlert className="h-4 w-4 text-orange-500" />}
                  title={t("remote.settings.routing.showRemoteFailoverToggle", {
                    defaultValue: "在主页面显示远程故障转移开关",
                  })}
                  description={t(
                    "remote.settings.routing.showRemoteFailoverToggleDescription",
                    {
                      defaultValue:
                        "开启后，主页面顶部显示当前应用的远程故障转移开关；需要当前应用已启用远程路由。",
                    },
                  )}
                  checked={!!settings.enableRemoteFailoverToggle}
                  disabled={isSavingSettings}
                  onCheckedChange={handleRemoteFailoverToggleChange}
                />
              ) : null}
              <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                <span>
                  {t("remote.settings.routing.failoverRemoteHint", {
                    defaultValue:
                      "这里管理的是远程主机的故障转移队列和自动故障转移参数，不会修改本机路由配置。",
                  })}
                </span>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="globalProxy"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Globe className="h-5 w-5 text-cyan-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.globalProxy.title")}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.globalProxy.description")}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-6 pb-6 pt-4 border-t border-border/50">
            <GlobalProxySettings target={target} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <ConfirmDialog
        isOpen={showFailoverConfirm}
        variant="info"
        title={t("confirm.failover.title")}
        message={t("confirm.failover.message")}
        confirmText={t("confirm.failover.confirm")}
        onConfirm={() => void handleFailoverConfirm()}
        onCancel={() => setShowFailoverConfirm(false)}
      />
    </motion.div>
  );
}

interface RemoteHealthSectionProps {
  health: RemoteHealth | null;
  isChecking: boolean;
  isInstalling: boolean;
  profileName: string;
  onRefresh: () => void | Promise<void>;
  onInstallHelper: () => void | Promise<void>;
}

interface RemoteGeneralSettingsSectionProps {
  helperReady: boolean;
  settingsCapability: boolean;
  target: Extract<ManagementTarget, { type: "remote" }>;
  settings: Settings | null;
  isLoading: boolean;
  onSave: (updates: Partial<Settings>) => void | Promise<void>;
}

function RemoteGeneralSettingsSection({
  helperReady,
  settingsCapability,
  target,
  settings,
  isLoading,
  onSave,
}: RemoteGeneralSettingsSectionProps) {
  const { t } = useTranslation();
  const unavailableMessage = !helperReady
    ? t("remote.settings.environment.helperRequired", {
        defaultValue: "请先完成健康检查并安装可用的远程 Helper。",
      })
    : t("remote.settings.general.unsupported", {
        defaultValue:
          "当前远程 Helper 不支持通用设置管理。请更新到包含 settings capability 的新版 Helper。",
      });

  if (!helperReady || !settingsCapability) {
    return (
      <div className="rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
        {unavailableMessage}
      </div>
    );
  }

  if (isLoading || !settings) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("remote.settings.general.loading", {
          defaultValue: "正在加载远程设置...",
        })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* v4 把外观 / 侧栏 / 窗口 / 终端都收进了 GeneralSection（含 visibleApps、
          showProfileSwitcher），远端设置页沿用同一套模块，而不是另建 Remote 专属区块。 */}
      <GeneralSection
        settings={settings as SettingsFormState}
        onAutoSave={async (updates) => {
          await onSave(updates as Partial<Settings>);
          return true;
        }}
        // 本机的「前往应用」入口在远端不适用（应用页管理的是本机工具环境），
        // 这里换成那台主机自己的可见应用开关。
        hideVisibleAppsRow
        onOpenApps={() => undefined}
      />
      <RemoteAppVisibilityCard
        settings={settings as SettingsFormState}
        onSave={(updates) => onSave(updates as Partial<Settings>)}
      />

      <CodexAuthSettings
        settings={settings}
        target={target}
        onChange={(updates) => void onSave(updates)}
      />

      {/* Skill 存储位置在 v4 移到 Skills 页的 SkillsStorageSheet（远端由 skills 能力门控），
          不再放在设置里；远端 Skills 页批次接上。 */}
    </div>
  );
}

/**
 * 远端主机的可见应用：写进那台主机自己的设置（visibleApps），本机目标不受影响。
 * 与「应用」页的本机开关同一套语义：至少留一个应用。
 */
function RemoteAppVisibilityCard({
  settings,
  onSave,
}: {
  settings: SettingsFormState;
  onSave: (updates: Partial<SettingsFormState>) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const visibleApps: VisibleApps = {
    ...DEFAULT_VISIBLE_APPS,
    ...settings.visibleApps,
  };
  const visibleCount = Object.values(visibleApps).filter(Boolean).length;

  return (
    <SettingsBlock title={t("settings.general.sidebarAndHeader")}>
      <SettingsCard>
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {APP_IDS.map((app) => {
            const visible = visibleApps[app];
            return (
              <Button
                key={app}
                type="button"
                variant={visible ? "solid" : "quiet"}
                size="compact"
                aria-pressed={visible}
                disabled={visible && visibleCount <= 1}
                onClick={() =>
                  void onSave({
                    visibleApps: { ...visibleApps, [app]: !visible },
                  })
                }
              >
                {APP_DISPLAY_NAME[app]}
              </Button>
            );
          })}
        </div>
      </SettingsCard>
    </SettingsBlock>
  );
}

function RemoteHealthSection({
  health,
  isChecking,
  isInstalling,
  profileName,
  onRefresh,
  onInstallHelper,
}: RemoteHealthSectionProps) {
  const { t } = useTranslation();
  const helperReady = Boolean(health?.reachable && health.helperInstalled);
  const capabilitySummary = formatRemoteCapabilitySummary(health, t);
  const helperBuildText = formatRemoteHelperBuild(health);
  const helperLatestBuildText = formatRemoteHelperLatestBuild(health);
  const helperActionLabel = health?.helperUpdateAvailable
    ? t("remote.health.updateHelper", { defaultValue: "更新 Helper" })
    : health?.helperInstalled
      ? t("remote.health.reinstallHelper", {
          defaultValue: "重新安装 Helper",
        })
      : t("remote.health.installHelper", {
          defaultValue: "安装 Helper",
        });
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Server className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h3 className="text-base font-semibold truncate">
              {t("remote.settings.environment.host", {
                defaultValue: "远程主机",
              })}
            </h3>
            <p className="text-sm text-muted-foreground truncate">
              {profileName}
            </p>
          </div>
          <Badge variant={helperReady ? "default" : "destructive"}>
            {helperReady
              ? t("remote.status.connected", { defaultValue: "已连接" })
              : t("remote.status.unavailable", { defaultValue: "不可用" })}
          </Badge>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={isChecking || isInstalling}
          >
            {isChecking ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("common.refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onInstallHelper()}
            disabled={isInstalling || isChecking}
          >
            {isInstalling ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {helperActionLabel}
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-gradient-to-br from-card/80 to-card/40 shadow-sm">
        <div className="grid gap-px bg-border/50 sm:grid-cols-2 lg:grid-cols-4">
          <InfoCell
            label={t("remote.health.helperVersion", {
              defaultValue: "Helper 版本",
            })}
            value={formatRemoteHelperVersion(health)}
            description={
              helperBuildText
                ? t("remote.health.helperBuild", {
                    defaultValue: "构建: {{build}}",
                    build: helperBuildText,
                  })
                : undefined
            }
          />
          <InfoCell
            label={t("remote.health.helperLatestVersion", {
              defaultValue: "最新 Helper",
            })}
            value={formatRemoteHelperLatest(health)}
            description={
              helperLatestBuildText
                ? t("remote.health.helperLatestBuild", {
                    defaultValue: "最新构建: {{build}}",
                    build: helperLatestBuildText,
                  })
                : undefined
            }
          />
          <InfoCell
            label={t("remote.health.platform", { defaultValue: "系统" })}
            value={formatRemotePlatform(health)}
          />
          <InfoCell
            label={t("remote.health.capabilities", {
              defaultValue: "远程功能支持",
            })}
            value={capabilitySummary}
          />
        </div>
        {health?.helperUpdateAvailable ? (
          <div className="border-t border-border/50 px-4 py-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">
                  {t("remote.health.helperUpdateAvailable", {
                    defaultValue: "发现新版 Helper",
                  })}
                </div>
                <div className="mt-0.5 break-all">
                  {t("remote.health.helperUpdateDescription", {
                    defaultValue:
                      "远程 Helper 有新版可安装。建议更新后再使用远程管理功能。",
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {health?.helperUpdateError ? (
          <div className="border-t border-border/50 px-4 py-3 text-xs text-muted-foreground">
            {formatRemoteHelperUpdateError(health.helperUpdateError, t)}
          </div>
        ) : null}
        {health?.lastError ? (
          <div className="border-t border-border/50 px-4 py-3 text-sm text-destructive">
            {health.lastError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function InfoCell({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div className="bg-background/70 px-4 py-3 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">
        <span>{value}</span>
        {description ? (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            · {description}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RemoteTaskBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-primary">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}
