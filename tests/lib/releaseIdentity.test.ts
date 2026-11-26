import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  metadata:
    null as unknown as typeof import("../fixtures/releaseIdentity.json"),
  source: null as unknown as typeof import("../fixtures/releaseIdentity.json"),
}));
vi.mock("../../release-identity.json", async () => {
  const { default: metadata } = await import(
    "../fixtures/releaseIdentity.json"
  );
  fixture.source = structuredClone(metadata);
  fixture.metadata = structuredClone(metadata);
  return { default: fixture.metadata };
});

import {
  currentUpstreamVersion,
  getBuildIdentity,
  getPublishedIdentity,
  identityVersion,
  isUnreleasedBuild,
  parseUpdateIdentity,
  resolveUpstreamSeen,
} from "@/lib/releaseIdentity";
import {
  currentReleasePageUrl,
  FORK_RELEASES_URL,
  FORK_REPOSITORY_URL,
  updateReleasePageUrl,
} from "@/lib/forkReleases";
import { entriesUpTo, markBuildSeen, type WhatsNewEntry } from "@/lib/whatsNew";

const candidate = () => ({
  schemaVersion: 2,
  ...fixture.source.current,
  packageVersion: "4.0.21-remote.2",
  remoteRevision: 2,
  releaseTag: "remote-v4.0.21-r2",
});
beforeEach(() =>
  Object.assign(fixture.metadata, structuredClone(fixture.source)),
);

describe("release identity and safe links", () => {
  it("uses current identity only for the exact build and legacy identity only from explicit history", () => {
    expect(identityVersion(getBuildIdentity("4.0.21-remote.1")!)).toBe(
      "4.0.21 · Remote r1",
    );
    expect(identityVersion(getBuildIdentity("4.0.9")!)).toBe("Remote v4.0.9");
    expect(getPublishedIdentity("4.1.0")?.remoteRevision).toBeNull();
    expect(getBuildIdentity("4.2.0")).toBeNull();
    expect(currentUpstreamVersion("99.0.0")).toBeUndefined();
    expect(FORK_REPOSITORY_URL).toBe(
      "https://github.com/PowerDi/cc-switch-remote",
    );
  });

  it("valid updater identity displays upstream+Remote revision while URLs use its explicit tag", () => {
    const identity = parseUpdateIdentity(candidate(), "4.0.21-remote.2");
    expect(identity).toMatchObject({
      packageVersion: "4.0.21-remote.2",
      upstreamVersion: "4.0.21",
      remoteRevision: 2,
    });
    expect(identityVersion(identity!)).toBe("4.0.21 · Remote r2");
    expect(updateReleasePageUrl("4.0.21-remote.2", identity)).toBe(
      `${FORK_RELEASES_URL}/tag/remote-v4.0.21-r2`,
    );
  });

  it.each([
    undefined,
    null,
    {},
    { schemaVersion: 1 },
    { packageVersion: "4.3.0" },
    { releaseTag: "v4.0.21-remote.2" },
    { releaseTag: "remote-v4.0.21-r3" },
    { upstreamCommit: "bad" },
    { upstreamCommit: "G".repeat(40) },
    { upstreamVersion: "4.0.21-beta.1" },
    { remoteRevision: 0 },
    { remoteRevision: 2.5 },
    { remoteRevision: "1" },
    { upstreamCommit: undefined },
  ])(
    "invalid or missing metadata falls back instead of guessing an installer tag (%j)",
    (change) => {
      const raw =
        change === undefined ||
        change === null ||
        Object.keys(change).length === 0
          ? change
          : { ...candidate(), ...change };
      const identity = parseUpdateIdentity(raw, "4.0.21-remote.2");
      expect(identity).toBeNull();
      expect(updateReleasePageUrl("4.0.21-remote.2", identity)).toBe(
        FORK_RELEASES_URL,
      );
      expect(updateReleasePageUrl("4.0.21-remote.2", identity)).not.toContain(
        "v4.0.21-remote.2",
      );
    },
  );

  it("known historical updates retain original tag while unknown future/current builds use the fork list", () => {
    expect(updateReleasePageUrl("4.0.9")).toBe(
      `${FORK_RELEASES_URL}/tag/v4.0.9`,
    );
    expect(updateReleasePageUrl("4.1.0")).toBe(
      `${FORK_RELEASES_URL}/tag/v4.1.0`,
    );
    expect(updateReleasePageUrl("99.0.0")).toBe(FORK_RELEASES_URL);
    expect(currentReleasePageUrl("99.0.0")).toBe(FORK_RELEASES_URL);
    expect(currentReleasePageUrl("4.0.21-remote.1")).toBe(FORK_RELEASES_URL);
    expect(currentReleasePageUrl("4.0.9")).toBe(
      `${FORK_RELEASES_URL}/tag/v4.0.9`,
    );
  });

  it("ready release artifacts do not permanently show unpublished despite embedded unreleased status", () => {
    expect(isUnreleasedBuild("4.0.21-remote.1")).toBe(true);
    fixture.metadata.current.releaseReady = true; // in-memory synthetic candidate, not actual release readiness
    expect(fixture.metadata.current.status).toBe("unreleased");
    expect(isUnreleasedBuild("4.0.21-remote.1")).toBe(false);
    expect(currentReleasePageUrl("4.0.21-remote.1")).toBe(
      `${FORK_RELEASES_URL}/tag/remote-v4.0.21-r1`,
    );
    expect(isUnreleasedBuild("99.0.0")).toBe(false);
  });
});

describe("upstream seen migration", () => {
  it("maps only verified legacy install versions and accepts the new upstream namespace", () => {
    expect(resolveUpstreamSeen("4.0.9")).toBe("4.0.4");
    expect(resolveUpstreamSeen("4.1.0")).toBe("4.0.21");
    expect(resolveUpstreamSeen("upstream:4.0.21")).toBe("4.0.21");
    expect(resolveUpstreamSeen("4.0.19")).toBeUndefined();
    expect(resolveUpstreamSeen("upstream:not-a-version")).toBeUndefined();
    expect(markBuildSeen("4.0.9", "4.1.0")).toBe("upstream:4.0.21");
    expect(markBuildSeen("4.1.0", "4.0.9")).toBe("upstream:4.0.21");
    expect(markBuildSeen("upstream:4.0.40", "4.1.0")).toBe("upstream:4.0.40");
    expect(markBuildSeen("4.0.9", "99.0.0")).toBe("4.0.9");
  });

  it("a higher Remote revision cannot expose future unmerged upstream 4.0.x entries", () => {
    fixture.metadata.current.packageVersion = "4.0.21-remote.2";
    fixture.metadata.current.remoteRevision = 2;
    fixture.metadata.current.releaseTag = "remote-v4.0.21-r2";
    const item = {
      type: "fix" as const,
      zh: "summary",
      "zh-TW": "summary",
      en: "summary",
      ja: "summary",
    };
    const entries: WhatsNewEntry[] = [
      { version: "4.0.40", items: [item] },
      { version: "4.0.21", items: [item] },
    ];
    const baseline = currentUpstreamVersion("4.0.21-remote.2")!;
    expect(baseline).toBe("4.0.21");
    expect(
      entriesUpTo(entries, baseline).map((entry) => entry.version),
    ).toEqual(["4.0.21"]);
    expect(markBuildSeen("upstream:4.0.21", "4.0.21-remote.2")).toBe(
      "upstream:4.0.21",
    );
  });
});
