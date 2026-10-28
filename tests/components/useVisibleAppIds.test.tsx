import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useVisibleAppIds } from "@/components/mcp/useVisibleAppIds";
import type { ManagementTarget } from "@/lib/api/remote";
const mocks = vi.hoisted(() => ({ get: vi.fn(), omp: true }));
vi.mock("@/lib/api", () => ({ settingsApi: { get: mocks.get } }));
vi.mock("@/hooks/useTargetCapability", () => ({
  useTargetCapability: (target: ManagementTarget) =>
    target.type === "local" || mocks.omp,
}));
const apps = ["claude", "codex", "omp", "agy", "kimi"] as const;
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "host-a",
    name: "A",
    host: "192.0.2.1",
    port: 22,
    username: "user",
    authMethod: { type: "sshAgent" },
    helperPath: "helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "selected-secret" },
};
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}
beforeEach(() => {
  mocks.get.mockReset();
  mocks.omp = true;
});
describe("target app visibility", () => {
  it("reads the selected remote settings and excludes unsupported apps", async () => {
    mocks.get.mockResolvedValue({
      visibleApps: {
        claude: false,
        codex: true,
        omp: true,
        agy: true,
        kimi: true,
      },
    });
    const { result } = renderHook(() => useVisibleAppIds(apps, remote), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toEqual(["codex", "omp"]));
    expect(mocks.get).toHaveBeenCalledWith(remote);
    expect(
      mocks.get.mock.calls.every(([target]) => target.type === "remote"),
    ).toBe(true);
  });
  it("keeps an old helper from exposing OMP matrix controls", async () => {
    mocks.omp = false;
    mocks.get.mockResolvedValue({
      visibleApps: { claude: false, codex: true, omp: true },
    });
    const { result } = renderHook(() => useVisibleAppIds(apps, remote), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toEqual(["codex"]));
  });
  it("keeps the local settings workflow", async () => {
    mocks.get.mockResolvedValue({
      visibleApps: {
        claude: true,
        codex: false,
        omp: false,
        agy: false,
        kimi: false,
      },
    });
    const local: ManagementTarget = { type: "local" };
    const { result } = renderHook(() => useVisibleAppIds(apps, local), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toEqual(["claude"]));
    expect(mocks.get).toHaveBeenCalledWith(local);
  });
});
