import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementTarget, RemoteHostProfile } from "./remote";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), remoteCheck: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./remote", () => ({
  remoteApi: { streamCheckProvider: mocks.remoteCheck },
}));

const profile: RemoteHostProfile = {
  id: "remote-1",
  name: "Remote 1",
  host: "192.0.2.20",
  port: 22,
  username: "tester",
  authMethod: { type: "password" },
  helperPath: "~/.local/bin/cc-switch-remote-helper",
  createdAt: 1,
  updatedAt: 1,
};
const remoteTarget: ManagementTarget = {
  type: "remote",
  profile,
  secret: { password: "test-ssh-secret" },
};
const response = {
  status: "operational",
  success: true,
  message: "reachable",
  httpStatus: 401,
  responseTimeMs: 12,
  testedAt: 1,
  retryCount: 0,
};

describe("connectivity check target routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the selected remote profile and secret, never local invoke", async () => {
    const { streamCheckProvider } = await import("./connectivity-check");
    mocks.remoteCheck.mockResolvedValue(response);
    await expect(
      streamCheckProvider("claude", "remote-provider", remoteTarget),
    ).resolves.toEqual(response);
    expect(mocks.remoteCheck).toHaveBeenCalledWith(
      profile,
      "claude",
      "remote-provider",
      remoteTarget.secret,
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps the local reachability command unchanged", async () => {
    const { streamCheckProvider } = await import("./connectivity-check");
    mocks.invoke.mockResolvedValue(response);
    await expect(
      streamCheckProvider("codex", "local-provider"),
    ).resolves.toEqual(response);
    expect(mocks.invoke).toHaveBeenCalledWith("stream_check_provider", {
      appType: "codex",
      providerId: "local-provider",
    });
    expect(mocks.remoteCheck).not.toHaveBeenCalled();
  });

  it("does not expose retired real-model test settings or batch commands", async () => {
    const api = await import("./connectivity-check");
    expect(api).not.toHaveProperty("getStreamCheckConfig");
    expect(api).not.toHaveProperty("saveStreamCheckConfig");
    expect(api).not.toHaveProperty("streamCheckAllProviders");
  });
});
