import type { PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDiscoverableSkills,
  useDiscoverableSkillsFailures,
} from "@/hooks/useSkills";
import { writeLocalCache } from "@/lib/localCache";
import type { ManagementTarget } from "@/lib/api/remote";
import type { SkillDiscoveryResult } from "@/lib/api/skills";
const discover = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/skills", () => ({
  skillsApi: { discoverAvailable: discover },
}));
const local: ManagementTarget = { type: "local" };
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "a",
    name: "A",
    host: "192.0.2.20",
    port: 22,
    username: "tester",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 0,
    updatedAt: 0,
  },
};
const report = (name: string): SkillDiscoveryResult => ({
  skills: [
    {
      key: name,
      name,
      description: name,
      directory: name,
      repoOwner: "owner",
      repoName: "repo",
      repoBranch: "main",
    },
  ],
  failures: [{ owner: "o", name: "r", branch: "main", error: name }],
});
const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
beforeEach(() => {
  discover.mockReset();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("Skills discovery target isolation", () => {
  it("a successful remote read does not mark the local persistent cache as revalidated", async () => {
    const stale = report("stale-local");
    writeLocalCache("skills.discoverable.v1", stale);
    discover.mockImplementation((target: ManagementTarget) =>
      Promise.resolve(report(target.type)),
    );
    const { result, rerender } = renderHook(
      ({ target }) => useDiscoverableSkills(target),
      {
        wrapper: wrapper(),
        initialProps: { target: remote as ManagementTarget },
      },
    );
    await waitFor(() =>
      expect(result.current.data).toEqual(report("remote").skills),
    );
    expect(
      JSON.parse(
        localStorage.getItem("cc-switch-cache:skills.discoverable.v1")!,
      ),
    ).toEqual(stale);
    rerender({ target: local });
    await waitFor(() => expect(discover).toHaveBeenCalledWith(local));
    await waitFor(() =>
      expect(result.current.data).toEqual(report("local").skills),
    );
  });

  it("does not carry a previous remote report into a local query's placeholder", async () => {
    discover.mockImplementation((target: ManagementTarget) =>
      target.type === "remote"
        ? Promise.resolve(report("remote"))
        : new Promise(() => {}),
    );
    const { result, rerender } = renderHook(
      ({ target }) => useDiscoverableSkills(target),
      {
        wrapper: wrapper(),
        initialProps: { target: remote as ManagementTarget },
      },
    );
    await waitFor(() =>
      expect(result.current.data).toEqual(report("remote").skills),
    );
    rerender({ target: local });
    expect(result.current.data).toBeUndefined();
  });

  it("remote skills and failures share one request without reading or writing the local cache", async () => {
    writeLocalCache("skills.discoverable.v1", report("local-only"));
    let release!: (result: SkillDiscoveryResult) => void;
    discover.mockImplementation(
      () =>
        new Promise<SkillDiscoveryResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(
      () => ({
        skills: useDiscoverableSkills(remote),
        failures: useDiscoverableSkillsFailures(remote),
      }),
      { wrapper: wrapper() },
    );
    expect(result.current.skills.data).toBeUndefined();
    expect(result.current.failures.data).toBeUndefined();
    await act(async () => {
      release(report("remote"));
    });
    await waitFor(() =>
      expect(result.current.skills.data).toEqual(report("remote").skills),
    );
    expect(result.current.failures.data).toEqual(report("remote").failures);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        localStorage.getItem("cc-switch-cache:skills.discoverable.v1")!,
      ),
    ).toEqual(report("local-only"));
  });
});
