import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementTarget, RemoteHostProfile } from "./remote";

const invokeMock = vi.fn();
const remoteGetPricingModelSourceMock = vi.fn();
const remoteSetPricingModelSourceMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./remote", () => ({
  remoteApi: {
    getPricingModelSource: (...args: unknown[]) =>
      remoteGetPricingModelSourceMock(...args),
    setPricingModelSource: (...args: unknown[]) =>
      remoteSetPricingModelSourceMock(...args),
  },
}));

const profile: RemoteHostProfile = {
  id: "remote-pricing",
  name: "Remote Pricing",
  host: "192.168.1.21",
  port: 22,
  username: "root",
  authMethod: { type: "password" },
  helperPath: "~/.local/bin/cc-switch-remote-helper",
  createdAt: 1,
  updatedAt: 1,
};

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile,
  secret: { password: "secret" },
};

describe("remote proxy pricing API", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    remoteGetPricingModelSourceMock.mockReset();
    remoteSetPricingModelSourceMock.mockReset();
  });

  // v4 取消了应用级默认成本倍率：前端不再暴露该方法，helper 只对旧客户端显式拒绝。
  it("routes the billing model source to the selected remote target", async () => {
    const { proxyApi } = await import("./proxy");

    remoteGetPricingModelSourceMock.mockResolvedValue("request");
    remoteSetPricingModelSourceMock.mockResolvedValue(undefined);

    await proxyApi.getPricingModelSource("codex", remoteTarget);
    await proxyApi.setPricingModelSource("codex", "response", remoteTarget);

    expect(remoteGetPricingModelSourceMock).toHaveBeenCalledWith(
      profile,
      "codex",
      remoteTarget.secret,
    );
    expect(remoteSetPricingModelSourceMock).toHaveBeenCalledWith(
      profile,
      "codex",
      "response",
      remoteTarget.secret,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
