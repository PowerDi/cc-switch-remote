import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AppsPage } from "@/components/apps/AppsPage";
import { resetToolManagementStateForTests } from "@/components/apps/useToolManagement";
import type { ManagementTarget } from "@/lib/api/remote";

const localApi = vi.hoisted(() => ({
  get: vi.fn(),
  saveForTarget: vi.fn(),
  getToolVersions: vi.fn(),
  probeToolInstallations: vi.fn(),
  listToolInstallations: vi.fn(),
  runToolLifecycleAction: vi.fn(),
  save: vi.fn(),
}));

const remoteApiMocks = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  getToolVersions: vi.fn(),
  probeToolInstallations: vi.fn(),
  listToolInstallations: vi.fn(),
  runToolLifecycleAction: vi.fn(),
  saveSettings: vi.fn(),
  getSettings: vi.fn(),
}));

const settingsHooks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  autoSaveSettings: vi.fn(async () => null),
  settings: { visibleApps: undefined as unknown },
}));

vi.mock("@/lib/api", () => ({
  settingsApi: localApi,
  remoteApi: remoteApiMocks,
}));
vi.mock("@/lib/api/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/remote")>();
  return { ...actual, remoteApi: remoteApiMocks };
});
vi.mock("@/lib/api/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/providers")>();
  return {
    ...actual,
    providersApi: {
      ...actual.providersApi,
      getClaudeDesktopStatus: async () => ({
        supported: true,
        configured: true,
      }),
    },
  };
});
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: settingsHooks.settings,
    updateSettings: settingsHooks.updateSettings,
    autoSaveSettings: settingsHooks.autoSaveSettings,
  }),
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const profile = {
  id: "server-a",
  name: "Server A",
  host: "192.0.2.10",
  port: 22,
  username: "root",
  authMethod: { type: "sshAgent" as const },
  helperPath: "/root/.local/bin/cc-switch-remote-helper",
  createdAt: 1,
  updatedAt: 1,
};

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile,
  secret: { password: "secret" },
};

const toolVersion = (name: string) => ({
  name,
  version: "1.0.0",
  latest_version: "1.0.0",
  error: null,
  installed_but_broken: false,
  env_type: "linux" as const,
  wsl_distro: null,
  install_path: "/usr/local/bin",
  install_source: "system",
});

function renderApps(target?: ManagementTarget) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppsPage target={target} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetToolManagementStateForTests();
  for (const fn of Object.values(localApi)) fn.mockReset?.();
  for (const fn of Object.values(remoteApiMocks)) fn.mockReset?.();
  settingsHooks.updateSettings.mockReset();
  settingsHooks.autoSaveSettings.mockReset();
  settingsHooks.settings = { visibleApps: undefined };

  localApi.getToolVersions.mockResolvedValue([toolVersion("claude")]);
  localApi.probeToolInstallations.mockResolvedValue([]);
  localApi.listToolInstallations.mockResolvedValue([]);
  localApi.save.mockResolvedValue({ success: true, warnings: [] });
  localApi.get.mockResolvedValue({ visibleApps: { gemini: true } });
  localApi.saveForTarget.mockResolvedValue({ success: true, warnings: [] });
  remoteApiMocks.getToolVersions.mockResolvedValue([toolVersion("claude")]);
  remoteApiMocks.probeToolInstallations.mockResolvedValue([]);
  remoteApiMocks.listToolInstallations.mockResolvedValue([]);
  remoteApiMocks.saveSettings.mockResolvedValue({
    success: true,
    warnings: [],
  });
  remoteApiMocks.getSettings.mockResolvedValue({ visibleApps: {} });
  remoteApiMocks.checkHealth.mockResolvedValue({
    reachable: true,
    helperInstalled: true,
    capabilities: ["providers", "tools"],
  });
});

describe("AppsPage management target", () => {
  it("checks tool versions on the remote host with the selected profile", async () => {
    renderApps(remoteTarget);
    await waitFor(() =>
      expect(remoteApiMocks.getToolVersions).toHaveBeenCalledWith(
        profile,
        expect.arrayContaining(["claude"]),
        remoteTarget.secret,
      ),
    );
    // 本机命令一次都不该被调用
    expect(localApi.getToolVersions).not.toHaveBeenCalled();
  });

  it("keeps local tool checks on the local machine", async () => {
    renderApps();

    await waitFor(() =>
      expect(localApi.getToolVersions).toHaveBeenCalledWith(
        expect.arrayContaining(["claude"]),
        expect.anything(),
      ),
    );
    expect(remoteApiMocks.getToolVersions).not.toHaveBeenCalled();
  });

  it("tells the user when the helper cannot manage tools", async () => {
    remoteApiMocks.checkHealth.mockResolvedValue({
      reachable: true,
      helperInstalled: true,
      capabilities: ["providers"],
    });

    renderApps(remoteTarget);

    expect(
      await screen.findByText(/当前远程 Helper 不支持环境检查更新/),
    ).toBeInTheDocument();
    expect(remoteApiMocks.getToolVersions).not.toHaveBeenCalled();
  });

  it("hides the local-only rows for a remote target", async () => {
    renderApps(remoteTarget);

    await waitFor(() =>
      expect(remoteApiMocks.getToolVersions).toHaveBeenCalled(),
    );
    // Claude Desktop 是本机安装的桌面端
    expect(screen.queryByText("Claude Desktop")).not.toBeInTheDocument();
  });

  it("writes the target's own visible apps", async () => {
    const user = userEvent.setup();
    settingsHooks.settings = { visibleApps: { gemini: true } };
    remoteApiMocks.getSettings.mockResolvedValue({
      visibleApps: { gemini: true },
    });

    renderApps(remoteTarget);

    // 第一行是 Claude Code：远端目标下开关要写那台主机的 visibleApps
    const [claudeSwitch] = await screen.findAllByRole("switch");
    await user.click(claudeSwitch);

    // 远端目标的可见应用写回那台主机（saveForTarget 内部走 remoteApi.saveSettings，
    // 路由本身在 settingsApi.saveForTarget 的单测里覆盖）
    await waitFor(() =>
      expect(localApi.saveForTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          visibleApps: expect.objectContaining({ claude: false }),
        }),
        remoteTarget,
      ),
    );
    // 远端目标的可见应用不落回本机设置
    expect(settingsHooks.autoSaveSettings).not.toHaveBeenCalled();
  });
});
