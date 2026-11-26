import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQueryClient as render } from "../utils/testQueryClient";
import { toast } from "sonner";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RemoteHealthPanel } from "@/components/remote/RemoteHealthPanel";
import type { RemoteHostProfile } from "@/lib/api";
import { EXPECTED_REMOTE_CAPABILITIES } from "@/lib/remoteHealth";

const checkHealthMock = vi.fn();
const testConnectionMock = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const installHelperMock = vi.fn();
const allExpectedCapabilities = EXPECTED_REMOTE_CAPABILITIES.map(
  (capability) => capability.id,
);

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<any>("@/lib/api");
  return {
    ...actual,
    remoteApi: {
      ...actual.remoteApi,
      checkHealth: (...args: unknown[]) => checkHealthMock(...args),
      testConnection: (...args: unknown[]) => testConnectionMock(...args),
      installHelper: (...args: unknown[]) => installHelperMock(...args),
    },
  };
});

const profile: RemoteHostProfile = {
  id: "remote-1",
  name: "Remote 1",
  host: "192.168.123.203",
  port: 22,
  username: "root",
  authMethod: { type: "password" },
  helperPath: "/root/cc-switch-current/src-tauri/target/debug/cc-switch-cli",
  createdAt: 1,
  updatedAt: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const ready = {
  reachable: true,
  sshReachable: true,
  helperInstalled: true,
  helperVersion: "fixture-version",
  capabilities: ["session"],
};

describe("RemoteHealthPanel", () => {
  it("does not retry a failed connection test or mislabel unknown SSH state", async () => {
    testConnectionMock.mockRejectedValueOnce(new Error("deadline fixture"));
    render(
      <RemoteHealthPanel profile={profile} secret={{ password: "fixture" }} />,
    );
    fireEvent.click(screen.getByTestId("remote-test-connection"));
    await screen.findByText("deadline fixture");
    expect(testConnectionMock).toHaveBeenCalledTimes(1);
    expect(testConnectionMock).toHaveBeenCalledWith(profile, {
      password: "fixture",
    });
    expect(checkHealthMock).not.toHaveBeenCalled();
    expect(
      screen.queryByText("SSH 已验证 · 待安装 Helper"),
    ).not.toBeInTheDocument();
  });

  it("reports SSH verified with missing Helper without claiming a management session", async () => {
    testConnectionMock.mockResolvedValueOnce({
      reachable: false,
      sshReachable: true,
      helperInstalled: false,
      failureStage: "helper-missing",
      capabilities: [],
    });
    render(<RemoteHealthPanel profile={profile} />);
    fireEvent.click(screen.getByTestId("remote-test-connection"));
    await screen.findByText("SSH 已验证 · 待安装 Helper");
    expect(screen.getByText(/不建立管理会话/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装 Helper" })).toBeEnabled();
  });

  for (const change of ["host", "password", "id"] as const) {
    it(`ignores late checks after changing ${change}`, async () => {
      const pending = deferred<any>();
      checkHealthMock.mockReturnValueOnce(pending.promise);
      const view = render(
        <RemoteHealthPanel profile={profile} secret={{ password: "old" }} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "检查" }));
      const nextProfile =
        change === "password"
          ? profile
          : { ...profile, [change]: "new-target" };
      view.rerender(
        <RemoteHealthPanel
          profile={nextProfile}
          secret={{ password: change === "password" ? "new" : "old" }}
        />,
      );
      await act(async () => pending.resolve(ready));
      expect(screen.queryByText("fixture-version")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "检查" })).toBeEnabled();
    });
  }

  it("suppresses old install errors and does not clear the new target busy state", async () => {
    const oldInstall = deferred<any>();
    const newCheck = deferred<any>();
    installHelperMock.mockReturnValueOnce(oldInstall.promise);
    checkHealthMock.mockReturnValueOnce(newCheck.promise);
    const view = render(<RemoteHealthPanel profile={profile} />);
    fireEvent.click(screen.getByRole("button", { name: "安装 Helper" }));
    view.rerender(<RemoteHealthPanel profile={{ ...profile, id: "B" }} />);
    fireEvent.click(screen.getByRole("button", { name: "检查" }));
    await act(async () => oldInstall.reject(new Error("old host failure")));
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "加载中" })).toBeDisabled();
    await act(async () => newCheck.resolve(ready));
    expect(screen.getByText("fixture-version")).toBeInTheDocument();
  });

  it("preserves known health after install failure without reconnecting", async () => {
    checkHealthMock.mockResolvedValueOnce(ready);
    installHelperMock.mockRejectedValueOnce({
      code: "install-locked",
      message: "fixture lock",
    });
    render(<RemoteHealthPanel profile={profile} />);
    fireEvent.click(screen.getByRole("button", { name: "检查" }));
    await screen.findByText("fixture-version");
    fireEvent.click(screen.getByRole("button", { name: "重新安装 Helper" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText("fixture-version")).toBeInTheDocument();
    expect(checkHealthMock).toHaveBeenCalledTimes(1);
    expect(testConnectionMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    i18n.addResourceBundle(
      "zh",
      "translation",
      { remote: zh.remote },
      true,
      true,
    );
    checkHealthMock.mockReset();
    testConnectionMock.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    installHelperMock.mockReset();
  });

  it("warns when the remote helper is missing a parity capability", async () => {
    checkHealthMock.mockResolvedValueOnce({
      reachable: true,
      helperInstalled: true,
      helperVersion: "3.16.0",
      platform: "linux",
      capabilities: ["providers", "mcp", "prompts", "skills", "import-export"],
    });

    render(
      <RemoteHealthPanel
        profile={profile}
        secret={{ password: "session-secret" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "检查" }));

    await waitFor(() => {
      expect(screen.getByText("缺少功能支持")).toBeInTheDocument();
    });
    expect(screen.getAllByText("OpenClaw").length).toBeGreaterThan(0);
    expect(screen.getByText("供应商")).toBeInTheDocument();
    expect(checkHealthMock).toHaveBeenCalledWith(profile, {
      password: "session-secret",
    });
  });

  it("shows all helper capabilities without a missing-capability warning", async () => {
    checkHealthMock.mockResolvedValueOnce({
      reachable: true,
      helperInstalled: true,
      helperVersion: "3.16.0",
      platform: "linux",
      capabilities: allExpectedCapabilities,
    });

    render(<RemoteHealthPanel profile={profile} />);

    fireEvent.click(screen.getByRole("button", { name: "检查" }));

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });
    expect(screen.queryByText("缺少功能支持")).not.toBeInTheDocument();
  });

  it("shows an update action when the remote helper is behind the latest release", async () => {
    checkHealthMock.mockResolvedValueOnce({
      reachable: true,
      helperInstalled: true,
      helperVersion: "3.16.2",
      helperLatestVersion: "3.16.2",
      helperLatestBuild: "abcdef12",
      helperLatestAsset: "cc-switch-remote-helper-abcdef12-Linux-x86_64",
      helperUpdateAvailable: true,
      platform: "linux",
      capabilities: ["providers"],
    });

    render(<RemoteHealthPanel profile={profile} />);

    fireEvent.click(screen.getByRole("button", { name: "检查" }));

    await waitFor(() => {
      expect(screen.getByText("发现新版 Helper")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "更新 Helper" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/最新构建: abcdef12/)).toBeInTheDocument();
    expect(
      screen.queryByText(/cc-switch-remote-helper-abcdef12-Linux-x86_64/),
    ).not.toBeInTheDocument();
  });

  it("shows helper upgrade requirement when session capability is missing", async () => {
    checkHealthMock.mockResolvedValueOnce({
      reachable: true,
      helperInstalled: true,
      helperVersion: "3.16.3",
      helperBuild: "abc123",
      helperArch: "x86_64",
      helperUpdateAvailable: false,
      helperUpdateError:
        "远程 Helper 版本过旧，不支持持久会话；请更新 Helper。",
      platform: "linux",
      capabilities: ["providers", "settings"],
    });

    render(<RemoteHealthPanel profile={profile} />);

    fireEvent.click(screen.getByRole("button", { name: "检查" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "远程 Helper 版本过旧，不支持持久会话；请更新 Helper。",
        ),
      ).toBeInTheDocument();
    });
  });

  it("keeps the configured helper path visible after a health check", async () => {
    checkHealthMock.mockResolvedValueOnce({
      reachable: true,
      helperInstalled: true,
      helperVersion: "3.16.0",
      platform: "linux",
      capabilities: ["providers"],
    });

    render(<RemoteHealthPanel profile={profile} />);

    expect(screen.getByText(profile.helperPath)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "检查" }));

    await waitFor(() => {
      expect(screen.getByText("3.16.0")).toBeInTheDocument();
    });
    expect(screen.getByText(profile.helperPath)).toBeInTheDocument();
  });
});
