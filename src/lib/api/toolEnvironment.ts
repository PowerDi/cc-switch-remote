import { settingsApi } from "@/lib/api";
import { remoteApi } from "@/lib/api/remote";
import type { ManagementTarget } from "@/lib/api/remote";
import type {
  ToolInstallationReport,
  ToolUninstallPlan,
  ToolUninstallCandidate,
} from "@/lib/api/settings";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";

/**
 * 工具环境生命周期的目标感知门面。
 *
 * 本机走 Tauri 命令，远端走 helper 的同名命令；两边最终都落到共享的
 * `tool_environment` 实现，所以"版本怎么算、装什么、装哪儿、升级锚点"只有一份。
 * WSL 相关的参数只有 Windows 本机成立（helper 在自己的主机上直跑命令），
 * 远端不传。
 */
export type ToolVersionEntry = Awaited<
  ReturnType<typeof settingsApi.getToolVersions>
>[number];

export type WslShellByTool = Record<
  string,
  { wslShell?: string | null; wslShellFlag?: string | null }
>;

export const toolEnvironmentApi = {
  async prepareToolUninstall(
    tool: string,
    wslShellByTool?: WslShellByTool,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ToolUninstallCandidate[]> {
    if (target.type === "remote")
      throw new Error("REMOTE_HELPER_UPGRADE_REQUIRED: tool-uninstall");
    return settingsApi.prepareToolUninstall(tool, wslShellByTool);
  },
  async getToolVersions(
    tools: string[],
    wslShellByTool?: WslShellByTool,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ToolVersionEntry[]> {
    if (target.type === "remote") {
      return (await remoteApi.getToolVersions(
        target.profile,
        tools,
        target.secret,
      )) as ToolVersionEntry[];
    }
    return await settingsApi.getToolVersions(tools, wslShellByTool);
  },

  async runToolLifecycleAction(
    tools: string[],
    action: "install" | "update" | "uninstall",
    wslShellByTool?: WslShellByTool,
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
    uninstallPlan?: ToolUninstallPlan,
  ): Promise<void> {
    if (target.type === "remote") {
      if (action === "uninstall")
        throw new Error("REMOTE_HELPER_UPGRADE_REQUIRED: tool-uninstall");
      await remoteApi.runToolLifecycleAction(
        target.profile,
        tools,
        action,
        target.secret,
      );
      return;
    }
    if (action === "uninstall") {
      await settingsApi.runToolLifecycleAction(
        tools,
        action,
        wslShellByTool,
        uninstallPlan,
      );
    } else {
      await settingsApi.runToolLifecycleAction(tools, action, wslShellByTool);
    }
  },

  async probeToolInstallations(
    tools: string[],
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ToolInstallationReport[]> {
    if (target.type === "remote") {
      return await remoteApi.probeToolInstallations(
        target.profile,
        tools,
        target.secret,
      );
    }
    return await settingsApi.probeToolInstallations(tools);
  },

  async listToolInstallations(
    tools: string[],
    target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  ): Promise<ToolInstallationReport[]> {
    if (target.type === "remote") {
      return await remoteApi.listToolInstallations(
        target.profile,
        tools,
        target.secret,
      );
    }
    return await settingsApi.listToolInstallations(tools);
  },
};
