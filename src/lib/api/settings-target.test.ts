import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/types";
import type { ManagementTarget } from "@/lib/api/remote";

const invokeMock = vi.hoisted(() => vi.fn());
const remoteSaveSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class {},
}));
vi.mock("@/lib/api/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/remote")>();
  return {
    ...actual,
    remoteApi: { ...actual.remoteApi, saveSettings: remoteSaveSettingsMock },
  };
});

const { settingsApi } = await import("@/lib/api/settings");

const settings = { visibleApps: { claude: true } } as unknown as Settings;

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

describe("settingsApi.saveForTarget", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue({ success: true, warnings: [] });
    remoteSaveSettingsMock
      .mockReset()
      .mockResolvedValue({ success: true, warnings: [] });
  });

  it("writes remote settings through the helper", async () => {
    await settingsApi.saveForTarget(settings, remoteTarget);

    expect(remoteSaveSettingsMock).toHaveBeenCalledWith(
      profile,
      settings,
      remoteTarget.secret,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps local saves on the local command", async () => {
    await settingsApi.saveForTarget(settings);

    expect(invokeMock).toHaveBeenCalledWith("save_settings", { settings });
    expect(remoteSaveSettingsMock).not.toHaveBeenCalled();
  });
});
