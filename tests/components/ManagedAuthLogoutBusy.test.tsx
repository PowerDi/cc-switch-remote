import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { CopilotAuthSection } from "@/components/providers/forms/CopilotAuthSection";
import { XaiOAuthSection } from "@/components/providers/forms/XaiOAuthSection";

const mocks = vi.hoisted(() => ({
  useCodexOauth: vi.fn(),
  useCopilotAuth: vi.fn(),
  useXaiOauth: vi.fn(),
}));

vi.mock("@/components/providers/forms/hooks/useCodexOauth", () => ({
  useCodexOauth: mocks.useCodexOauth,
}));
vi.mock("@/components/providers/forms/hooks/useCopilotAuth", () => ({
  useCopilotAuth: mocks.useCopilotAuth,
}));
vi.mock("@/components/providers/forms/hooks/useXaiOauth", () => ({
  useXaiOauth: mocks.useXaiOauth,
}));

const accounts = [
  {
    id: "account-a",
    provider: "codex_oauth",
    login: "a@example.com",
    avatar_url: null,
    authenticated_at: 1,
    is_default: true,
    github_domain: "github.com",
    requires_reauth: false,
  },
  {
    id: "account-b",
    provider: "codex_oauth",
    login: "b@example.com",
    avatar_url: null,
    authenticated_at: 2,
    is_default: false,
    github_domain: "github.com",
    requires_reauth: false,
  },
];

const pendingLogoutState = () => ({
  accounts: [
    ...accounts,
    {
      ...accounts[0],
      id: "account-b",
      login: "b@example.com",
      is_default: false,
    },
  ],
  defaultAccountId: "account-a",
  migrationError: null,
  hasAnyAccount: true,
  isAuthenticated: true,
  pollingState: "idle",
  deviceCode: null,
  error: null,
  isPolling: false,
  isAddingAccount: false,
  isLoggingOut: true,
  isRemovingAccount: false,
  isSettingDefaultAccount: false,
  isStatusSuccess: true,
  isStatusError: false,
  isStatusLoading: false,
  addAccount: vi.fn(),
  removeAccount: vi.fn(),
  setDefaultAccount: vi.fn(),
  cancelAuth: vi.fn(),
  logout: vi.fn(),
});

/** v4 的认证区块通过 useManagedAuth 使用 React Query。 */
function renderSection(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("managed auth logout interaction lock", () => {
  it.each([
    ["Codex", mocks.useCodexOauth, CodexOAuthSection],
    ["Copilot", mocks.useCopilotAuth, CopilotAuthSection],
    ["xAI", mocks.useXaiOauth, XaiOAuthSection],
  ])(
    "%s section reports pending logout and locks the destructive action",
    async (_name, hook, Section) => {
      hook.mockReturnValue(pendingLogoutState());
      const onBusyChange = vi.fn();
      const user = userEvent.setup();

      renderSection(<Section onBusyChange={onBusyChange} />);

      await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

      // 上游 v4.0.21 去掉了「删除全部账号」，破坏性动作只剩每行的「删除账号…」：
      // 注销进行中它必须是禁用的
      const rowMenu = screen.getAllByRole("button", {
        name: /的更多操作/,
      })[0];
      await user.click(rowMenu);
      // Radix 菜单项用 aria-disabled 表达禁用
      expect(
        await screen.findByRole("menuitem", { name: /删除账号/ }),
      ).toHaveAttribute("aria-disabled", "true");
    },
  );
});
