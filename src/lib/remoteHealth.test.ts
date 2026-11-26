import { describe, expect, it } from "vitest";
import type { RemoteHealth } from "./api";
import {
  formatRemoteOperationError,
  describeRemoteConnection,
  formatRemoteHelperBuild,
  formatRemoteHelperLatest,
  formatRemoteHelperLatestBuild,
  formatRemoteHelperVersion,
} from "./remoteHealth";

function health(overrides: Partial<RemoteHealth> = {}): RemoteHealth {
  return {
    reachable: true,
    helperInstalled: true,
    capabilities: [],
    ...overrides,
  };
}

describe("remote helper version formatting", () => {
  it("prioritizes uncertainty over normal validation/preservation wording", () => {
    const t = ((key: string) => key) as any;
    expect(
      formatRemoteOperationError(
        {
          code: "helper-protocol",
          message: "ack lost",
          remoteStateUncertain: true,
        },
        t,
      ),
    ).toBe("remote.operationErrors.uncertain (ack lost)");
    expect(
      formatRemoteOperationError(
        {
          code: "helper-validation",
          message: "bad",
          remoteStateUncertain: false,
        },
        t,
      ),
    ).toBe("remote.operationErrors.validation (bad)");
  });

  it("does not claim a helper exists when the presence probe protocol failed", () => {
    expect(
      describeRemoteConnection(
        health({
          reachable: false,
          sshReachable: true,
          helperInstalled: false,
          failureStage: "helper-error",
          failureCode: "probe-protocol",
        }),
      ),
    ).toEqual({ ssh: "ok", helper: "unknown", stage: null });
  });

  it("hides helper build hashes from display text", () => {
    const remoteHealth = health({
      helperVersion: "3.16.4",
      helperBuild: "9f1869de1234567890",
      helperLatestVersion: "3.16.4",
      helperLatestBuild: "b98d8acb1234567890",
    });

    expect(formatRemoteHelperVersion(remoteHealth)).toBe("3.16.4");
    expect(formatRemoteHelperLatest(remoteHealth)).toBe("3.16.4");
    expect(formatRemoteHelperBuild(remoteHealth)).toBe("9f1869de");
    expect(formatRemoteHelperLatestBuild(remoteHealth)).toBe("b98d8acb");
  });

  it("keeps legacy helper versions readable when no build is reported", () => {
    const remoteHealth = health({
      helperVersion: "3.16.4",
      helperLatestVersion: "3.16.4",
    });

    expect(formatRemoteHelperVersion(remoteHealth)).toBe("3.16.4");
    expect(formatRemoteHelperLatest(remoteHealth)).toBe("3.16.4");
    expect(formatRemoteHelperBuild(remoteHealth)).toBeNull();
    expect(formatRemoteHelperLatestBuild(remoteHealth)).toBeNull();
  });
});
