import { beforeEach, describe, expect, it, vi } from "vitest";
import { providersApi } from "./providers";
import type { ProviderEditorSave } from "./providers";
import type { Provider } from "@/types";
import type { ManagementTarget, RemoteHostProfile } from "./remote";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const remoteProfile: RemoteHostProfile = {
  id: "remote-host",
  name: "Remote Host",
  host: "192.0.2.10",
  port: 22,
  username: "root",
  authMethod: { type: "sshAgent" },
  helperPath: "/root/.local/bin/cc-switch-remote-helper",
  createdAt: 1,
  updatedAt: 1,
};
const remote: ManagementTarget = {
  type: "remote",
  profile: remoteProfile,
  secret: { password: "test-secret" },
};
const editorSave: ProviderEditorSave = {
  base: { env: { ANTHROPIC_AUTH_TOKEN: "[redacted]" } },
  onConflict: "keepMine",
};
const provider: Provider = {
  id: "p1",
  name: "P1",
  category: "custom",
  settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: "[redacted]" } },
};

describe("provider editor target routing", () => {
  beforeEach(() => invokeMock.mockReset());

  it("keeps local editor reads on the local projection command", async () => {
    invokeMock.mockResolvedValueOnce({ settings: {}, inactive: [] });
    await providersApi.getEditorView("claude", { env: {} }, "custom", "p1");
    expect(invokeMock).toHaveBeenCalledWith("get_provider_editor_view", {
      app: "claude",
      settingsConfig: { env: {} },
      category: "custom",
      providerId: "p1",
    });
  });

  it("reads the editor view from the selected remote host, never from local live", async () => {
    invokeMock.mockResolvedValueOnce({ settings: { env: {} }, inactive: [] });
    await providersApi.getEditorView(
      "claude",
      { env: {} },
      undefined,
      "p1",
      remote,
    );
    expect(invokeMock).toHaveBeenCalledWith("remote_get_provider_editor_view", {
      profile: remoteProfile,
      app: "claude",
      settingsConfig: { env: {} },
      providerId: "p1",
      secret: remote.secret,
    });
    const [command] = invokeMock.mock.calls[0] as [string];
    expect(command).not.toBe("get_provider_editor_view");
  });

  it("forwards the editor save context to the local add/update commands", async () => {
    invokeMock.mockResolvedValue(true);
    await providersApi.add(
      provider,
      "claude",
      true,
      { type: "local" },
      editorSave,
    );
    await providersApi.update(
      provider,
      "claude",
      "p1",
      { type: "local" },
      editorSave,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(1, "add_provider", {
      provider,
      app: "claude",
      addToLive: true,
      editorSave,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "update_provider", {
      provider,
      app: "claude",
      originalId: "p1",
      editorSave,
    });
  });

  it("forwards the editor save context through the remote helper for remote targets", async () => {
    invokeMock.mockResolvedValue(true);
    await providersApi.add(provider, "claude", true, remote, editorSave);
    await providersApi.update(provider, "claude", "p1", remote, editorSave);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "remote_add_provider", {
      profile: remoteProfile,
      app: "claude",
      provider,
      addToLive: true,
      secret: remote.secret,
      editorSave,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "remote_update_provider", {
      profile: remoteProfile,
      app: "claude",
      provider,
      originalId: "p1",
      secret: remote.secret,
      editorSave,
    });
  });

  it("omits the editor context entirely when the caller has none", async () => {
    invokeMock.mockResolvedValue(true);
    await providersApi.update(provider, "claude", "p1", remote);
    expect(invokeMock).toHaveBeenCalledWith("remote_update_provider", {
      profile: remoteProfile,
      app: "claude",
      provider,
      originalId: "p1",
      secret: remote.secret,
    });
  });
});
