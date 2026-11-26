import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../release-identity.json", async () => ({
  default: structuredClone(
    (await import("../fixtures/releaseIdentity.json")).default,
  ),
}));

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  save: vi.fn(),
  openExternal: vi.fn(),
  version: "4.1.0",
  settings: undefined as
    | {
        firstRunNoticeConfirmed?: boolean;
        newLayoutNoticeConfirmed?: boolean;
        whatsNewSeenVersion?: string;
      }
    | undefined,
}));

vi.mock("@/lib/api", () => ({
  providersApi: { getAll: mocks.getAll },
  settingsApi: { save: mocks.save, openExternal: mocks.openExternal },
}));
vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: mocks.settings }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => mocks.version,
}));

import { NewLayoutDialog } from "@/components/shell/NewLayoutDialog";
import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { APP_IDS } from "@/config/appConfig";

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NewLayoutDialog />
    </QueryClientProvider>,
  );
}

describe("NewLayoutDialog", () => {
  beforeEach(() => {
    mocks.version = "4.1.0";
    mocks.settings = { firstRunNoticeConfirmed: true };
    mocks.save.mockReset().mockResolvedValue(true);
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
    mocks.getAll
      .mockReset()
      .mockImplementation(async (app: string) =>
        app === "codex" ? { p1: { id: "p1" } } : {},
      );
  });

  it("shows to returning users and records the confirmation", async () => {
    renderDialog();
    expect(
      await screen.findByText("newLayoutNotice.title"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "newLayoutNotice.confirm" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("newLayoutNotice.title"),
      ).not.toBeInTheDocument(),
    );
    // 这个弹窗介绍的就是新版本，更新摘要一并记成已看，不会接着再弹一个
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        newLayoutNoticeConfirmed: true,
        whatsNewSeenVersion: "upstream:4.0.21",
      }),
    );
  });

  it("opens this version's release notes and closes", async () => {
    renderDialog();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "newLayoutNotice.viewReleaseNotes",
      }),
    );
    await waitFor(() =>
      expect(mocks.openExternal).toHaveBeenCalledWith(
        "https://github.com/PowerDi/cc-switch-remote/releases",
      ),
    );
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({ newLayoutNoticeConfirmed: true }),
      ),
    );
    expect(screen.queryByText("newLayoutNotice.title")).not.toBeInTheDocument();
  });

  it("stays closed once confirmed", async () => {
    mocks.settings = {
      firstRunNoticeConfirmed: true,
      newLayoutNoticeConfirmed: true,
    };
    renderDialog();
    expect(mocks.getAll).not.toHaveBeenCalled();
    expect(screen.queryByText("newLayoutNotice.title")).not.toBeInTheDocument();
  });

  it("stays closed when no app has providers", async () => {
    mocks.getAll.mockResolvedValue({});
    renderDialog();
    await waitFor(() =>
      expect(mocks.getAll).toHaveBeenCalledTimes(APP_IDS.length),
    );
    expect(screen.queryByText("newLayoutNotice.title")).not.toBeInTheDocument();
  });

  it("never shows to a fresh install that is seeing the welcome dialog", async () => {
    mocks.settings = { firstRunNoticeConfirmed: undefined };
    renderDialog();
    expect(mocks.getAll).not.toHaveBeenCalled();
    expect(screen.queryByText("newLayoutNotice.title")).not.toBeInTheDocument();
  });

  it("does not invent a seen baseline for an unknown install version", async () => {
    mocks.version = "99.0.0";
    mocks.settings = {
      firstRunNoticeConfirmed: true,
      whatsNewSeenVersion: "upstream:4.0.21",
    };
    renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "newLayoutNotice.confirm" }),
    );
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          newLayoutNoticeConfirmed: true,
          whatsNewSeenVersion: "upstream:4.0.21",
        }),
      ),
    );
  });

  it("welcome confirmation stamps the actual fork baseline and suppresses both later notices", async () => {
    mocks.settings = {};
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <FirstRunNoticeDialog />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "firstRunNotice.confirm" }),
    );
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          firstRunNoticeConfirmed: true,
          newLayoutNoticeConfirmed: true,
          whatsNewSeenVersion: "upstream:4.0.21",
        }),
      ),
    );
  });
});
