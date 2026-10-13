import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useManagedAuth } from "@/components/providers/forms/hooks/useManagedAuth";
import type { ManagementTarget } from "@/lib/api";
import { CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR } from "@/lib/api/auth";

const apiMocks = vi.hoisted(() => ({
  authGetStatus: vi.fn(),
  authStartLogin: vi.fn(),
  authPollForAccount: vi.fn(),
  authCancelLogin: vi.fn(),
  authRemoveAccount: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
}));
const openExternalMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  remoteApi: {
    checkHealth: vi.fn().mockResolvedValue({ capabilities: ["auth"] }),
  },
  authApi: {
    authGetStatus: (...args: unknown[]) => apiMocks.authGetStatus(...args),
    authStartLogin: (...args: unknown[]) => apiMocks.authStartLogin(...args),
    authPollForAccount: (...args: unknown[]) =>
      apiMocks.authPollForAccount(...args),
    authCancelLogin: (...args: unknown[]) => apiMocks.authCancelLogin(...args),
    authRemoveAccount: (...args: unknown[]) =>
      apiMocks.authRemoveAccount(...args),
  },
  settingsApi: {
    openExternal: (...args: unknown[]) => openExternalMock(...args),
  },
}));

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile: {
    id: "server-a",
    name: "Server A",
    host: "192.0.2.10",
    port: 22,
    username: "root",
    authMethod: { type: "sshAgent" },
    helperPath: "/root/.local/bin/cc-switch-remote-helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "secret" },
};

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastMocks.success,
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useManagedAuth", () => {
  beforeEach(() => {
    openExternalMock.mockReset().mockResolvedValue(undefined);
    apiMocks.authGetStatus.mockReset().mockResolvedValue({
      provider: "codex_oauth",
      authenticated: true,
      default_account_id: "acct-1",
      accounts: [
        {
          id: "acct-1",
          provider: "codex_oauth",
          login: "user@example.com",
          avatar_url: null,
          authenticated_at: 1,
          is_default: true,
          github_domain: "",
          reauth_required: false,
          requires_reauth: false,
        },
      ],
    });
    apiMocks.authStartLogin
      .mockReset()
      .mockImplementation(() => new Promise(() => {}));
    apiMocks.authPollForAccount.mockReset().mockResolvedValue(null);
    apiMocks.authCancelLogin.mockReset().mockResolvedValue(true);
    apiMocks.authRemoveAccount.mockReset().mockResolvedValue(undefined);
  });

  it("starts reauthentication for the selected account", async () => {
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.reauthAccount("acct-1"));

    await waitFor(() =>
      expect(apiMocks.authStartLogin).toHaveBeenCalledWith(
        "codex_oauth",
        undefined,
        { type: "local" },
        "acct-1",
      ),
    );
  });

  it("retries reauthentication for the same target account", async () => {
    apiMocks.authStartLogin.mockRejectedValue(new Error("start failed"));
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(result.current.pollingState).toBe("error"));
    act(() => result.current.retryAuth());

    await waitFor(() =>
      expect(apiMocks.authStartLogin).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.authStartLogin).toHaveBeenNthCalledWith(
      2,
      "codex_oauth",
      undefined,
      { type: "local" },
      "acct-1",
    );
  });

  it("localizes a duplicate Codex account error", async () => {
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockRejectedValue(
      new Error(CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR),
    );
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });

    act(() => result.current.addAccount());

    await waitFor(() => expect(result.current.pollingState).toBe("error"));
    expect(result.current.error).toBe(
      "该 ChatGPT 账号已添加，请直接使用现有账号。",
    );
  });

  it("cancels the active Codex device flow in the backend", async () => {
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(result.current.deviceCode).not.toBeNull());

    act(() => result.current.cancelAuth());

    await waitFor(() =>
      expect(apiMocks.authCancelLogin).toHaveBeenCalledWith(
        "codex_oauth",
        "device-1",
        { type: "local" },
      ),
    );
    expect(result.current.pollingState).toBe("idle");
  });

  it("refreshes status when login committed before cancellation", async () => {
    let resolvePoll!: (account: object) => void;
    let resolveCancel!: (cancelled: boolean) => void;
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockImplementation(
      () => new Promise((resolve) => (resolvePoll = resolve)),
    );
    apiMocks.authCancelLogin.mockImplementation(
      () => new Promise((resolve) => (resolveCancel = resolve)),
    );
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(apiMocks.authPollForAccount).toHaveBeenCalled());
    apiMocks.authGetStatus.mockResolvedValue({
      provider: "codex_oauth",
      authenticated: true,
      default_account_id: "acct-1",
      accounts: [
        ...result.current.accounts,
        {
          id: "acct-2",
          provider: "codex_oauth",
          login: "other@example.com",
          avatar_url: null,
          authenticated_at: 2,
          is_default: false,
          github_domain: "",
          reauth_required: false,
          requires_reauth: false,
        },
      ],
    });

    act(() => result.current.cancelAuth());
    await waitFor(() => expect(apiMocks.authCancelLogin).toHaveBeenCalled());
    act(() => {
      resolvePoll({ id: "acct-2" });
      resolveCancel(false);
    });

    await waitFor(() => expect(result.current.accounts).toHaveLength(2));
  });

  it("waits for active-flow cancellation before starting another login", async () => {
    let resolveCancel!: (cancelled: boolean) => void;
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockImplementation(() => new Promise(() => {}));
    apiMocks.authCancelLogin.mockImplementation(
      () => new Promise((resolve) => (resolveCancel = resolve)),
    );
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });

    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(result.current.deviceCode).not.toBeNull());
    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(apiMocks.authCancelLogin).toHaveBeenCalled());
    expect(apiMocks.authStartLogin).toHaveBeenCalledTimes(1);

    act(() => resolveCancel(true));

    await waitFor(() =>
      expect(apiMocks.authStartLogin).toHaveBeenCalledTimes(2),
    );
  });

  it("shows a success toast after removing an account", async () => {
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.removeAccount("acct-1"));

    await waitFor(() =>
      expect(apiMocks.authRemoveAccount).toHaveBeenCalledWith(
        "codex_oauth",
        "acct-1",
        { type: "local" },
      ),
    );
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith("账号已移除"),
    );
  });

  it("routes remote device login through the selected target without opening a local browser", async () => {
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "remote-device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockImplementation(() => new Promise(() => {}));
    const { result, unmount } = renderHook(
      () => useManagedAuth("codex_oauth", undefined, remoteTarget),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.startAuth());

    await waitFor(() => expect(result.current.deviceCode).not.toBeNull());
    expect(apiMocks.authStartLogin).toHaveBeenCalledWith(
      "codex_oauth",
      undefined,
      remoteTarget,
      undefined,
    );
    expect(openExternalMock).not.toHaveBeenCalled();
    unmount();
  });

  it("routes local account removal through the local target", async () => {
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.removeAccount("acct-1"));

    await waitFor(() =>
      expect(apiMocks.authRemoveAccount).toHaveBeenCalledWith(
        "codex_oauth",
        "acct-1",
        { type: "local" },
      ),
    );
  });
});
