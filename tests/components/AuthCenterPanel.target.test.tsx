import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";
import type { ManagementTarget } from "@/lib/api";

vi.mock("@/lib/platform", () => ({ isMac: () => true }));
vi.mock("@/components/providers/forms/ClaudeOfficialSection", () => ({
  ClaudeOfficialSection: () => <div>claude-local</div>,
}));
vi.mock("@/components/providers/forms/AgyOAuthSection", () => ({
  AgyOAuthSection: () => <div>agy-local</div>,
}));
vi.mock("@/components/providers/KimiAccountLogin", () => ({
  KimiAccountLogin: () => <div>kimi-local</div>,
}));
vi.mock("@/components/providers/forms/CopilotAuthSection", () => ({
  CopilotAuthSection: ({ target }: { target: ManagementTarget }) => (
    <div>copilot-{target.type}</div>
  ),
}));
vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: ({ target }: { target: ManagementTarget }) => (
    <div>codex-{target.type}</div>
  ),
}));
vi.mock("@/components/providers/forms/XaiOAuthSection", () => ({
  XaiOAuthSection: ({ target }: { target: ManagementTarget }) => (
    <div>xai-{target.type}</div>
  ),
}));

describe("Auth Center target boundaries", () => {
  it("keeps browser and native account sections available locally", () => {
    render(<AuthCenterPanel />);
    for (const name of [
      "claude-local",
      "agy-local",
      "kimi-local",
      "copilot-local",
      "codex-local",
      "xai-local",
    ])
      expect(screen.getByText(name)).toBeInTheDocument();
  });
  it("mounts remote-aware sections without local account components", () => {
    const target: ManagementTarget = {
      type: "remote",
      profile: {
        id: "host",
        host: "example.test",
        port: 22,
        username: "user",
        name: "Host",
        authMethod: { type: "sshAgent" },
        helperPath: "helper",
        createdAt: 1,
        updatedAt: 1,
      },
      secret: { password: "remote-secret" },
    };
    render(<AuthCenterPanel target={target} />);
    for (const name of ["claude-local", "agy-local", "kimi-local"])
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    for (const name of ["copilot-remote", "codex-remote", "xai-remote"])
      expect(screen.getByText(name)).toBeInTheDocument();
  });
});
