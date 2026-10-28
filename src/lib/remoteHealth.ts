import type { TFunction } from "i18next";
import type { RemoteConnectionStage, RemoteHealth } from "@/lib/api";

export const EXPECTED_REMOTE_CAPABILITIES = [
  { id: "omp", labelKey: "remote.capabilities.omp", defaultLabel: "Oh My Pi" },
  {
    id: "providers",
    labelKey: "remote.capabilities.providers",
    defaultLabel: "供应商",
  },
  {
    id: "universal-providers",
    labelKey: "remote.capabilities.universalProviders",
    defaultLabel: "统一供应商",
  },
  {
    id: "routing-config",
    labelKey: "remote.capabilities.routingConfig",
    defaultLabel: "路由配置",
  },
  {
    id: "routing-runtime",
    labelKey: "remote.capabilities.routingRuntime",
    defaultLabel: "路由运行态",
  },
  {
    id: "openclaw",
    labelKey: "remote.capabilities.openclaw",
    defaultLabel: "OpenClaw",
  },
  { id: "mcp", labelKey: "remote.capabilities.mcp", defaultLabel: "MCP" },
  {
    id: "prompts",
    labelKey: "remote.capabilities.prompts",
    defaultLabel: "提示词",
  },
  {
    id: "skills",
    labelKey: "remote.capabilities.skills",
    defaultLabel: "技能",
  },
  {
    id: "sessions",
    labelKey: "remote.capabilities.sessions",
    defaultLabel: "会话管理",
  },
  {
    id: "hermes-memory",
    labelKey: "remote.capabilities.hermesMemory",
    defaultLabel: "Hermes 记忆",
  },
  {
    id: "tools",
    labelKey: "remote.capabilities.tools",
    defaultLabel: "环境检查更新",
  },
  {
    id: "import-export",
    labelKey: "remote.capabilities.importExport",
    defaultLabel: "导入 / 导出",
  },
  {
    id: "cloud-sync",
    labelKey: "remote.capabilities.cloudSync",
    defaultLabel: "云同步",
  },
  {
    id: "auth",
    labelKey: "remote.capabilities.auth",
    defaultLabel: "认证管理",
  },
  {
    id: "usage-model-pricing-sync",
    labelKey: "remote.capabilities.usageModelPricingSync",
    defaultLabel: "模型定价同步",
  },
  {
    id: "settings",
    labelKey: "remote.capabilities.settings",
    defaultLabel: "通用设置",
  },
  {
    id: "settings-app-config-dir",
    labelKey: "remote.capabilities.settingsAppConfigDir",
    defaultLabel: "CC Switch 配置目录",
  },
  {
    id: "plugin",
    labelKey: "remote.capabilities.plugin",
    defaultLabel: "Claude 插件",
  },
  {
    id: "session",
    labelKey: "remote.capabilities.session",
    defaultLabel: "持久连接",
  },
] as const;

export function canReportRemoteCapabilities(health: RemoteHealth | null) {
  return health?.reachable === true && health.helperInstalled === true;
}

export function formatRemoteHelperVersion(health: RemoteHealth | null) {
  if (!health?.helperVersion) return "-";
  return health.helperVersion;
}

export function formatRemoteHelperLatest(health: RemoteHealth | null) {
  if (!health?.helperLatestVersion) return "-";
  return health.helperLatestVersion;
}

export function formatRemoteHelperBuild(health: RemoteHealth | null) {
  return shortHelperBuild(health?.helperBuild);
}

export function formatRemoteHelperLatestBuild(health: RemoteHealth | null) {
  return shortHelperBuild(health?.helperLatestBuild);
}

function shortHelperBuild(build: string | undefined) {
  const trimmed = build?.trim();
  if (!trimmed) return null;
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

export function formatRemotePlatform(health: RemoteHealth | null) {
  if (!health?.platform) return "-";
  return health.helperArch
    ? `${health.platform} / ${health.helperArch}`
    : health.platform;
}

export function formatRemoteCapabilitySummary(
  health: RemoteHealth | null,
  t: TFunction,
) {
  if (!canReportRemoteCapabilities(health)) {
    return "-";
  }
  const count = health?.capabilities.length ?? 0;
  if (count === 0) {
    return t("remote.health.noCapabilities", {
      defaultValue: "未返回功能支持信息",
    });
  }
  return t("remote.health.supportedCapabilities", {
    defaultValue: "已支持 {{count}} 项",
    count,
  });
}

export function formatRemoteHelperUpdateError(error: string, t: TFunction) {
  if (error.includes("不支持持久会话")) {
    return error;
  }
  return t("remote.health.helperUpdateCheckFailed", {
    defaultValue:
      "本机查询 Helper 最新发布信息失败，不影响远端已安装版本和功能：{{error}}",
    error,
  });
}

/** 连接测试里每个层次的展示状态。 */
export type RemoteStageState =
  | "ok"
  | "failed"
  | "missing"
  | "error"
  | "unknown";

export interface RemoteConnectionDescription {
  ssh: RemoteStageState;
  helper: RemoteStageState;
  stage: RemoteConnectionStage | null;
}

/**
 * 把一次健康检查/连接测试的结果拆成「SSH」与「Helper」两层。
 *
 * 关键约定：SSH 未连通时 Helper 一律是 `unknown`。没有这一层区分，界面上
 * 「没装 Helper」和「SSH 认证失败」都会显示成同一个「连接失败」。
 */
export function describeRemoteConnection(
  health: RemoteHealth | null,
): RemoteConnectionDescription {
  if (!health) {
    return { ssh: "unknown", helper: "unknown", stage: null };
  }

  const stage = health.failureStage ?? null;
  if (health.reachable && health.helperInstalled) {
    return { ssh: "ok", helper: "ok", stage: null };
  }

  if (
    health.sshReachable === false ||
    stage === "ssh-auth" ||
    stage === "ssh-transport"
  ) {
    return {
      ssh: "failed",
      helper: "unknown",
      stage: stage ?? "ssh-transport",
    };
  }

  if (stage === "helper-missing") {
    return { ssh: "ok", helper: "missing", stage };
  }
  if (stage === "helper-error") {
    return { ssh: "ok", helper: "error", stage };
  }

  // 没有分层信息（旧后端或诊断本身失败）时不猜层次，只展示原始报错。
  if (health.reachable === false && health.sshReachable === undefined) {
    return { ssh: "unknown", helper: "unknown", stage: null };
  }

  return {
    ssh: "ok",
    helper: health.helperInstalled ? "error" : "missing",
    stage: null,
  };
}

/** 连接失败时给用户看的下一步建议，按失败层次给出不同文案。 */
export function describeRemoteFailureHint(
  description: RemoteConnectionDescription,
  t: TFunction,
): string | null {
  switch (description.stage) {
    case "ssh-auth":
      return t("remote.health.failureSshAuth", {
        defaultValue: "SSH 认证未通过，请检查账号、密码或密钥。",
      });
    case "ssh-transport":
      return t("remote.health.failureSshTransport", {
        defaultValue: "SSH 连接未建立，请检查地址、端口、网络与防火墙。",
      });
    case "helper-missing":
      return t("remote.health.failureHelperMissing", {
        defaultValue: "SSH 已连通，但远程 Helper 未安装或路径不正确。",
      });
    case "helper-error":
      return t("remote.health.failureHelperError", {
        defaultValue: "SSH 已连通，Helper 文件也在，但无法正常运行。",
      });
    default:
      if (description.ssh === "failed") {
        return t("remote.health.sshNotReachableHint", {
          defaultValue: "SSH 尚未连通，因此无法判断远程 Helper 是否存在。",
        });
      }
      return null;
  }
}
