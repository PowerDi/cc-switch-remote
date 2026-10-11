import i18next from "i18next";
import type { ManagementTarget } from "./remote";

/** These v4 reads have no helper command yet. Do not infer support from `usage`. */
export type LocalUsageRead =
  | "sessionSummary"
  | "lastSessionSync"
  | "providerLimits";

export function supportsLocalUsageRead(target: ManagementTarget): boolean {
  return target.type === "local";
}

export class RemoteUsageReadUnsupportedError extends Error {
  readonly code = "remote_usage_read_unsupported";

  constructor(readonly operation: LocalUsageRead) {
    super(
      i18next.t("remote.unsupportedUsageRead", {
        defaultValue:
          "The remote helper does not yet support this usage query.",
      }) || "The remote helper does not yet support this usage query.",
    );
    this.name = "RemoteUsageReadUnsupportedError";
  }
}

export function requireLocalUsageRead(
  target: ManagementTarget,
  operation: LocalUsageRead,
): void {
  if (!supportsLocalUsageRead(target)) {
    throw new RemoteUsageReadUnsupportedError(operation);
  }
}
