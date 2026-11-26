import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "../utils/testQueryClient";
import { CopilotAuthSection } from "@/components/providers/forms/CopilotAuthSection";
import { XaiOAuthSection } from "@/components/providers/forms/XaiOAuthSection";
import type { ManagementTarget } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  copilot: vi.fn(),
  xai: vi.fn(),
  supported: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/api/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/remote")>()),
  remoteApi: { fetchCopilotUsage: mocks.copilot, getXaiOauthQuota: mocks.xai },
}));
// Display preference is desktop UI state, independent of the account target.
vi.mock("@/components/quota/useQuotaDisplay", () => ({
  useQuotaDisplay: () => "left",
}));
vi.mock("@/components/providers/forms/hooks/useManagedAccountUsers", () => ({
  useManagedAccountUsers: () => () => [],
}));

function accountState() {
  return {
    accounts: [{ id: "account-1", login: "test-user", authenticated_at: 1 }],
    defaultAccountId: "account-1",
    isStatusSuccess: true,
    isStatusError: false,
    pollingState: "idle",
    isAuthSupported: mocks.supported,
    addAccount: vi.fn(),
    removeAccount: vi.fn(),
    setDefaultAccount: vi.fn(),
    cancelAuth: vi.fn(),
    logout: vi.fn(),
  };
}
vi.mock("@/components/providers/forms/hooks/useCopilotAuth", () => ({
  useCopilotAuth: () => accountState(),
}));
vi.mock("@/components/providers/forms/hooks/useXaiOauth", () => ({
  useXaiOauth: () => accountState(),
}));

const target: ManagementTarget = {
  type: "remote",
  profile: {
    id: "quota-host",
    name: "Quota host",
    host: "192.0.2.10",
    port: 22,
    username: "test",
    authMethod: { type: "sshAgent" },
    helperPath: "helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "test-secret" },
};

const cases = [
  {
    name: "Copilot",
    Component: CopilotAuthSection,
    remote: mocks.copilot,
    command: "copilot_get_usage_for_account",
    result: {
      copilot_plan: "individual",
      quota_reset_date: "2026-12-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: { entitlement: 300, remaining: 200 },
      },
    },
  },
  {
    name: "xAI",
    Component: XaiOAuthSection,
    remote: mocks.xai,
    command: "get_xai_oauth_quota",
    result: { success: false, tool: "xai_oauth", error: "quota unavailable" },
  },
];

describe("managed account quota target routing", () => {
  beforeEach(() => {
    mocks.supported = true;
    mocks.invoke.mockReset();
    mocks.copilot.mockReset();
    mocks.xai.mockReset();
  });

  for (const { name, Component, remote, command, result } of cases) {
    it(`${name}: loads and refreshes the selected remote account without a local command`, async () => {
      remote.mockResolvedValue(result);
      renderWithQueryClient(<Component mode="manage" target={target} />);
      await waitFor(() =>
        expect(remote).toHaveBeenCalledWith(
          target.profile,
          "account-1",
          target.secret,
        ),
      );
      const refresh = await screen.findByRole("button", {
        name: /刷新.*test-user.*额度/,
      });
      await waitFor(() =>
        expect(refresh).toHaveAttribute("aria-disabled", "false"),
      );
      const calls = remote.mock.calls.length;
      fireEvent.click(refresh);
      await waitFor(() =>
        expect(remote.mock.calls.length).toBeGreaterThan(calls),
      );
      expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it(`${name}: preserves the original local quota command`, async () => {
      mocks.invoke.mockResolvedValue(result);
      renderWithQueryClient(<Component mode="manage" />);
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(command, {
          accountId: "account-1",
        }),
      );
      expect(remote).not.toHaveBeenCalled();
    });

    it(`${name}: does not load quota or expose account actions when remote auth is unsupported`, () => {
      mocks.supported = false;
      renderWithQueryClient(<Component mode="manage" target={target} />);
      expect(screen.getByRole("status")).toHaveTextContent(/不支持认证管理/);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(remote).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    });
  }
});
