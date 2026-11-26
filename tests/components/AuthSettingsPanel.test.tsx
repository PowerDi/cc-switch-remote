import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthSettingsPanel } from "@/components/providers/AuthSettingsPanel";
import type { ManagementTarget } from "@/lib/api";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));
vi.mock("@/components/providers/forms/ClaudeOfficialSection", () => ({
  ClaudeOfficialSection: () => <div>claude-local</div>,
}));
vi.mock("@/components/providers/forms/AgyOAuthSection", () => ({
  AgyOAuthSection: () => <div>agy-local</div>,
}));
vi.mock("@/components/providers/KimiAccountLogin", () => ({
  KimiAccountLogin: () => <div>kimi-local</div>,
}));

const targetLabel = (target?: ManagementTarget) =>
  target?.type === "remote" ? `remote:${target.profile.id}` : "local";

vi.mock("@/components/providers/forms/CopilotAuthSection", () => ({
  CopilotAuthSection: ({ target }: { target?: ManagementTarget }) => (
    <output data-testid="copilot-target">{targetLabel(target)}</output>
  ),
}));
vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: ({ target }: { target?: ManagementTarget }) => (
    <output data-testid="codex-target">{targetLabel(target)}</output>
  ),
}));
vi.mock("@/components/providers/forms/XaiOAuthSection", () => ({
  XaiOAuthSection: ({ target }: { target?: ManagementTarget }) => (
    <output data-testid="xai-target">{targetLabel(target)}</output>
  ),
}));

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile: {
    id: "remote-host",
    name: "Remote Host",
    host: "192.0.2.10",
    port: 22,
    username: "root",
    authMethod: { type: "sshAgent" },
    helperPath: "/root/.local/bin/cc-switch-remote-helper",
    createdAt: 1,
    updatedAt: 1,
  },
};

describe("AuthSettingsPanel", () => {
  it("把供应商表单的远程目标传给三组账号", () => {
    render(
      <AuthSettingsPanel
        target="github_copilot"
        managementTarget={remoteTarget}
        onClose={vi.fn()}
      />,
    );

    for (const name of ["claude-local", "agy-local", "kimi-local"]) {
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }
    for (const id of ["copilot-target", "codex-target", "xai-target"]) {
      expect(screen.getByTestId(id)).toHaveTextContent("remote:remote-host");
    }
  });

  it("没给目标时仍管理本机账号", () => {
    render(<AuthSettingsPanel target="github_copilot" onClose={vi.fn()} />);

    for (const id of ["copilot-target", "codex-target", "xai-target"]) {
      expect(screen.getByTestId(id)).toHaveTextContent("local");
    }
  });
});
