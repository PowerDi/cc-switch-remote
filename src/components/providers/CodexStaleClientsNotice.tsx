import { useState } from "react";
import { RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  useAcknowledgeCodexStaleClients,
  useRestartCodexAppServerDaemon,
} from "@/lib/query/proxy";
import type { CodexStaleClients } from "@/types/proxy";
import type { ManagementTarget } from "@/lib/api/remote";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";

interface CodexStaleClientsNoticeProps {
  staleClients: CodexStaleClients;
  /** 管理目标：重启的是那台主机上的 Codex 守护进程 */
  target?: ManagementTarget;
  onDismiss?: () => void;
}

/**
 * Codex 客户端可能缓存着旧账号或模型列表（模型目录只在启动时读，切换账号或直连、路由、聚合
 * 模式后都会变）。命令行连的守护进程确认后一键重启；桌面版、编辑器插件只提示用户彻底退出再
 * 开。重启会中断守护进程里正在运行的任务，执行期间确认框保持打开。看不到桌面版、编辑器插件
 * 进程时（Windows），只能说「可能」，关掉提示时让后端记下现在这份，同一份不再提示。
 */
export function CodexStaleClientsNotice({
  staleClients,
  target = LOCAL_MANAGEMENT_TARGET,
  onDismiss,
}: CodexStaleClientsNoticeProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const restart = useRestartCodexAppServerDaemon(target);
  const acknowledge = useAcknowledgeCodexStaleClients(target);
  const dismiss = () => {
    if (staleClients.unverified && target.type === "local") acknowledge.mutate();
    onDismiss?.();
  };

  return (
    <>
      <Notice
        tone="warning"
        title={t(
          staleClients.unverified
            ? "proxy.stackMode.codexStale.unverifiedTitle"
            : staleClients.auth
              ? "proxy.stackMode.codexStale.authTitle"
              : "proxy.stackMode.codexStale.title",
        )}
        onDismiss={onDismiss || staleClients.unverified ? dismiss : undefined}
        dismissLabel={t("common.close")}
        actions={
          staleClients.daemon ? (
            <Button
              variant="neutral"
              size="compact"
              disabled={restart.isPending}
              onClick={() => setConfirming(true)}
            >
              <RotateCw
                className={`h-3.5 w-3.5 ${restart.isPending ? "animate-spin" : ""}`}
              />
              {t("proxy.stackMode.codexStale.restart")}
            </Button>
          ) : undefined
        }
      >
        {staleClients.daemon && (
          <span className="block">
            {t("proxy.stackMode.codexStale.daemon")}
          </span>
        )}
        {staleClients.others && (
          <span className="block">
            {t("proxy.stackMode.codexStale.others")}
          </span>
        )}
        {staleClients.unverified && (
          <span className="block">
            {t("proxy.stackMode.codexStale.unverifiedHint")}
          </span>
        )}
      </Notice>
      <ConfirmDialog
        isOpen={confirming}
        title={t("proxy.stackMode.codexStale.confirmTitle")}
        message={t("proxy.stackMode.codexStale.confirmMessage")}
        confirmText={t("proxy.stackMode.codexStale.confirm")}
        pending={restart.isPending}
        onConfirm={() =>
          restart.mutate(undefined, {
            onSettled: () => setConfirming(false),
          })
        }
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
