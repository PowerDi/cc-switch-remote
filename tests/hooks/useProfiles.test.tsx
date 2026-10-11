import type { ReactNode } from "react";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useApplyProfileMutation,
  useClearProfileMutation,
  useCreateProfileMutation,
  useDeleteProfileMutation,
  useProfilesQuery,
  useUpdateProfileMutation,
} from "@/lib/query/profiles";
import {
  useTargetConnectionEpoch,
  withConnectionEpoch,
} from "@/hooks/useTargetConnectionEpoch";
import { promptKeys } from "@/lib/query/prompts";
import type { ManagementTarget } from "@/lib/api/remote";
import type { ProfilesResponse } from "@/lib/api/profiles";

const rpc = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  clearCurrent: vi.fn(),
  apply: vi.fn(),
  tray: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/api/profiles", () => ({ profilesApi: rpc }));
vi.mock("@/lib/api", () => ({ providersApi: { updateTrayMenu: rpc.tray } }));
vi.mock("@/lib/toast", () => ({ toast }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const local: ManagementTarget = { type: "local" };
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "remote-1",
    name: "Remote 1",
    host: "192.0.2.20",
    port: 22,
    username: "root",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "old-secret" },
};
const changed: ManagementTarget = {
  ...remote,
  profile: { ...remote.profile, host: "192.0.2.21" },
  secret: { password: "new-secret" },
};
const other: ManagementTarget = {
  ...remote,
  profile: { ...remote.profile, id: "remote-2" },
};
const response = (name: string): ProfilesResponse => ({
  profiles: [
    {
      id: "project",
      name,
      payload: {
        providers: { claude: null, "claude-desktop": null, codex: null },
        mcp: { claude: null, "claude-desktop": null, codex: null },
        skills: { claude: null, "claude-desktop": null, codex: null },
        prompts: { claude: null, "claude-desktop": null, codex: null },
      },
    },
  ],
  currentIds: { claude: null, claudeDesktop: null, codex: "project" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
beforeEach(() => {
  Object.values(rpc).forEach((mock) => mock.mockReset());
  Object.values(toast).forEach((mock) => mock.mockReset());
  rpc.list.mockResolvedValue(response("project"));
  rpc.create.mockResolvedValue(response("created").profiles[0]);
  rpc.update.mockResolvedValue(response("updated").profiles[0]);
  rpc.apply.mockResolvedValue([]);
});
const operations = [
  {
    name: "create",
    mock: rpc.create,
    args: ["new", "codex"],
    useRun: (target: ManagementTarget) => {
      const mutation = useCreateProfileMutation(target);
      return () => mutation.mutateAsync({ name: "new", scope: "codex" });
    },
  },
  {
    name: "update",
    mock: rpc.update,
    args: ["project", { name: "renamed", scope: "claude", resnapshot: true }],
    useRun: (target: ManagementTarget) => {
      const mutation = useUpdateProfileMutation(target);
      return () =>
        mutation.mutateAsync({
          id: "project",
          name: "renamed",
          scope: "claude",
          resnapshot: true,
        });
    },
  },
  {
    name: "delete",
    mock: rpc.delete,
    args: ["project"],
    useRun: (target: ManagementTarget) => {
      const mutation = useDeleteProfileMutation(target);
      return () => mutation.mutateAsync("project");
    },
  },
  {
    name: "clear",
    mock: rpc.clearCurrent,
    args: ["codex"],
    useRun: (target: ManagementTarget) => {
      const mutation = useClearProfileMutation(target);
      return () => mutation.mutateAsync("codex");
    },
  },
  {
    name: "apply",
    mock: rpc.apply,
    args: ["project", "codex"],
    useRun: (target: ManagementTarget) => {
      const mutation = useApplyProfileMutation(target);
      return () => mutation.mutateAsync({ id: "project", scope: "codex" });
    },
  },
];

describe("profile mutations", () => {
  it.each(operations)(
    "$name preserves local behavior and feedback",
    async (operation) => {
      const { wrapper } = setup();
      const { result } = renderHook(() => operation.useRun(local), { wrapper });
      await act(async () => {
        await result.current();
      });
      expect(operation.mock).toHaveBeenCalledWith(...operation.args, local);
      expect(rpc.tray).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith(
        `profiles.${operation.name}Success`,
        { closeButton: true },
      );
    },
  );
  it.each(operations)(
    "$name completion stays remote after switching the observer to local",
    async (operation) => {
      const pending = deferred<unknown>();
      operation.mock.mockReturnValueOnce(pending.promise);
      const { wrapper, invalidate } = setup();
      const { result, rerender } = renderHook(
        ({ target }) => operation.useRun(target),
        { wrapper, initialProps: { target: remote as ManagementTarget } },
      );
      let finished!: Promise<unknown>;
      act(() => {
        finished = result.current();
      });
      await waitFor(() => expect(operation.mock).toHaveBeenCalledTimes(1));
      rerender({ target: local });
      await act(async () => {
        pending.resolve(operation.name === "apply" ? [] : undefined);
        await finished;
      });
      expect(operation.mock).toHaveBeenCalledWith(...operation.args, remote);
      expect(rpc.tray).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalled();
      for (const [filters] of invalidate.mock.calls) {
        expect(filters?.queryKey).toContain("remote:remote-1");
        expect(JSON.stringify(filters?.queryKey)).not.toContain("secret");
      }
    },
  );
  it("does not refresh replacement host/credentials under the same profile ID", async () => {
    const pending = deferred<string[]>();
    rpc.apply.mockReturnValueOnce(pending.promise);
    const { wrapper, invalidate } = setup();
    const { result, rerender } = renderHook(
      ({ target }) => useApplyProfileMutation(target),
      { wrapper, initialProps: { target: remote as ManagementTarget } },
    );
    let finished!: Promise<string[]>;
    act(() => {
      finished = result.current.mutateAsync({ id: "project", scope: "codex" });
    });
    await waitFor(() => expect(rpc.apply).toHaveBeenCalledTimes(1));
    rerender({ target: changed });
    await act(async () => {
      pending.resolve([]);
      await finished;
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(rpc.tray).not.toHaveBeenCalled();
  });
  it("stops refreshing if connection identity changes during an awaited refetch", async () => {
    const { wrapper, invalidate } = setup();
    const refetch = deferred<void>();
    invalidate.mockReturnValueOnce(refetch.promise);
    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useApplyProfileMutation(target),
      { wrapper, initialProps: { target: remote as ManagementTarget } },
    );
    let finished!: Promise<string[]>;
    act(() => {
      finished = result.current.mutateAsync({ id: "project", scope: "codex" });
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    rerender({ target: changed });
    await act(async () => {
      refetch.resolve();
      await finished;
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(rpc.tray).not.toHaveBeenCalled();
  });

  it("keeps local completion local after switching to remote", async () => {
    const pending = deferred<string[]>();
    rpc.apply.mockReturnValueOnce(pending.promise);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ target }) => useApplyProfileMutation(target),
      { wrapper, initialProps: { target: local as ManagementTarget } },
    );
    let finished!: Promise<string[]>;
    act(() => {
      finished = result.current.mutateAsync({ id: "project", scope: "codex" });
    });
    await waitFor(() => expect(rpc.apply).toHaveBeenCalledTimes(1));
    rerender({ target: remote });
    await act(async () => {
      pending.resolve([]);
      await finished;
    });
    expect(rpc.apply).toHaveBeenCalledWith("project", "codex", local);
    expect(rpc.tray).toHaveBeenCalledTimes(1);
  });
  it("retains warning and failure semantics without clearing cached state", async () => {
    const { wrapper, client, invalidate } = setup();
    const { result } = renderHook(() => useApplyProfileMutation(remote), {
      wrapper,
    });
    rpc.apply.mockResolvedValueOnce(["provider missing"]);
    await act(async () => {
      await result.current.mutateAsync({ id: "project", scope: "claude" });
    });
    expect(toast.warning).toHaveBeenCalledWith("profiles.applyWarnings", {
      closeButton: true,
      duration: 10000,
    });
    expect(toast.success).not.toHaveBeenCalled();
    invalidate.mockClear();
    client.setQueryData(["providers", "claude", "remote:remote-1"], "previous");
    rpc.apply.mockRejectedValueOnce(new Error("validation failed"));
    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: "project", scope: "claude" }),
      ).rejects.toThrow("validation failed");
    });
    expect(
      client.getQueryData(["providers", "claude", "remote:remote-1"]),
    ).toBe("previous");
    expect(invalidate).not.toHaveBeenCalled();
    expect(rpc.tray).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("profiles.applyFailed", {
      closeButton: true,
    });
  });
  it.each([local, remote])(
    "refreshes only the submitted target and affected scope ($type)",
    async (target) => {
      const { wrapper, client } = setup();
      const { result } = renderHook(
        () => ({
          mutation: useApplyProfileMutation(target),
          epoch: useTargetConnectionEpoch(target),
        }),
        { wrapper },
      );
      const targetKey = target.type === "local" ? "local" : "remote:remote-1";
      const affected = [
        ["providers", "codex", targetKey],
        ["mcp", "all", targetKey],
        ["skills", "installed", targetKey],
        withConnectionEpoch(
          promptKeys.list("codex", target),
          result.current.epoch,
        ),
      ];
      const untouched = [
        ["providers", "claude", targetKey],
        ["providers", "codex", "remote:remote-2"],
        ["skills", "installed", "remote:remote-2"],
        ["skills", "skillssh", "catalog"],
        ["prompts", "list", "codex", "remote:remote-2", "connection", 999],
      ];
      if (target.type === "remote")
        untouched.push(
          ["providers", "codex", "mode"],
          ["skills", "installed", "local"],
          ["prompts", "list", "codex"],
        );
      for (const key of [...affected, ...untouched])
        client.setQueryData(key, "cached");
      await act(async () => {
        await result.current.mutation.mutateAsync({
          id: "project",
          scope: "codex",
        });
      });
      for (const key of affected)
        expect(
          client.getQueryState(key)?.isInvalidated,
          JSON.stringify(key),
        ).toBe(true);
      for (const key of untouched)
        expect(
          client.getQueryState(key)?.isInvalidated,
          JSON.stringify(key),
        ).toBe(false);
    },
  );
});

describe("profile read identity", () => {
  it.each([changed, other, local])(
    "never renders another connection's cached list ($type)",
    async (target) => {
      rpc.list.mockResolvedValueOnce(response("old"));
      const { wrapper, client } = setup();
      const first = renderHook(() => useProfilesQuery(remote), { wrapper });
      await waitFor(() =>
        expect(first.result.current.data?.profiles[0].name).toBe("old"),
      );
      first.unmount();
      const pending = deferred<ProfilesResponse>();
      rpc.list.mockReturnValueOnce(pending.promise);
      const second = renderHook(() => useProfilesQuery(target), { wrapper });
      expect(second.result.current.data).toBeUndefined();
      await act(async () => pending.resolve(response("new")));
      await waitFor(() =>
        expect(second.result.current.data?.profiles[0].name).toBe("new"),
      );
      const keys = JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      );
      expect(keys).not.toContain("secret");
      expect(keys).not.toContain(remote.profile.host);
    },
  );
});
