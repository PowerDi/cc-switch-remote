import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementTarget } from "@/lib/api/remote";
import type { AppId } from "@/lib/api/types";
import type { StreamCheckResult } from "@/lib/api/connectivity-check";
import { useStreamCheck } from "@/hooks/useStreamCheck";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  health: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/api/connectivity-check", () => ({
  streamCheckProvider: mocks.check,
}));
vi.mock("@/lib/api/remote", () => ({
  remoteApi: { checkHealth: mocks.health },
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.success, warning: mocks.warning, error: mocks.error },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "one",
    name: "Remote",
    host: "192.0.2.1",
    port: 22,
    username: "tester",
    authMethod: { type: "password" },
    helperPath: "~/.local/bin/helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "test-connection-secret" },
};
const reachable: StreamCheckResult = {
  status: "operational",
  success: true,
  message: "reachable",
  responseTimeMs: 12,
  httpStatus: 401,
  testedAt: 1,
  retryCount: 0,
};
const clients: QueryClient[] = [];
function mount(target: ManagementTarget, appId: AppId = "claude") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    ...renderHook(({ target, appId }) => useStreamCheck(appId, target), {
      wrapper,
      initialProps: { target, appId },
    }),
  };
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.health.mockResolvedValue({ capabilities: ["connectivity-check"] });
  mocks.check.mockResolvedValue(reachable);
});

describe("reachability capability and target isolation", () => {
  it("keeps local checks enabled without an SSH health request", async () => {
    const { result } = mount({ type: "local" });
    expect(result.current.canCheck).toBe(true);
    await act(async () => {
      await result.current.checkProvider("p", "Provider");
    });
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.check).toHaveBeenCalledWith("claude", "p", { type: "local" });
    expect(result.current.isChecking("p")).toBe(false);
  });

  it("gates remote checks on the new capability and keeps secrets out of keys", async () => {
    const { result, client } = mount(remote);
    await waitFor(() => expect(result.current.canCheck).toBe(true));
    await act(async () => {
      await result.current.checkProvider("p", "Remote provider");
    });
    expect(mocks.health).toHaveBeenCalledWith(remote.profile, remote.secret);
    expect(mocks.check).toHaveBeenCalledWith("claude", "p", remote);
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(["remote-health", "remote:one", 0]);
    expect(JSON.stringify(keys)).not.toContain("test-connection-secret");
  });

  it("does not run an older helper's billable model test", async () => {
    mocks.health.mockResolvedValue({ capabilities: ["stream-check"] });
    const { result } = mount(remote);
    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.checkProvider("p", "Provider");
    });
    expect(result.current.canCheck).toBe(false);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("does not execute a retained callback after the connection changes", async () => {
    const { result, rerender } = mount(remote);
    await waitFor(() => expect(result.current.canCheck).toBe(true));
    const oldAction = result.current.checkProvider;
    rerender({
      target: { ...remote, secret: { password: "new-secret" } },
      appId: "claude",
    });
    await waitFor(() => expect(result.current.canCheck).toBe(true));
    await act(async () => {
      await oldAction("p", "Old target");
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("drops results when the app changes even if the provider ID is reused", async () => {
    let finish!: (value: StreamCheckResult) => void;
    mocks.check.mockReturnValue(
      new Promise<StreamCheckResult>((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = mount({ type: "local" });
    let pending!: Promise<StreamCheckResult | null>;
    act(() => {
      pending = result.current.checkProvider("same-id", "Claude");
    });
    rerender({ target: { type: "local" }, appId: "codex" });
    await act(async () => {
      finish(reachable);
      await pending;
    });
    await expect(pending).resolves.toBeNull();
    expect(result.current.isChecking("same-id")).toBe(false);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("drops old-target results and loading state after credentials change", async () => {
    let resolveCheck!: (result: StreamCheckResult) => void;
    mocks.check.mockReturnValue(
      new Promise<StreamCheckResult>((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const { result, rerender } = mount(remote);
    await waitFor(() => expect(result.current.canCheck).toBe(true));
    let pending!: Promise<StreamCheckResult | null>;
    act(() => {
      pending = result.current.checkProvider("p", "Old provider");
    });
    expect(result.current.isChecking("p")).toBe(true);
    rerender({
      target: { ...remote, secret: { password: "changed-secret" } },
      appId: "claude",
    });
    await waitFor(() => expect(result.current.isChecking("p")).toBe(false));
    await act(async () => {
      resolveCheck(reachable);
      await pending;
    });
    await expect(pending).resolves.toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
