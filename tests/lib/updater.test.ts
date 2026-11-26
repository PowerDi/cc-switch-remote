import { beforeEach, describe, expect, it, vi } from "vitest";
import metadata from "../fixtures/releaseIdentity.json";
vi.mock("../../release-identity.json", async () => ({
  default: structuredClone(
    (await import("../fixtures/releaseIdentity.json")).default,
  ),
}));

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  proxy: vi.fn(),
  check: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@/lib/api/globalProxy", () => ({ getGlobalProxyUrl: mocks.proxy }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
import { checkForUpdate } from "@/lib/updater";
import { updateReleasePageUrl } from "@/lib/forkReleases";

const update = () => ({
  version: "4.0.21-remote.2",
  body: "Actual release body",
  notes: "Not the plugin's notes property",
  date: "2026-01-01",
  rawJson: {
    releaseIdentity: {
      schemaVersion: 2,
      ...metadata.current,
      remoteRevision: 2,
      releaseTag: "remote-v4.0.21-r2",
      packageVersion: "4.0.21-remote.2",
    },
  },
  close: vi.fn().mockResolvedValue(undefined),
});
beforeEach(() => {
  mocks.getVersion.mockReset().mockResolvedValue("4.0.21-remote.1");
  mocks.proxy.mockReset().mockResolvedValue(null);
  mocks.check.mockReset();
});

describe("updater response adapter", () => {
  it("reads rawJson/body, preserves installer semver and closes the check resource", async () => {
    const result = update();
    mocks.check.mockResolvedValue(result);
    mocks.proxy.mockResolvedValue(" http://localhost:7890 ");
    const response = await checkForUpdate({ timeout: 1234 });
    expect(mocks.check).toHaveBeenCalledWith({
      timeout: 1234,
      proxy: "http://localhost:7890",
    });
    expect(response).toMatchObject({
      status: "available",
      info: {
        currentVersion: "4.0.21-remote.1",
        availableVersion: "4.0.21-remote.2",
        notes: "Actual release body",
        pubDate: "2026-01-01",
        releaseIdentity: { releaseTag: "remote-v4.0.21-r2" },
      },
    });
    expect(result.close).toHaveBeenCalledOnce();
  });

  it("no update returns up-to-date and does not invent a resource or version", async () => {
    mocks.check.mockResolvedValue(null);
    expect(await checkForUpdate()).toEqual({ status: "up-to-date" });
    expect(mocks.check).toHaveBeenCalledWith({ timeout: 30000 });
  });

  it("unknown or malformed future identity degrades to safe release-list fallback", async () => {
    const result = update();
    result.rawJson.releaseIdentity.releaseTag = "v4.0.21-remote.2";
    mocks.check.mockResolvedValue(result);
    const response = await checkForUpdate();
    expect(response.status).toBe("available");
    if (response.status !== "available")
      throw new Error("Expected available update");
    expect(response.info.releaseIdentity).toBeNull();
    expect(
      updateReleasePageUrl(
        response.info.availableVersion,
        response.info.releaseIdentity,
      ),
    ).toBe("https://github.com/PowerDi/cc-switch-remote/releases");
    expect(result.close).toHaveBeenCalledOnce();
  });

  it("legacy payload without identity uses only the explicit historical mapping", async () => {
    const result = {
      version: "4.0.9",
      body: "legacy",
      rawJson: {},
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.check.mockResolvedValue(result);
    const response = await checkForUpdate();
    expect(response).toMatchObject({
      status: "available",
      info: {
        releaseIdentity: { releaseTag: "v4.0.9", upstreamVersion: "4.0.4" },
      },
    });
    expect(result.close).toHaveBeenCalledOnce();
  });

  it("proxy state failure does not prevent the updater's independent check", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.proxy.mockRejectedValue(new Error("state not managed"));
    mocks.check.mockResolvedValue(null);
    expect(await checkForUpdate()).toEqual({ status: "up-to-date" });
    expect(mocks.check).toHaveBeenCalledWith({ timeout: 30000 });
    vi.restoreAllMocks();
  });

  it("resource close failure does not discard valid update info", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = update();
    result.close.mockRejectedValue(new Error("already closed"));
    mocks.check.mockResolvedValue(result);
    expect(await checkForUpdate()).toMatchObject({ status: "available" });
    expect(result.close).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("adapter failures still close the obtained resource; transport failures propagate", async () => {
    const result = update();
    Object.defineProperty(result, "rawJson", {
      get() {
        throw new Error("bad metadata access");
      },
    });
    mocks.check.mockResolvedValue(result);
    await expect(checkForUpdate()).rejects.toThrow("bad metadata access");
    expect(result.close).toHaveBeenCalledOnce();
    mocks.check.mockRejectedValue(new Error("offline"));
    await expect(checkForUpdate()).rejects.toThrow("offline");
  });
});
