import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { describe, it, expect, vi } from "vitest";
import { useTargetCapabilityState } from "@/hooks/useTargetCapability";
import { remoteApi } from "@/lib/api/remote";

vi.mock("@/lib/api/remote", () => ({ remoteApi: { checkHealth: vi.fn() } }));
const target = {
  type: "remote" as const,
  profile: {
    id: "fixture",
    name: "fixture",
    host: "example.invalid",
    port: 22,
    username: "fixture",
    helperPath: "helper",
    authMethod: { type: "password" as const },
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "fixture-secret" },
};
function mount(selected = target) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(() => useTargetCapabilityState(selected, "auth"), {
      wrapper,
    }),
    client,
  };
}
describe("capability health failure semantics", () => {
  it("keeps failed SSH distinct from an unsupported capability without local calls or retries", async () => {
    vi.mocked(remoteApi.checkHealth).mockResolvedValue({
      reachable: false,
      helperInstalled: false,
      sshReachable: false,
      failureCode: "ssh-auth",
      lastError: "fixture denied",
      capabilities: [],
    });
    const { result, client } = mount();
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.supported).toBe(false);
    expect(result.current.error).toContain("fixture denied");
    expect(remoteApi.checkHealth).toHaveBeenCalledTimes(1);
    expect(remoteApi.checkHealth).toHaveBeenCalledWith(
      target.profile,
      target.secret,
      false,
    );
    expect(client.getQueryCache().getAll()[0].queryKey).toEqual([
      "remote-health",
      "remote:fixture",
      0,
      "installed-capabilities",
    ]);
  });
  it("reports unsupported only when metadata succeeded without the capability", async () => {
    vi.mocked(remoteApi.checkHealth).mockResolvedValue({
      reachable: true,
      helperInstalled: true,
      capabilities: ["providers"],
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.state).toBe("unsupported"));
    expect(result.current.error).toBeNull();
  });
});
