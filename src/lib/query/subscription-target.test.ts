import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionApi } from "@/lib/api/subscription";
import type { ManagementTarget, RemoteHostProfile } from "@/lib/api";
import {
  subscriptionKeys,
  useCodexOauthQuotaByAccountId,
  useSubscriptionQuota,
  useXaiOauthQuota,
  useXaiOauthQuotaByAccountId,
} from "./subscription";
import type { SubscriptionQuota } from "@/types/subscription";
import {
  useTargetConnectionEpoch,
  withConnectionEpoch,
} from "@/hooks/useTargetConnectionEpoch";

const remoteProfile: RemoteHostProfile = {
  id: "server-a",
  name: "Server A",
  host: "192.0.2.10",
  port: 22,
  username: "root",
  authMethod: { type: "sshAgent" },
  helperPath: "/root/.local/bin/cc-switch-remote-helper",
  createdAt: 1,
  updatedAt: 1,
};

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile: remoteProfile,
  secret: { password: "secret" },
};

const quotaResult = (
  tool: string,
  queriedAt: number,
  options: { success?: boolean; error?: string | null } = {},
): SubscriptionQuota => ({
  tool,
  credentialStatus: "valid",
  credentialMessage: null,
  success: options.success ?? true,
  tiers: [],
  extraUsage: null,
  error: options.error ?? null,
  queriedAt,
});

const nextRemoteTarget: ManagementTarget = {
  ...remoteTarget,
  secret: { password: "new-secret" },
};

const nextRemoteHostTarget: ManagementTarget = {
  ...remoteTarget,
  profile: {
    ...remoteTarget.profile,
    host: "192.0.2.11",
    updatedAt: 2,
  },
};

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
};

describe("Codex OAuth quota target isolation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps remote account quota requests and cache keys remote-qualified", async () => {
    const getQuotaSpy = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockResolvedValue({
        tool: "codex_oauth",
        credentialStatus: "valid",
        credentialMessage: null,
        success: true,
        tiers: [],
        extraUsage: null,
        error: null,
        queriedAt: 1,
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(
      () =>
        useCodexOauthQuotaByAccountId("remote-account", {
          target: remoteTarget,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getQuotaSpy).toHaveBeenCalledWith("remote-account", remoteTarget);
    expect(getQuotaSpy).not.toHaveBeenCalledWith(
      "local-account",
      expect.anything(),
    );
    expect(
      queryClient.getQueryCache().find({
        exact: false,
        queryKey: ["codex_oauth", "quota", "remote:server-a", "remote-account"],
      })?.state.data,
    ).toEqual(expect.objectContaining({ tool: "codex_oauth" }));
  });

  it("builds quota keys with the selected management target", () => {
    expect(
      subscriptionKeys.codexOauthQuota("remote-account", remoteTarget),
    ).toEqual(["codex_oauth", "quota", "remote:server-a", "remote-account"]);
    expect(subscriptionKeys.codexOauthQuota("local-account")).toEqual([
      "codex_oauth",
      "quota",
      "local",
      "local-account",
    ]);
  });

  it("reloads account quota when the same remote profile gets new connection credentials", async () => {
    const getQuotaSpy = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockImplementation((_, target) =>
        Promise.resolve({
          tool: "codex_oauth",
          credentialStatus: "valid",
          credentialMessage: null,
          success: true,
          tiers: [],
          extraUsage: null,
          error: null,
          queriedAt: target === remoteTarget ? 1 : 2,
        }),
      );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useCodexOauthQuotaByAccountId("remote-account", { target }),
      {
        initialProps: { target: remoteTarget },
        wrapper,
      },
    );

    await waitFor(() => expect(result.current.data?.queriedAt).toBe(1));

    rerender({ target: nextRemoteHostTarget });

    await waitFor(() => expect(getQuotaSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.data?.queriedAt).toBe(2));
    expect(getQuotaSpy.mock.calls).toEqual([
      ["remote-account", remoteTarget],
      ["remote-account", nextRemoteHostTarget],
    ]);
  });

  it("does not show the previous connection's Codex quota when the replacement connection returns a transient failure", async () => {
    vi.spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockResolvedValueOnce(quotaResult("codex_oauth", 1))
      .mockResolvedValueOnce(
        quotaResult("codex_oauth", 2, {
          success: false,
          error: "API error (HTTP 503)",
        }),
      );
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useCodexOauthQuotaByAccountId("remote-account", { target }),
      { initialProps: { target: remoteTarget }, wrapper },
    );

    await waitFor(() => expect(result.current.data?.queriedAt).toBe(1));

    rerender({ target: nextRemoteTarget });

    await waitFor(() => expect(result.current.data?.queriedAt).toBe(2));
    expect(result.current.data).toEqual(
      expect.objectContaining({
        success: false,
        error: "API error (HTTP 503)",
      }),
    );
  });

  it("ignores a previous connection's quota response when it arrives after the replacement response", async () => {
    let resolveOld: (value: SubscriptionQuota) => void = () => undefined;
    let resolveNext: (value: SubscriptionQuota) => void = () => undefined;
    const oldRequest = new Promise<SubscriptionQuota>((resolve) => {
      resolveOld = resolve;
    });
    const nextRequest = new Promise<SubscriptionQuota>((resolve) => {
      resolveNext = resolve;
    });
    const getQuotaSpy = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockReturnValueOnce(oldRequest)
      .mockReturnValueOnce(nextRequest);
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useCodexOauthQuotaByAccountId("remote-account", { target }),
      { initialProps: { target: remoteTarget }, wrapper },
    );

    await waitFor(() => expect(getQuotaSpy).toHaveBeenCalledTimes(1));
    rerender({ target: nextRemoteTarget });
    await waitFor(() => expect(getQuotaSpy).toHaveBeenCalledTimes(2));

    await act(async () => resolveNext(quotaResult("codex_oauth", 2)));
    await waitFor(() => expect(result.current.data?.queriedAt).toBe(2));

    await act(async () => resolveOld(quotaResult("codex_oauth", 1)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.data?.queriedAt).toBe(2);
  });
});

describe("quota sibling target isolation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads standard subscription quota for a replacement connection under the same profile id", async () => {
    const getQuotaSpy = vi
      .spyOn(subscriptionApi, "getQuota")
      .mockImplementation((tool, target) =>
        Promise.resolve(quotaResult(tool, target === remoteTarget ? 1 : 2)),
      );
    const { queryClient, wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useSubscriptionQuota("claude", true, false, 5, target),
      { initialProps: { target: remoteTarget }, wrapper },
    );

    await waitFor(() => expect(result.current.data?.queriedAt).toBe(1));
    expect(
      queryClient.getQueryCache().find({
        exact: false,
        queryKey: ["subscription", "quota", "remote:server-a", "claude"],
      })?.state.data,
    ).toEqual(expect.objectContaining({ queriedAt: 1 }));

    rerender({ target: nextRemoteTarget });

    await waitFor(() => expect(getQuotaSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.data?.queriedAt).toBe(2));
  });

  it("reloads xAI quota without reusing a transient last-good result from the previous connection", async () => {
    const getQuotaSpy = vi
      .spyOn(subscriptionApi, "getXaiOauthQuota")
      .mockResolvedValueOnce(quotaResult("xai_oauth", 1))
      .mockResolvedValueOnce(
        quotaResult("xai_oauth", 2, {
          success: false,
          error: "HTTP 429 rate limited",
        }),
      );
    const meta = {
      authBinding: {
        source: "managed_account" as const,
        authProvider: "xai_oauth",
        accountId: "xai-account",
      },
    };
    const { queryClient, wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useXaiOauthQuota(meta, { target }),
      { initialProps: { target: remoteTarget }, wrapper },
    );

    await waitFor(() => expect(result.current.data?.queriedAt).toBe(1));
    expect(
      queryClient.getQueryCache().find({
        exact: false,
        queryKey: ["xai_oauth", "quota", "remote:server-a", "xai-account"],
      })?.state.data,
    ).toEqual(expect.objectContaining({ queriedAt: 1 }));

    rerender({ target: nextRemoteTarget });

    await waitFor(() => expect(getQuotaSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.data?.queriedAt).toBe(2));
    expect(result.current.data?.success).toBe(false);
  });

  it("shares the xAI account-row and provider-footer query for the same target", async () => {
    const spy = vi
      .spyOn(subscriptionApi, "getXaiOauthQuota")
      .mockResolvedValue(quotaResult("xai_oauth", 12));
    const { wrapper, queryClient } = createWrapper();
    const meta = {
      authBinding: {
        source: "managed_account" as const,
        authProvider: "xai_oauth",
        accountId: "xai-account",
      },
    };
    const { result } = renderHook(
      () => ({
        row: useXaiOauthQuotaByAccountId("xai-account", {
          target: remoteTarget,
        }),
        footer: useXaiOauthQuota(meta, { target: remoteTarget }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.row.data?.queriedAt).toBe(12));
    expect(result.current.footer.data?.queriedAt).toBe(12);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("xai-account", remoteTarget);
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0].slice(0, 4)).toEqual(
      subscriptionKeys.xaiOauthQuota("xai-account", remoteTarget),
    );
    expect(keys[0].slice(4)).toEqual(["connection", expect.any(Number)]);
    expect(JSON.stringify(keys)).not.toContain("secret");
    expect(JSON.stringify(keys)).not.toContain(remoteProfile.host);
  });

  it.each([
    ["credentials", nextRemoteTarget],
    ["hostname", nextRemoteHostTarget],
  ] as const)(
    "does not flash cached quota when remounting after a %s change",
    async (_change, target) => {
      let complete!: (value: SubscriptionQuota) => void;
      const next = new Promise<SubscriptionQuota>((resolve) => {
        complete = resolve;
      });
      const spy = vi
        .spyOn(subscriptionApi, "getCodexOauthQuota")
        .mockResolvedValueOnce(quotaResult("codex_oauth", 1))
        .mockReturnValueOnce(next);
      const { wrapper, queryClient } = createWrapper();
      const first = renderHook(
        () =>
          useCodexOauthQuotaByAccountId("account", { target: remoteTarget }),
        { wrapper },
      );
      await waitFor(() => expect(first.result.current.data?.queriedAt).toBe(1));
      first.unmount();
      const rendered: Array<number | null | undefined> = [];
      const second = renderHook(
        () => {
          const quota = useCodexOauthQuotaByAccountId("account", { target });
          rendered.push(quota.data?.queriedAt);
          return quota;
        },
        { wrapper },
      );
      expect(second.result.current.data).toBeUndefined();
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      await act(async () =>
        complete(
          quotaResult("codex_oauth", 2, { success: false, error: "HTTP 503" }),
        ),
      );
      await waitFor(() =>
        expect(second.result.current.data?.queriedAt).toBe(2),
      );
      expect(second.result.current.data?.success).toBe(false);
      expect(rendered).not.toContain(1);
      const keys = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toEqual(keys[1]);
      expect(JSON.stringify(keys)).not.toContain("secret");
    },
  );

  it("keeps last-good only for the same xAI account and target", async () => {
    const spy = vi
      .spyOn(subscriptionApi, "getXaiOauthQuota")
      .mockResolvedValueOnce(quotaResult("xai_oauth", 1))
      .mockResolvedValueOnce(
        quotaResult("xai_oauth", 2, { success: false, error: "HTTP 503" }),
      )
      .mockResolvedValueOnce(
        quotaResult("xai_oauth", 3, { success: false, error: "HTTP 503" }),
      );
    const { wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ accountId }) =>
        useXaiOauthQuotaByAccountId(accountId, { target: remoteTarget }),
      { initialProps: { accountId: "first" }, wrapper },
    );
    await waitFor(() => expect(result.current.data?.queriedAt).toBe(1));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data?.queriedAt).toBe(1);
    rerender({ accountId: "second" });
    await waitFor(() => expect(result.current.data?.queriedAt).toBe(3));
    expect(result.current.data?.success).toBe(false);
    expect(spy).toHaveBeenLastCalledWith("second", remoteTarget);
  });

  it("publishes manual quota results only into the matching connection cache", async () => {
    const spy = vi
      .spyOn(subscriptionApi, "getQuota")
      .mockResolvedValueOnce(quotaResult("claude", 1))
      .mockResolvedValueOnce(quotaResult("claude", 2));
    const { queryClient, wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) => {
        const epoch = useTargetConnectionEpoch(target);
        const quota = useSubscriptionQuota("claude", true, false, 5, target);
        const key =
          target.type === "remote" ? `remote:${target.profile.id}` : "local";
        return {
          quota,
          publish: (data: SubscriptionQuota) =>
            queryClient.setQueryData(
              withConnectionEpoch(subscriptionKeys.quota("claude", key), epoch),
              data,
            ),
        };
      },
      { initialProps: { target: remoteTarget }, wrapper },
    );
    await waitFor(() => expect(result.current.quota.data?.queriedAt).toBe(1));
    const publishOld = result.current.publish;
    rerender({ target: nextRemoteTarget });
    await waitFor(() => expect(result.current.quota.data?.queriedAt).toBe(2));
    await act(async () => {
      publishOld(quotaResult("claude", 99));
    });
    expect(result.current.quota.data?.queriedAt).toBe(2);
    await act(async () => {
      result.current.publish(quotaResult("claude", 3));
    });
    await waitFor(() => expect(result.current.quota.data?.queriedAt).toBe(3));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not reset local quota when an equivalent local target object is rerendered", async () => {
    const getQuotaSpy = vi
      .spyOn(subscriptionApi, "getQuota")
      .mockResolvedValue(quotaResult("claude", 1));
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useSubscriptionQuota("claude", true, false, 5, target),
      {
        initialProps: { target: { type: "local" } as ManagementTarget },
        wrapper,
      },
    );

    await waitFor(() => expect(result.current.data?.queriedAt).toBe(1));
    rerender({ target: { type: "local" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getQuotaSpy).toHaveBeenCalledTimes(1);
  });
});
