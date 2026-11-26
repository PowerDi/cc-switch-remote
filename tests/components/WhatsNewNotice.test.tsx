import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsNewEntry } from "@/lib/whatsNew";

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  save: vi.fn(),
  openExternal: vi.fn(),
  version: "4.0.21-remote.1",
  revision: 1,
  settings: undefined as
    | {
        firstRunNoticeConfirmed?: boolean;
        newLayoutNoticeConfirmed?: boolean;
        whatsNewSeenVersion?: string;
      }
    | undefined,
  entries: [] as WhatsNewEntry[],
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
vi.mock("../../release-identity.json", async () => {
  const { default: metadata } = await import(
    "../fixtures/releaseIdentity.json"
  );
  return {
    default: {
      ...metadata,
      get current() {
        return {
          ...metadata.current,
          remoteRevision: mocks.revision,
          packageVersion: `4.0.21-remote.${mocks.revision}`,
          releaseTag: `remote-v${metadata.current.upstreamVersion}-r${mocks.revision}`,
        };
      },
    },
  };
});
vi.mock("@/lib/whatsNew", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsNew")>()),
  get WHATS_NEW_ENTRIES() {
    return mocks.entries;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh" },
    t: (key: string, options?: { version?: string }) => {
      if (key === "releaseIdentity.upstreamSummary")
        return `Upstream ${options?.version}`;
      if (key === "whatsNew.updatedTo") return `Updated ${options?.version}`;
      if (key === "whatsNew.since") return `Since upstream ${options?.version}`;
      return key;
    },
  }),
}));

import { WhatsNewNotice } from "@/components/WhatsNewDialog";
const entry = (version: string, ...texts: string[]): WhatsNewEntry => ({
  version,
  items: texts.map((text) => ({
    type: "fix",
    zh: text,
    "zh-TW": text,
    en: `${text}-en`,
    ja: `${text}-ja`,
  })),
});
function renderNotice() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WhatsNewNotice />
    </QueryClientProvider>,
  );
}
const title = () => screen.queryByText(/^Updated /);
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe("WhatsNewNotice fork baseline routing", () => {
  beforeEach(() => {
    mocks.version = "4.0.21-remote.1";
    mocks.revision = 1;
    mocks.settings = {
      firstRunNoticeConfirmed: true,
      newLayoutNoticeConfirmed: true,
      whatsNewSeenVersion: "4.0.9",
    };
    mocks.entries = [
      entry("4.0.40", "not merged upstream"),
      entry("4.0.21", "baseline first", "baseline second"),
      entry("4.0.20"),
      entry("4.0.10", "intermediate"),
      entry("4.0.4", "already seen baseline"),
    ];
    mocks.save.mockReset().mockResolvedValue(true);
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
    mocks.getAll.mockReset().mockResolvedValue({ p1: { id: "p1" } });
  });

  it("maps legacy install 4.0.9 to upstream 4.0.4 and caps install 4.1.0 at upstream 4.0.21", async () => {
    renderNotice();
    expect(
      await screen.findByText("Updated 4.0.21 · Remote r1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Since upstream 4.0.4")).toBeInTheDocument();
    expect(screen.getByText("Upstream 4.0.21")).toBeInTheDocument();
    expect(screen.getByText("baseline second")).toBeInTheDocument();
    expect(screen.getByText("Upstream 4.0.10")).toBeInTheDocument();
    expect(screen.queryByText("Upstream 4.0.4")).not.toBeInTheDocument();
    expect(screen.queryByText("Upstream 4.0.20")).not.toBeInTheDocument();
    expect(screen.queryByText("not merged upstream")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "whatsNew.confirm" }));
    await waitFor(() => expect(title()).not.toBeInTheDocument());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ whatsNewSeenVersion: "upstream:4.0.21" }),
    );
  });

  it("shows only the actual current baseline when no seen range is known", async () => {
    mocks.settings!.whatsNewSeenVersion = undefined;
    renderNotice();
    expect(await screen.findByText("Upstream 4.0.21")).toBeInTheDocument();
    expect(screen.queryByText("Upstream 4.0.10")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Since upstream/)).not.toBeInTheDocument();
  });

  it.each(["4.1.0", "upstream:4.0.21"])(
    "does not replay baseline already seen as %s",
    async (seen) => {
      mocks.settings!.whatsNewSeenVersion = seen;
      mocks.revision = 2; // Synthetic next Remote revision, not a production history entry.
      mocks.version = "4.0.21-remote.2";
      renderNotice();
      await settle();
      expect(title()).not.toBeInTheDocument();
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it("stays closed after a known fork downgrade and preserves the higher seen baseline", async () => {
    mocks.version = "4.0.9";
    mocks.settings!.whatsNewSeenVersion = "4.1.0";
    renderNotice();
    await settle();
    expect(title()).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("silently stamps actual baseline when all entries in range are empty", async () => {
    mocks.entries = [entry("4.0.21"), entry("4.0.4", "already seen")];
    renderNotice();
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({ whatsNewSeenVersion: "upstream:4.0.21" }),
      ),
    );
    expect(title()).not.toBeInTheDocument();
  });

  it("does not infer a baseline or rewrite seen state for an unknown installation version", async () => {
    mocks.version = "99.0.0";
    renderNotice();
    await settle();
    expect(title()).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("an unknown old seen stamp is not interpreted as upstream semver", async () => {
    mocks.settings!.whatsNewSeenVersion = "4.0.19";
    renderNotice();
    await screen.findByText("Upstream 4.0.21");
    expect(screen.queryByText("Upstream 4.0.10")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Since upstream/)).not.toBeInTheDocument();
  });

  it("waits for welcome confirmation on a fresh install", async () => {
    mocks.settings = { firstRunNoticeConfirmed: undefined };
    renderNotice();
    await settle();
    expect(title()).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("waits while the new layout dialog is showing", async () => {
    mocks.settings = {
      firstRunNoticeConfirmed: true,
      whatsNewSeenVersion: "4.0.9",
    };
    renderNotice();
    await waitFor(() => expect(mocks.getAll).toHaveBeenCalled());
    await settle();
    expect(title()).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("shows when the new layout dialog does not apply", async () => {
    mocks.settings = {
      firstRunNoticeConfirmed: true,
      whatsNewSeenVersion: "4.0.9",
    };
    mocks.getAll.mockResolvedValue({});
    renderNotice();
    expect(
      await screen.findByText("Updated 4.0.21 · Remote r1"),
    ).toBeInTheDocument();
  });

  it("collapses earlier upstream entries and opens only the fork release list", async () => {
    mocks.entries = [
      entry("4.0.21", "latest"),
      entry("4.0.20", "third"),
      entry("4.0.19", "second"),
      entry("4.0.10", "first"),
    ];
    renderNotice();
    await screen.findByText("Upstream 4.0.21");
    expect(screen.queryByText("Upstream 4.0.10")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsNew.showEarlier" }),
    );
    expect(screen.getByText("Upstream 4.0.10")).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "whatsNew.versionDetails" })[0],
    );
    expect(mocks.openExternal).toHaveBeenCalledWith(
      "https://github.com/PowerDi/cc-switch-remote/releases",
    );
    fireEvent.click(screen.getByRole("button", { name: "whatsNew.viewFull" }));
    expect(mocks.openExternal).toHaveBeenLastCalledWith(
      "https://github.com/PowerDi/cc-switch-remote/releases",
    );
    await waitFor(() => expect(title()).not.toBeInTheDocument());
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ whatsNewSeenVersion: "upstream:4.0.21" }),
    );
  });
});
