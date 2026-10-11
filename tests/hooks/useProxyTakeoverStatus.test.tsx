import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProxyTakeoverStatus } from "@/lib/query/proxy";
import type { ManagementTarget } from "@/lib/api";

const getProxyTakeoverStatusMock = vi.fn();

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    getProxyTakeoverStatus: (...args: unknown[]) =>
      getProxyTakeoverStatusMock(...args),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper };
}

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile: {
    id: "remote-host",
    name: "Remote Host",
    host: "192.168.1.20",
    port: 22,
    username: "root",
    authMethod: { type: "password" },
    helperPath: "~/.local/bin/cc-switch-remote-helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "secret" },
};

describe("useProxyTakeoverStatus", () => {
  beforeEach(() => {
    getProxyTakeoverStatusMock.mockReset();
  });

  it("loads local takeover status for local targets", async () => {
    getProxyTakeoverStatusMock.mockResolvedValue({
      claude: true,
      codex: false,
      gemini: false,
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProxyTakeoverStatus(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getProxyTakeoverStatusMock).toHaveBeenCalledTimes(1);
  });

  it("reads a remote target's takeover status through the target, not the local one", async () => {
    const { wrapper } = createWrapper();
    getProxyTakeoverStatusMock.mockResolvedValue({});

    const { result } = renderHook(() => useProxyTakeoverStatus(remoteTarget), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 远端走 Helper（同一个 API 入口带 target），不会去读本机的接管状态
    expect(getProxyTakeoverStatusMock).toHaveBeenCalledTimes(1);
    expect(getProxyTakeoverStatusMock).toHaveBeenCalledWith(remoteTarget);
  });
});
