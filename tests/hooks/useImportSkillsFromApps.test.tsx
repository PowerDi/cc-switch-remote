import type { PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeImportedSkills } from "@/hooks/useSkills.helpers";
import {
  useImportSkillsFromApps,
  useInstallSkill,
  useInstallSkillsFromZip,
  useUninstallSkill,
} from "@/hooks/useSkills";
import type {
  DiscoverableSkill,
  InstalledSkill,
  SkillDiscoveryResult,
} from "@/lib/api/skills";
import type { ManagementTarget } from "@/lib/api/remote";
import { getManagementTargetKey } from "@/lib/managementTarget";

const apiMocks = vi.hoisted(() => ({
  importFromApps: vi.fn(),
  installFromZip: vi.fn(),
  installUnified: vi.fn(),
  uninstallUnified: vi.fn(),
}));
vi.mock("@/lib/api/skills", () => ({ skillsApi: apiMocks }));
const targets: ManagementTarget[] = [
  { type: "local" },
  {
    type: "remote",
    profile: {
      id: "host-a",
      name: "Host A",
      host: "192.0.2.10",
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
function makeSkill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    id: "skill-a",
    name: "Skill A",
    directory: "skill-a",
    installedAt: 0,
    updatedAt: 0,
    apps: {
      claude: true,
      codex: false,
      gemini: false,
      opencode: false,
      openclaw: false,
      hermes: false,
      pi: false,
    },
    ...overrides,
  };
}
const discoverable: DiscoverableSkill = {
  key: "skill-a:owner:repo",
  name: "Skill A",
  description: "Description",
  directory: "skill-a",
  repoOwner: "owner",
  repoName: "repo",
  repoBranch: "main",
};
const discoveryReport: SkillDiscoveryResult = {
  skills: [discoverable],
  failures: [{ owner: "o", name: "failed", branch: "main", error: "offline" }],
};
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
beforeEach(() => Object.values(apiMocks).forEach((mock) => mock.mockReset()));
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

// Keep fork/upstream duplicate-import coverage, including previously corrupted caches.
describe("mergeImportedSkills", () => {
  it("returns the imported list when no cache exists", () => {
    const imported = [makeSkill()];
    expect(mergeImportedSkills(undefined, imported)).toEqual(imported);
  });
  it("deduplicates consecutive imports and uses the new record", () => {
    const existing = [makeSkill()];
    const next = makeSkill();
    const merged = mergeImportedSkills(existing, [next]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(next);
  });
  it("replaces stale names", () => {
    expect(
      mergeImportedSkills(
        [makeSkill({ name: "Old" })],
        [makeSkill({ name: "New" })],
      )[0].name,
    ).toBe("New");
  });
  it("keeps the same reference for an empty import", () => {
    const existing = [makeSkill()];
    expect(mergeImportedSkills(existing, [])).toBe(existing);
  });
  it("retains unrelated skills", () => {
    const second = makeSkill({ id: "skill-b" });
    expect(mergeImportedSkills([makeSkill()], [second])).toEqual([
      makeSkill(),
      second,
    ]);
  });
  it("deduplicates repeated incoming IDs using their last value", () => {
    const last = makeSkill({ name: "Last" });
    expect(mergeImportedSkills(undefined, [makeSkill(), last])).toEqual([last]);
  });
  it("repairs repeated IDs already present in the cache", () => {
    const last = makeSkill({ name: "Last" });
    const second = makeSkill({ id: "skill-b" });
    expect(mergeImportedSkills([makeSkill(), last], [second])).toEqual([
      last,
      second,
    ]);
  });
});

describe.each(targets)("Skill install/import ($type)", (target) => {
  const key = (collection: string) => [
    "skills",
    collection,
    getManagementTargetKey(target),
  ];
  it("merges successful install without rewriting the discovery report", async () => {
    const { client, wrapper } = setup();
    const installed = makeSkill({ name: "Fresh" });
    const unrelated = makeSkill({ id: "skill-b" });
    client.setQueryData(key("installed"), [makeSkill(), unrelated]);
    client.setQueryData(key("discoverable"), discoveryReport);
    apiMocks.installUnified.mockResolvedValue(installed);
    const { result } = renderHook(() => useInstallSkill(target), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        skill: discoverable,
        currentApp: "claude",
      });
    });
    expect(apiMocks.installUnified).toHaveBeenCalledWith(
      discoverable,
      "claude",
      target,
    );
    expect(client.getQueryData(key("installed"))).toEqual([
      installed,
      unrelated,
    ]);
    expect(client.getQueryData(key("discoverable"))).toBe(discoveryReport);
  });
  it("removes an installed item but not repository metadata on uninstall", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(key("installed"), [makeSkill()]);
    client.setQueryData(key("discoverable"), discoveryReport);
    apiMocks.uninstallUnified.mockResolvedValue({ backupPath: undefined });
    const { result } = renderHook(() => useUninstallSkill(target), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("skill-a");
    });
    expect(client.getQueryData(key("installed"))).toEqual([]);
    expect(client.getQueryData(key("discoverable"))).toBe(discoveryReport);
  });
  it("deduplicates imported records and refreshes all affected target collections", async () => {
    const { client, wrapper } = setup();
    const imported = makeSkill({ name: "Imported" });
    client.setQueryData(key("installed"), [makeSkill()]);
    apiMocks.importFromApps.mockResolvedValue([imported, imported]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useImportSkillsFromApps(target), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync([]);
    });
    expect(apiMocks.importFromApps).toHaveBeenCalledWith([], target);
    expect(client.getQueryData(key("installed"))).toEqual([imported]);
    expect(invalidate.mock.calls).toEqual(
      ["installed", "unmanaged", "repos", "discoverable"].map((collection) => [
        { queryKey: key(collection) },
      ]),
    );
  });
  it.each(["install", "import"] as const)(
    "rejected %s remains pending until refresh completes",
    async (action) => {
      const { client, wrapper } = setup();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      apiMocks.installUnified.mockRejectedValue(new Error("sync failed"));
      apiMocks.importFromApps.mockRejectedValue(new Error("sync failed"));
      const invalidate = vi
        .spyOn(client, "invalidateQueries")
        .mockImplementation(() => pending);
      const { result } = renderHook(
        () => ({
          install: useInstallSkill(target),
          import: useImportSkillsFromApps(target),
        }),
        { wrapper },
      );
      let operation!: Promise<unknown>;
      act(() => {
        operation =
          action === "install"
            ? result.current.install.mutateAsync({
                skill: discoverable,
                currentApp: "claude",
              })
            : result.current.import.mutateAsync([]);
        void operation.catch(() => undefined);
      });
      const affected =
        action === "install"
          ? ["installed", "unmanaged"]
          : ["installed", "unmanaged", "repos", "discoverable"];
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledTimes(affected.length),
      );
      expect(invalidate.mock.calls).toEqual(
        affected.map((collection) => [{ queryKey: key(collection) }]),
      );
      expect(result.current[action].isPending).toBe(true);
      await act(async () => {
        release();
        await expect(operation).rejects.toThrow("sync failed");
      });
      await waitFor(() => expect(result.current[action].isPending).toBe(false));
    },
  );
});

describe("local ZIP install", () => {
  it("merges new report results without duplicate IDs and preserves skipped metadata", async () => {
    const { client, wrapper } = setup();
    const last = makeSkill({ name: "Last" });
    const second = makeSkill({ id: "skill-b" });
    client.setQueryData(["skills", "installed", "local"], [makeSkill()]);
    const report = {
      installed: [makeSkill(), last, second],
      skipped: [
        {
          directory: "occupied",
          existingId: "existing",
          existingName: "Existing",
        },
      ],
    };
    apiMocks.installFromZip.mockResolvedValue(report);
    const { result } = renderHook(() => useInstallSkillsFromZip(), { wrapper });
    await act(async () => {
      expect(
        await result.current.mutateAsync({
          filePath: "C:\\skills.zip",
          currentApp: "claude",
        }),
      ).toEqual(report);
    });
    expect(client.getQueryData(["skills", "installed", "local"])).toEqual([
      last,
      second,
    ]);
  });
  it("refreshes installed and unmanaged lists when ZIP install rejects", async () => {
    const { client, wrapper } = setup();
    apiMocks.installFromZip.mockRejectedValue(new Error("sync failed"));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useInstallSkillsFromZip(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          filePath: "C:\\skills.zip",
          currentApp: "claude",
        }),
      ).rejects.toThrow("sync failed");
    });
    expect(invalidate.mock.calls).toEqual(
      ["installed", "unmanaged"].map((collection) => [
        { queryKey: ["skills", collection, "local"] },
      ]),
    );
  });
});
