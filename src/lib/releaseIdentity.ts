import metadata from "../../release-identity.json";

export interface ReleaseIdentity {
  upstreamVersion: string;
  upstreamCommit: string;
  remoteRevision: number | null;
  releaseTag: string;
  packageVersion: string;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Only this exact build may use the embedded current identity (including unreleased builds). */
export function getBuildIdentity(
  packageVersion?: string | null,
): ReleaseIdentity | null {
  if (packageVersion === metadata.current.packageVersion)
    return metadata.current;
  return getPublishedIdentity(packageVersion);
}

export function getPublishedIdentity(
  packageVersion?: string | null,
): ReleaseIdentity | null {
  return (
    metadata.history.find(
      (record) => record.packageVersion === packageVersion,
    ) ?? null
  );
}

/** Updater JSON is untrusted metadata, not covered by the artifact's signature. Never infer a tag. */
export function parseUpdateIdentity(
  raw: unknown,
  packageVersion: string,
): ReleaseIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (
    record.schemaVersion !== 2 ||
    record.packageVersion !== packageVersion ||
    typeof record.upstreamVersion !== "string" ||
    !STABLE_VERSION.test(record.upstreamVersion) ||
    packageVersion !== `${record.upstreamVersion}-remote.${record.remoteRevision}` ||
    typeof record.upstreamCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(record.upstreamCommit) ||
    !Number.isSafeInteger(record.remoteRevision) ||
    (record.remoteRevision as number) < 1 ||
    record.releaseTag !==
      `remote-v${record.upstreamVersion}-r${record.remoteRevision}`
  )
    return null;
  return {
    upstreamVersion: record.upstreamVersion,
    upstreamCommit: record.upstreamCommit,
    remoteRevision: record.remoteRevision as number,
    releaseTag: record.releaseTag,
    packageVersion,
  };
}

export function identityVersion(identity: ReleaseIdentity): string {
  return identity.remoteRevision == null
    ? `Remote ${identity.releaseTag}`
    : `${identity.upstreamVersion} · Remote r${identity.remoteRevision}`;
}

export function isUnreleasedBuild(packageVersion?: string | null): boolean {
  return (
    packageVersion === metadata.current.packageVersion &&
    metadata.current.status === "unreleased" &&
    !metadata.current.releaseReady
  );
}

export function currentUpstreamVersion(
  packageVersion?: string | null,
): string | undefined {
  return getBuildIdentity(packageVersion)?.upstreamVersion;
}

/** Known old install-version stamps are mapped explicitly; unknown old stamps are not guessed. */
export function resolveUpstreamSeen(seen?: string): string | undefined {
  if (seen?.startsWith("upstream:")) {
    const version = seen.slice("upstream:".length);
    return STABLE_VERSION.test(version) ? version : undefined;
  }
  return getPublishedIdentity(seen)?.upstreamVersion;
}
