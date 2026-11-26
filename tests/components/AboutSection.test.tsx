import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "@/lib/updater";
import metadata from "../fixtures/releaseIdentity.json";
vi.mock("../../release-identity.json", async () => ({
  default: structuredClone(
    (await import("../fixtures/releaseIdentity.json")).default,
  ),
}));
import { releaseT } from "../helpers/releaseTranslations";

const mocks = vi.hoisted(() => ({
  version: "4.0.21-remote.1",
  info: null as UpdateInfo | null,
  openExternal: vi.fn(),
  portableLegacy: vi.fn(),
  install: vi.fn(),
  checkUpdates: vi.fn(),
  check: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => mocks.version,
}));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    openExternal: mocks.openExternal,
    openPortableUpdateDownload: mocks.portableLegacy,
    installUpdateAndRestart: mocks.install,
    checkUpdates: mocks.checkUpdates,
  },
}));
vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: !!mocks.info,
    updateInfo: mocks.info,
    checkUpdate: mocks.check,
    resetDismiss: mocks.reset,
    isChecking: false,
  }),
}));
vi.mock("react-i18next", async () => {
  const { releaseT } = await import("../helpers/releaseTranslations");
  return { useTranslation: () => ({ t: releaseT, i18n: { language: "en" } }) };
});
vi.mock("@/lib/whatsNew", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsNew")>()),
  WHATS_NEW_ENTRIES: ["4.0.40", "4.0.21"].map((version) => ({
    version,
    items: [
      {
        type: "fix",
        zh: `summary ${version}`,
        "zh-TW": `summary ${version}`,
        en: `summary ${version}`,
        ja: `summary ${version}`,
      },
    ],
  })),
}));
import { AboutSection } from "@/components/settings/AboutSection";
const releases = "https://github.com/PowerDi/cc-switch-remote/releases";

beforeEach(() => {
  mocks.version = "4.0.21-remote.1";
  mocks.info = null;
  mocks.openExternal.mockReset().mockResolvedValue(true);
  mocks.portableLegacy.mockReset();
  mocks.install.mockReset().mockResolvedValue(false);
  mocks.checkUpdates.mockReset().mockResolvedValue(false);
  mocks.check.mockReset().mockResolvedValue(false);
  mocks.reset.mockReset();
  localStorage.removeItem("ccswitch:about:starPromptDismissed");
});
const available = (): UpdateInfo => ({
  currentVersion: "4.0.21-remote.1",
  availableVersion: "4.0.21-remote.2",
  releaseIdentity: {
    ...metadata.current,
    remoteRevision: 2,
    releaseTag: "remote-v4.0.21-r2",
    packageVersion: "4.0.21-remote.2",
  },
});
async function loaded() {
  await screen.findByText("Installation version: " + mocks.version);
}

describe("About release identity and portable download routing", () => {
  it("displays public version and installation details separately, with unreleased fallback", async () => {
    render(<AboutSection isPortable={false} />);
    await loaded();
    expect(screen.getByText("4.0.21 · Remote r1")).toBeInTheDocument();
    expect(screen.getByText("Unreleased")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: releaseT("settings.releaseNotes") }),
    );
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith(releases),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: releaseT("settings.officialWebsite"),
      }),
    );
    expect(mocks.openExternal).toHaveBeenLastCalledWith(
      "https://github.com/PowerDi/cc-switch-remote",
    );
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("new portable update opens the actual release page, not the old Rust URL constructor", async () => {
    mocks.info = available();
    render(<AboutSection isPortable />);
    await loaded();
    expect(
      screen.getByText("Installation version: 4.0.21-remote.2"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(releaseT("settings.portableUpdateHint")),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: releaseT("settings.updateTo", { version: "4.0.21 · Remote r2" }),
      }),
    );
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith(
        `${releases}/tag/remote-v4.0.21-r2`,
      ),
    );
    expect(mocks.portableLegacy).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("unknown future update retains installer detail and uses only the fork-list fallback", async () => {
    mocks.info = { ...available(), releaseIdentity: null };
    render(<AboutSection isPortable />);
    await loaded();
    expect(
      screen.getByText("Installation version: 4.0.21-remote.2"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: releaseT("settings.updateTo", {
          version: "Public version identity unknown",
        }),
      }),
    );
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith(releases),
    );
    fireEvent.click(
      screen.getByRole("button", { name: releaseT("settings.releaseNotes") }),
    );
    await waitFor(() => expect(mocks.openExternal).toHaveBeenCalledTimes(2));
    expect(
      mocks.openExternal.mock.calls.every(([url]) => url === releases),
    ).toBe(true);
    expect(mocks.portableLegacy).not.toHaveBeenCalled();
  });

  it("legacy update links preserve the original known fork tag", async () => {
    mocks.version = "4.0.5";
    mocks.info = {
      currentVersion: "4.0.5",
      availableVersion: "4.0.9",
      releaseIdentity: metadata.history.find(
        (record) => record.packageVersion === "4.0.9",
      ),
    };
    render(<AboutSection isPortable />);
    await loaded();
    fireEvent.click(
      screen.getByRole("button", {
        name: releaseT("settings.updateTo", { version: "Remote v4.0.9" }),
      }),
    );
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith(`${releases}/tag/v4.0.9`),
    );
    expect(mocks.portableLegacy).not.toHaveBeenCalled();
  });

  it("unknown installed identity is explicit and has no invented tag or upstream summary", async () => {
    mocks.version = "99.0.0";
    render(<AboutSection isPortable={false} />);
    await loaded();
    expect(
      screen.getByText("Public version identity unknown"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: releaseT("whatsNew.recentTitle") }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: releaseT("settings.releaseNotes") }),
    );
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith(releases),
    );
  });

  it("About summaries stop at actual upstream baseline instead of installation version", async () => {
    render(<AboutSection isPortable={false} />);
    await loaded();
    fireEvent.click(
      screen.getByRole("button", { name: releaseT("whatsNew.recentTitle") }),
    );
    expect(await screen.findByText("summary 4.0.21")).toBeInTheDocument();
    expect(screen.queryByText("summary 4.0.40")).not.toBeInTheDocument();
  });

  it("normal installer update still uses the existing install command rather than portable/download links", async () => {
    mocks.info = available();
    render(<AboutSection isPortable={false} />);
    await loaded();
    fireEvent.click(
      screen.getByRole("button", {
        name: releaseT("settings.updateTo", { version: "4.0.21 · Remote r2" }),
      }),
    );
    await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.portableLegacy).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
