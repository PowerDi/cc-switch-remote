import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementTarget } from "@/lib/api/remote";
import type { UsageRangeSelection } from "@/types/usage";
import {
  useUsageSummary,
  useSessionUsageLastSync,
  useSessionUsageSummary,
  useProviderLimits,
  usageKeys,
} from "@/lib/query/usage";

const api = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  getSessionUsageLastSync: vi.fn(),
  getSessionUsageSummary: vi.fn(),
  checkProviderLimits: vi.fn(),
}));
vi.mock("@/lib/api/usage", () => ({ usageApi: api }));

const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "usage-host",
    name: "Usage host",
    host: "192.0.2.40",
    port: 22,
    username: "tester",
    authMethod: { type: "password" },
    helperPath: "~/.local/bin/cc-switch-remote-helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "first-private-password" },
};
const local: ManagementTarget = { type: "local" };
const clients: QueryClient[] = [];
function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(value);
  return value;
}
const today: UsageRangeSelection = { preset: "today" };
function mount(target: ManagementTarget, queryClient = client()) {
  return {
    client: queryClient,
    ...renderHook(
      ({ target, range }) =>
        useUsageSummary(range, undefined, { refetchInterval: false }, target),
      {
        initialProps: { target, range: today },
        wrapper: wrapperFor(queryClient),
      },
    ),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((value) => value.clear());
});

describe("usage target isolation after v4 keepPreviousData merge", () => {
  it("preserves local filtering placeholders and the original local API", async () => {
    api.getUsageSummary.mockResolvedValueOnce({ totalRequests: 7 });
    const next = deferred<unknown>();
    const view = mount(local);
    await waitFor(() =>
      expect(view.result.current.data?.totalRequests).toBe(7),
    );
    api.getUsageSummary.mockReturnValueOnce(next.promise);
    view.rerender({ target: local, range: { preset: "all" } });
    expect(view.result.current.data?.totalRequests).toBe(7);
    expect(view.result.current.isPlaceholderData).toBe(true);
    expect(api.getUsageSummary).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      undefined,
      local,
    );
    await act(async () => {
      next.resolve({ totalRequests: 8 });
    });
    await waitFor(() =>
      expect(view.result.current.data?.totalRequests).toBe(8),
    );
  });

  it("does not display local data while switching to a remote host", async () => {
    api.getUsageSummary.mockResolvedValueOnce({ totalRequests: 17 });
    const next = deferred<unknown>();
    const view = mount(local);
    await waitFor(() =>
      expect(view.result.current.data?.totalRequests).toBe(17),
    );
    api.getUsageSummary.mockReturnValueOnce(next.promise);
    view.rerender({ target: remote, range: today });
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.isPlaceholderData).toBe(false);
    expect(api.getUsageSummary.mock.calls.slice(-1)[0]?.slice(-1)[0]).toBe(
      remote,
    );
    await act(async () => {
      next.resolve({ totalRequests: 27 });
    });
    await waitFor(() =>
      expect(view.result.current.data?.totalRequests).toBe(27),
    );
  });

  it("preserves remote filter placeholders only for the same connection", async () => {
    api.getUsageSummary.mockResolvedValueOnce({ totalRequests: 2 });
    const pending = deferred<unknown>();
    const view = mount(remote);
    await waitFor(() =>
      expect(view.result.current.data?.totalRequests).toBe(2),
    );
    api.getUsageSummary.mockReturnValueOnce(pending.promise);
    view.rerender({ target: remote, range: { preset: "all" } });
    expect(view.result.current.data?.totalRequests).toBe(2);
    expect(view.result.current.isPlaceholderData).toBe(true);
    await act(async () => {
      pending.resolve({ totalRequests: 3 });
    });
  });

  it("isolates changed credentials, stale completions, and remounted observers", async () => {
    const old = deferred<unknown>();
    const next = deferred<unknown>();
    const changed: ManagementTarget = {
      ...remote,
      secret: { password: "second-private-password" },
    };
    api.getUsageSummary
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    const view = mount(remote);
    await waitFor(() => expect(api.getUsageSummary).toHaveBeenCalledTimes(1));
    view.rerender({ target: changed, range: today });
    await waitFor(() => expect(api.getUsageSummary).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.resolve({ totalRequests: 111 });
    });
    expect(view.result.current.data).toBeUndefined();
    await act(async () => {
      next.resolve({ totalRequests: 222 });
    });
    await waitFor(() =>
      expect(view.result.current.data?.totalRequests).toBe(222),
    );
    view.unmount();
    api.getUsageSummary.mockImplementation(() => new Promise(() => {}));
    const remount = mount(changed, view.client);
    expect(remount.result.current.data?.totalRequests).toBe(222);
    const keys = view.client
      .getQueryCache()
      .getAll()
      .map((entry) => entry.queryKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
    expect(JSON.stringify(keys)).not.toContain("private-password");
    expect(JSON.stringify(keys)).not.toContain(remote.profile.host);
  });

  it("keeps new identity keys under target-scoped invalidation prefixes", async () => {
    api.getUsageSummary.mockResolvedValue({ totalRequests: 1 });
    const cache = client();
    const a = mount(remote, cache);
    const bTarget: ManagementTarget = {
      ...remote,
      profile: { ...remote.profile, id: "other" },
    };
    const b = mount(bTarget, cache);
    await waitFor(() =>
      expect(a.result.current.isSuccess && b.result.current.isSuccess).toBe(
        true,
      ),
    );
    await cache.invalidateQueries({
      queryKey: usageKeys.all(remote),
      refetchType: "none",
    });
    const entries = cache.getQueryCache().getAll();
    expect(
      entries.find((entry) => entry.queryKey[2] === "usage-host")?.state
        .isInvalidated,
    ).toBe(true);
    expect(
      entries.find((entry) => entry.queryKey[2] === "other")?.state
        .isInvalidated,
    ).toBe(false);
  });

  it("does not poll unavailable per-session, scanner, or limit reads on remote targets", async () => {
    const view = renderHook(
      () => ({
        scan: useSessionUsageLastSync(remote),
        summary: useSessionUsageSummary("codex", "session", remote),
        limits: useProviderLimits("provider", "codex", remote),
      }),
      { wrapper: wrapperFor(client()) },
    );
    expect(view.result.current.scan.fetchStatus).toBe("idle");
    expect(view.result.current.summary.fetchStatus).toBe("idle");
    expect(view.result.current.limits.fetchStatus).toBe("idle");
    expect(api.getSessionUsageLastSync).not.toHaveBeenCalled();
    expect(api.getSessionUsageSummary).not.toHaveBeenCalled();
    expect(api.checkProviderLimits).not.toHaveBeenCalled();
  });
});
