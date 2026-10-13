import type { PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useBulkToggleSkillApp,
  useDeleteSkillBackup,
  useRestoreSkillBackup,
  useToggleSkillApp,
  useUninstallSkill,
  useUpdateSkill,
} from "@/hooks/useSkills";
import type { ManagementTarget } from "@/lib/api/remote";
import type {
  SkillBackupEntry,
  SkillUpdateCheckResult,
} from "@/lib/api/skills";
import { getManagementTargetKey } from "@/lib/managementTarget";

const mocks = vi.hoisted(() => ({
  toggleApp: vi.fn(),
  restoreBackup: vi.fn(),
  uninstallUnified: vi.fn(),
  deleteBackup: vi.fn(),
  updateSkill: vi.fn(),
}));
vi.mock("@/lib/api/skills", () => ({ skillsApi: mocks }));
const targets: ManagementTarget[] = [
  { type: "local" },
  {
    type: "remote",
    profile: {
      id: "server-a",
      name: "Server A",
      host: "192.0.2.4",
      port: 22,
      username: "tester",
      authMethod: { type: "sshAgent" },
      helperPath: "/bin/helper",
      createdAt: 0,
      updatedAt: 0,
    },
    secret: { password: "fixture-secret" },
  },
];
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
function useActions(target: ManagementTarget) {
  return {
    bulk: useBulkToggleSkillApp(target),
    toggle: useToggleSkillApp(target),
    restore: useRestoreSkillBackup(target),
    uninstall: useUninstallSkill(target),
    update: useUpdateSkill(target),
    deleteBackup: useDeleteSkillBackup(target),
  };
}
beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe.each(targets)("Skills lifecycle ($type)", (target) => {
  const key = (collection: string) => [
    "skills",
    collection,
    getManagementTargetKey(target),
  ];
  it("keeps every bulk write and refresh on its selected target", async () => {
    mocks.toggleApp.mockResolvedValue(undefined);
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useBulkToggleSkillApp(target), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        ids: ["alpha", "beta"],
        app: "claude",
        enabled: true,
      });
    });
    expect(mocks.toggleApp.mock.calls).toEqual([
      ["alpha", "claude", true, target],
      ["beta", "claude", true, target],
    ]);
    expect(invalidate.mock.calls).toEqual([[{ queryKey: key("installed") }]]);
  });

  it("continues after an item fails and reports success and failure separately", async () => {
    mocks.toggleApp
      .mockRejectedValueOnce(new Error("alpha failed"))
      .mockResolvedValueOnce(undefined);
    const { wrapper } = setup();
    const { result } = renderHook(() => useBulkToggleSkillApp(target), {
      wrapper,
    });
    await act(async () => {
      const outcome = await result.current.mutateAsync({
        ids: ["alpha", "beta"],
        app: "codex",
        enabled: false,
      });
      expect(outcome.succeeded).toEqual(["beta"]);
      expect(outcome.failed).toEqual([
        {
          item: "alpha",
          error: expect.objectContaining({ message: "alpha failed" }),
        },
      ]);
    });
    expect(mocks.toggleApp.mock.calls).toEqual([
      ["alpha", "codex", false, target],
      ["beta", "codex", false, target],
    ]);
  });

  // Preserve upstream's pending-until-refreshed contract for success and failure.
  it.each([
    { action: "bulk", fails: false, collections: ["installed"] },
    { action: "toggle", fails: false, collections: ["installed"] },
    { action: "restore", fails: false, collections: ["installed", "backups"] },
    { action: "restore", fails: true, collections: ["installed", "backups"] },
    { action: "uninstall", fails: true, collections: ["backups", "unmanaged"] },
    { action: "update", fails: true, collections: ["backups"] },
    { action: "deleteBackup", fails: true, collections: ["backups"] },
  ] as const)(
    "$action (failure=$fails) stays pending until affected caches refresh",
    async ({ action, fails, collections }) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error("operation rejected");
      Object.values(mocks).forEach((mock) =>
        fails
          ? mock.mockRejectedValue(failure)
          : mock.mockResolvedValue(undefined),
      );
      const { client, wrapper } = setup();
      const invalidate = vi
        .spyOn(client, "invalidateQueries")
        .mockImplementation(() => pending);
      const { result } = renderHook(() => useActions(target), { wrapper });
      let operation!: Promise<unknown>;
      act(() => {
        const actions = result.current;
        switch (action) {
          case "bulk":
            operation = actions.bulk.mutateAsync({
              ids: ["alpha", "beta"],
              app: "claude",
              enabled: true,
            });
            break;
          case "toggle":
            operation = actions.toggle.mutateAsync({
              id: "alpha",
              app: "claude",
              enabled: true,
            });
            break;
          case "restore":
            operation = actions.restore.mutateAsync({
              backupId: "backup-1",
              currentApp: "claude",
            });
            break;
          case "uninstall":
            operation = actions.uninstall.mutateAsync("alpha");
            break;
          case "update":
            operation = actions.update.mutateAsync("alpha");
            break;
          case "deleteBackup":
            operation = actions.deleteBackup.mutateAsync("backup-1");
            break;
        }
        void operation.catch(() => undefined);
      });
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledTimes(collections.length),
      );
      expect(result.current[action].isPending).toBe(true);
      expect(invalidate.mock.calls).toEqual(
        collections.map((collection) => [{ queryKey: key(collection) }]),
      );
      await act(async () => {
        release();
        if (fails)
          await expect(operation).rejects.toThrow("operation rejected");
        else await operation;
      });
      await waitFor(() => expect(result.current[action].isPending).toBe(false));
    },
  );

  it("removes an uninstalled Skill from update results without dropping failures or other targets", async () => {
    mocks.uninstallUnified.mockResolvedValue({ backupPath: null });
    const { client, wrapper } = setup();
    const report: SkillUpdateCheckResult = {
      updates: [
        { id: "alpha", name: "Alpha", remoteHash: "a" },
        { id: "beta", name: "Beta", remoteHash: "b" },
      ],
      failures: [{ owner: "o", name: "r", branch: "main", error: "offline" }],
    };
    client.setQueryData(key("updates"), report);
    client.setQueryData(["skills", "updates", "remote:other"], report);
    const { result } = renderHook(() => useUninstallSkill(target), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("alpha");
    });
    expect(mocks.uninstallUnified).toHaveBeenCalledWith("alpha", target);
    expect(client.getQueryData(key("updates"))).toEqual({
      updates: [report.updates[1]],
      failures: report.failures,
    });
    expect(client.getQueryData(["skills", "updates", "remote:other"])).toEqual(
      report,
    );
  });

  it("removes a successfully deleted backup before a refresh failure", async () => {
    mocks.deleteBackup.mockResolvedValue(true);
    const { client, wrapper } = setup();
    client.setQueryData<SkillBackupEntry[]>(key("backups"), [
      { backupId: "backup-1" } as SkillBackupEntry,
      { backupId: "backup-2" } as SkillBackupEntry,
    ]);
    vi.spyOn(client, "invalidateQueries").mockRejectedValueOnce(
      new Error("refresh failed"),
    );
    const { result } = renderHook(() => useDeleteSkillBackup(target), {
      wrapper,
    });
    await act(async () => {
      await expect(result.current.mutateAsync("backup-1")).rejects.toThrow(
        "refresh failed",
      );
    });
    expect(client.getQueryData(key("backups"))).toEqual([
      { backupId: "backup-2" },
    ]);
  });
});
