import { createElement, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTargetCapability } from "@/hooks/useTargetCapability";
import { usageApi } from "@/lib/api/usage";
import { useUsageFirstDate } from "./usage";
import { piApi } from "@/lib/api/pi";
import { usePiCurrentState, invalidatePiProviderCaches } from "./pi";
import type { ManagementTarget } from "@/lib/api/remote";
vi.mock("@/lib/api/pi", () => ({ piApi: { getCurrentState: vi.fn() } }));
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "host",
    name: "Host",
    host: "192.0.2.1",
    port: 22,
    username: "user",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 0,
    updatedAt: 0,
  },
  secret: { password: "first" },
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("Pi-family target caches", () => {
  it("isolates local and remote membership and discards cache when host credentials change", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client }, children);
    vi.mocked(piApi.getCurrentState)
      .mockResolvedValueOnce({
        enabledProviderIds: ["local"],
        defaultProviderId: "local",
      })
      .mockResolvedValueOnce({
        enabledProviderIds: ["remote"],
        defaultProviderId: "remote",
      })
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        usePiCurrentState(true, "omp", target),
      { wrapper, initialProps: { target: { type: "local" } } },
    );
    await waitFor(() =>
      expect(result.current.data?.defaultProviderId).toBe("local"),
    );
    rerender({ target: remote });
    expect(result.current.data).toBeUndefined();
    await waitFor(() =>
      expect(result.current.data?.defaultProviderId).toBe("remote"),
    );
    const next = { ...remote, secret: { password: "changed" } };
    rerender({ target: next });
    expect(result.current.data).toBeUndefined();
    await waitFor(() =>
      expect(piApi.getCurrentState).toHaveBeenLastCalledWith("omp", next),
    );
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys.filter((key) => key.includes("remote:host"))).toHaveLength(2);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await invalidatePiProviderCaches(client, "omp", { type: "local" });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["omp", "currentState", "local"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["providers", "omp", "local"],
    });
    client.clear();
  });
});

vi.mock("@/hooks/useTargetCapability", () => ({
  useTargetCapability: vi.fn(() => true),
}));
vi.mock("@/lib/api/usage", () => ({
  usageApi: { getUsageFirstDate: vi.fn() },
}));
beforeEach(() => {
  vi.mocked(useTargetCapability).mockReturnValue(true);
});
describe("new helper capability gates", () => {
  it.each(["pi", "omp"] as const)(
    "does not read %s native state from an older helper",
    async (app) => {
      vi.mocked(useTargetCapability).mockReturnValue(false);
      const client = new QueryClient();
      const wrapper = ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client }, children);
      const { result } = renderHook(
        () => usePiCurrentState(true, app, remote),
        { wrapper },
      );
      expect(result.current.fetchStatus).toBe("idle");
      expect(piApi.getCurrentState).not.toHaveBeenCalled();
      expect(useTargetCapability).toHaveBeenCalledWith(
        remote,
        "pi-native-state",
        true,
      );
      client.clear();
    },
  );
  it.each([false, true])(
    "only reads first-date when helper advertises support=%s",
    async (supported) => {
      vi.mocked(useTargetCapability).mockReturnValue(supported);
      vi.mocked(usageApi.getUsageFirstDate).mockResolvedValue("2026-01-01");
      const client = new QueryClient();
      const wrapper = ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client }, children);
      const { result } = renderHook(
        () =>
          useUsageFirstDate(
            { appType: "omp" },
            { refetchInterval: false },
            remote,
          ),
        { wrapper },
      );
      if (supported) {
        await waitFor(() => expect(result.current.data).toBe("2026-01-01"));
        expect(usageApi.getUsageFirstDate).toHaveBeenCalledWith(
          "omp",
          undefined,
          undefined,
          remote,
        );
      } else {
        expect(result.current.fetchStatus).toBe("idle");
        expect(usageApi.getUsageFirstDate).not.toHaveBeenCalled();
      }
      client.clear();
    },
  );
});
