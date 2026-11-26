import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseUpgrade } from "@/components/DatabaseUpgrade";

vi.mock("../../release-identity.json", async () => ({
  default: structuredClone(
    (await import("../fixtures/releaseIdentity.json")).default,
  ),
}));

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  exit: mocks.exit,
}));

vi.mock("react-i18next", async () => {
  const { releaseT } = await import("../helpers/releaseTranslations");
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string | Record<string, unknown>) => {
        if (
          key.startsWith("releaseIdentity.") ||
          key === "dbUpgrade.updateAvailable"
        )
          return releaseT(key, fallback);
        return typeof fallback === "string"
          ? fallback
          : (fallback?.defaultValue ?? key);
      },
    }),
  };
});

describe("DatabaseUpgrade recovery actions", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.exit.mockReset();
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "check_app_update_available") return null;
      return true;
    });
  });

  it("keeps recovery actions state-free and points release fallback at the fork", async () => {
    render(
      <DatabaseUpgrade
        payload={{
          kind: "database_too_new",
          path: "/tmp/cc-switch.db",
          db_version: 18,
          supported_version: 17,
        }}
      />,
    );

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("check_app_update_available"),
    );

    fireEvent.click(screen.getByRole("button", { name: "打开配置目录" }));
    expect(mocks.invoke).toHaveBeenCalledWith("open_app_config_folder");

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(mocks.exit).toHaveBeenCalledWith(0);

    const releases = await screen.findByRole("button", { name: "打开发布页" });
    fireEvent.click(releases);
    expect(mocks.invoke).toHaveBeenCalledWith("open_external", {
      url: "https://github.com/PowerDi/cc-switch-remote/releases",
    });
  });

  it("unknown update identity retains installer version and state-free failure/release fallback", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "check_app_update_available") return "4.2.0";
      if (command === "install_update_and_restart")
        throw new Error("synthetic install failure");
      return true;
    });
    render(
      <DatabaseUpgrade
        payload={{
          kind: "database_too_new",
          db_version: 24,
          supported_version: 23,
        }}
      />,
    );
    expect(
      await screen.findByText("Installation version: 4.2.0"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Public version identity unknown/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "升级应用" }));
    expect(
      await screen.findByText("synthetic install failure"),
    ).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("install_update_and_restart");
    expect(mocks.listen).toHaveBeenCalledWith(
      "update-download-progress",
      expect.any(Function),
    );
    expect(unlisten).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "打开发布页" }));
    expect(mocks.invoke.mock.calls).toEqual([
      ["check_app_update_available"],
      ["install_update_and_restart"],
      [
        "open_external",
        { url: "https://github.com/PowerDi/cc-switch-remote/releases" },
      ],
    ]);
  });

  it("legacy check result displays its historical identity, not the unreleased current build", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "check_app_update_available" ? "4.1.0" : false,
    );
    render(
      <DatabaseUpgrade
        payload={{
          kind: "database_too_new",
          db_version: 24,
          supported_version: 23,
        }}
      />,
    );
    expect(
      await screen.findByText("Installation version: 4.1.0"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Remote v4.1.0/)).toBeInTheDocument();
    expect(screen.queryByText(/Remote r1/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "升级应用" }));
    await screen.findByRole("button", { name: "打开发布页" });
    expect(mocks.invoke).toHaveBeenCalledWith("install_update_and_restart");
  });
});
