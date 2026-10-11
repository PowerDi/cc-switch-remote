import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementTarget } from "@/lib/api/remote";

const invokeMock = vi.hoisted(() => vi.fn());
const remote = vi.hoisted(() => ({
  getAppMode: vi.fn(),
  setAppMode: vi.fn(),
  setAppRoute: vi.fn(),
  getDirectProvider: vi.fn(),
  getProxyTakeoverStatus: vi.fn(),
  exitProxyAppsInMode: vi.fn(),
  getProxyStack: vi.fn(),
  setProxyStackMember: vi.fn(),
  adoptCodexStackCatalog: vi.fn(),
  restartCodexAppServerDaemon: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/api/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/remote")>();
  return { ...actual, remoteApi: { ...actual.remoteApi, ...remote } };
});

const { proxyApi } = await import("@/lib/api/proxy");

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

describe("proxyApi 模式命令的目标分流", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(null);
    for (const fn of Object.values(remote))
      fn.mockReset().mockResolvedValue(null);
  });

  it("远端目标走 helper，带 profile 与 secret", async () => {
    await proxyApi.getAppMode("claude", remoteTarget);
    expect(remote.getAppMode).toHaveBeenCalledWith(
      profile,
      "claude",
      remoteTarget.secret,
    );

    await proxyApi.setProxyTakeoverForApp(
      "claude",
      true,
      true,
      "p1",
      remoteTarget,
    );
    expect(remote.setAppMode).toHaveBeenCalledWith(
      profile,
      "claude",
      true,
      true,
      "p1",
      remoteTarget.secret,
    );

    await proxyApi.setProxyRoute("claude", "p1", remoteTarget);
    expect(remote.setAppRoute).toHaveBeenCalledWith(
      profile,
      "claude",
      "p1",
      remoteTarget.secret,
    );

    await proxyApi.getDirectProvider("claude", remoteTarget);
    expect(remote.getDirectProvider).toHaveBeenCalledWith(
      profile,
      "claude",
      remoteTarget.secret,
    );

    await proxyApi.getProxyTakeoverStatus(remoteTarget);
    expect(remote.getProxyTakeoverStatus).toHaveBeenCalledWith(
      profile,
      remoteTarget.secret,
    );

    await proxyApi.exitProxyAppsInMode(true, remoteTarget);
    expect(remote.exitProxyAppsInMode).toHaveBeenCalledWith(
      profile,
      true,
      remoteTarget.secret,
    );

    await proxyApi.getProxyStack("codex", remoteTarget);
    expect(remote.getProxyStack).toHaveBeenCalledWith(
      profile,
      "codex",
      remoteTarget.secret,
    );

    await proxyApi.setProxyStackMember("codex", "p1", true, remoteTarget);
    expect(remote.setProxyStackMember).toHaveBeenCalledWith(
      profile,
      "codex",
      "p1",
      true,
      remoteTarget.secret,
    );

    await proxyApi.adoptCodexStackCatalog(remoteTarget);
    expect(remote.adoptCodexStackCatalog).toHaveBeenCalledWith(
      profile,
      remoteTarget.secret,
    );

    await proxyApi.restartCodexAppServerDaemon(remoteTarget);
    expect(remote.restartCodexAppServerDaemon).toHaveBeenCalledWith(
      profile,
      remoteTarget.secret,
    );

    // 远端路径上不该出现本机 Tauri 命令
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("本机目标保持原有 Tauri 命令", async () => {
    await proxyApi.getAppMode("claude");
    expect(invokeMock).toHaveBeenCalledWith("get_app_mode", {
      appType: "claude",
    });

    await proxyApi.setProxyTakeoverForApp("claude", false);
    expect(invokeMock).toHaveBeenCalledWith("set_proxy_takeover_for_app", {
      appType: "claude",
      enabled: false,
      stack: false,
      route: null,
    });

    await proxyApi.setProxyRoute("claude", "p1");
    expect(invokeMock).toHaveBeenCalledWith("set_proxy_route", {
      appType: "claude",
      providerId: "p1",
    });

    await proxyApi.getProxyStack("codex");
    expect(invokeMock).toHaveBeenCalledWith("get_proxy_stack", {
      appType: "codex",
    });

    expect(remote.getAppMode).not.toHaveBeenCalled();
    expect(remote.setAppMode).not.toHaveBeenCalled();
  });

  it("远端 Stack 写入失败还原成部分写入错误", async () => {
    remote.setProxyStackMember.mockRejectedValueOnce({
      partial: true,
      message: "boom",
    });

    await expect(
      proxyApi.setProxyStackMember("codex", "p1", true, remoteTarget),
    ).rejects.toMatchObject({ partial: true, message: "boom" });
  });
});
