#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const DEFAULT_IDENTITY_FILE = path.join(
  REPO_ROOT,
  "release-identity.json",
);
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LEGACY_TAG =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const SHA = /^[a-f0-9]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseSemver(version) {
  const match = SEMVER.exec(version);
  requireValue(match, `Invalid installation semver: ${version}`);
  const prerelease = match[4]?.split(".") ?? [];
  requireValue(
    prerelease.every((part) => !/^\d+$/.test(part) || !/^0\d/.test(part)),
    `Invalid numeric prerelease identifier: ${version}`,
  );
  return { core: match.slice(1, 4).map(Number), prerelease };
}

export function comparePackageVersions(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (av.core[i] !== bv.core[i]) return av.core[i] > bv.core[i] ? 1 : -1;
  }
  if (!av.prerelease.length || !bv.prerelease.length) {
    return av.prerelease.length === bv.prerelease.length
      ? 0
      : av.prerelease.length
        ? -1
        : 1;
  }
  for (
    let i = 0;
    i < Math.max(av.prerelease.length, bv.prerelease.length);
    i++
  ) {
    const ap = av.prerelease[i];
    const bp = bv.prerelease[i];
    if (ap === undefined || bp === undefined) return ap === undefined ? -1 : 1;
    if (ap === bp) continue;
    const an = /^\d+$/.test(ap);
    const bn = /^\d+$/.test(bp);
    if (an !== bn) return an ? -1 : 1;
    if (an) return BigInt(ap) > BigInt(bp) ? 1 : -1;
    return ap > bp ? 1 : -1;
  }
  return 0;
}

export function publicVersion(identity) {
  return identity.remoteRevision == null
    ? `Remote ${identity.releaseTag} (legacy)`
    : `${identity.upstreamVersion} · Remote r${identity.remoteRevision}`;
}

export const LEGACY_BOUNDARY = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "release-legacy-boundary.json"), "utf8"),
);
requireValue(
  createHash("sha256").update(JSON.stringify(LEGACY_BOUNDARY)).digest("hex") ===
    "835bcfd7c95cf53016725a46fa42cc4b3d9d24183094f66d994acad23faa973e",
  "Approved legacy boundary changed; explicit migration policy review is required",
);

export function derivedPackageVersion(record) {
  return `${record.upstreamVersion}-remote.${record.remoteRevision}`;
}

function validateRecord(record, legacy = false, schema = 2) {
  parseSemver(record.packageVersion);
  const parts = parseSemver(record.packageVersion).core;
  requireValue(
    parts[0] <= 255 && parts[1] <= 255 && parts[2] <= 65535,
    "packageVersion exceeds MSI version limits",
  );
  requireValue(
    STABLE_VERSION.test(record.upstreamVersion) &&
      SHA.test(record.upstreamCommit),
    "Invalid upstream release baseline",
  );
  if (legacy) {
    requireValue(
      record.remoteRevision === null &&
        record.releaseTag === `v${record.packageVersion}`,
      "Legacy release mapping must retain its original tag/version",
    );
  } else {
    requireValue(
      Number.isSafeInteger(record.remoteRevision) && record.remoteRevision > 0,
      "Invalid remoteRevision",
    );
    requireValue(
      record.releaseTag ===
        `remote-v${record.upstreamVersion}-r${record.remoteRevision}`,
      "releaseTag does not match upstreamVersion/remoteRevision",
    );
    requireValue(
      schema === 1 || record.packageVersion === derivedPackageVersion(record),
      "packageVersion must be derived from upstreamVersion and remoteRevision",
    );
  }
}

function verifyMigrationBoundary(metadata, boundary = LEGACY_BOUNDARY) {
  requireValue(
    metadata.schemaVersion === 2,
    "Schema 1 snapshots are maintenance-only, not publication/build candidates",
  );
  requireValue(
    metadata.migration?.decision === "manual-client-reinstall" &&
      metadata.migration.approval === "manual-migration-approved" &&
      metadata.migration.firstReleaseTag === boundary.firstReleaseTag &&
      metadata.migration.legacyBoundaryFile ===
        "release-legacy-boundary.json" &&
      metadata.migration.evidenceFile === "docs/remote-version-policy.md",
    "Manual client migration approval and exact legacy boundary are required",
  );
  const legacy = metadata.history.filter(
    (record) => record.remoteRevision == null,
  );
  requireValue(
    legacy.length === boundary.releases.length &&
      boundary.releases.every((approved) =>
        legacy.some((record) =>
          ["releaseTag", "packageVersion", "releaseCommit"].every(
            (key) => record[key] === approved[key],
          ),
        ),
      ),
    "Legacy history must exactly match the approved tag/version/SHA boundary",
  );
  const modern = metadata.history.filter(
    (record) => record.remoteRevision != null,
  );
  if (!modern.length) {
    requireValue(
      metadata.current.releaseTag === boundary.firstReleaseTag &&
        metadata.current.packageVersion === boundary.firstPackageVersion,
      "Only the approved first scheme transition may reset legacy semver ordering",
    );
  } else {
    requireValue(
      modern.some(
        (record) =>
          record.releaseTag === boundary.firstReleaseTag &&
          record.packageVersion === boundary.firstPackageVersion,
      ),
      "The first scheme transition must be archived before subsequent releases",
    );
  }
}

function verifyRealInstallEvidence(metadata) {
  const status = metadata.upgradeValidation?.realInstallValidation;
  requireValue(
    status === "not-performed" || status === "verified-with-evidence",
    "Unknown real installation evidence status",
  );
  if (status === "verified-with-evidence")
    requireValue(
      typeof metadata.upgradeValidation.realInstallEvidence === "string" &&
        /^docs\/[^.][^\r\n]*\.md$/.test(
          metadata.upgradeValidation.realInstallEvidence,
        ) &&
        !metadata.upgradeValidation.realInstallEvidence.includes(".."),
      "Verified real installation requires an explicit evidence document",
    );
}

function modernHistory(metadata) {
  return metadata.history.filter((record) => record.remoteRevision != null);
}

export function readReleaseMetadata(identityFile = DEFAULT_IDENTITY_FILE) {
  const metadata = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  requireValue(
    [1, 2].includes(metadata.schemaVersion) &&
      metadata.repository === "PowerDi/cc-switch-remote",
    "Unknown release identity schema/repository",
  );
  requireValue(
    Array.isArray(metadata.history) && metadata.history.length > 0,
    "Published release history is required",
  );
  const tags = new Set();
  const versions = new Set();
  const baselines = new Map();
  for (const record of [...metadata.history, metadata.current]) {
    requireValue(
      !baselines.has(record.upstreamVersion) ||
        baselines.get(record.upstreamVersion) === record.upstreamCommit,
      "The same upstream release version must retain the same official commit",
    );
    baselines.set(record.upstreamVersion, record.upstreamCommit);
  }
  for (const record of metadata.history) {
    validateRecord(
      record,
      record.remoteRevision == null,
      metadata.schemaVersion,
    );
    requireValue(
      record.status === "published" && SHA.test(record.releaseCommit),
      "History must contain verified published commits",
    );
    requireValue(
      !tags.has(record.releaseTag) && !versions.has(record.packageVersion),
      "Duplicate published tag/installation version",
    );
    tags.add(record.releaseTag);
    versions.add(record.packageVersion);
  }
  validateRecord(metadata.current, false, metadata.schemaVersion);
  requireValue(
    ["unreleased", "published"].includes(metadata.current.status),
    "Invalid current release status",
  );
  requireValue(
    typeof metadata.current.releaseReady === "boolean",
    "releaseReady must be explicit",
  );
  requireValue(
    metadata.current.notesFile ===
      `docs/release-notes/${metadata.current.releaseTag}-remote-zh.md`,
    "Release notes must be explicitly fork-owned and tag-specific",
  );
  if (metadata.schemaVersion === 2) {
    verifyMigrationBoundary(metadata);
    requireValue(
      metadata.upgradeValidation?.manualClientMigration ===
        "manual-migration-approved",
      "Manual migration evidence is required",
    );
    for (const key of ["futureUpdaterContract", "installerContract"])
      requireValue(
        ["pending", "contract-reviewed"].includes(
          metadata.upgradeValidation?.[key],
        ),
        `Invalid contract evidence: ${key}`,
      );
    verifyRealInstallEvidence(metadata);
  }
  if (process.env.GITHUB_REPOSITORY)
    requireValue(
      process.env.GITHUB_REPOSITORY === metadata.repository,
      "Workflow repository is not the configured fork",
    );
  return metadata;
}

/** Legacy maintenance derives only from the requested legacy tag, never today's package version. */
export function resolveReleaseIdentity(
  tag,
  { metadata = readReleaseMetadata(), allowUnready = false } = {},
) {
  const legacy = LEGACY_TAG.exec(tag);
  if (legacy) {
    const record = metadata.history.find((record) => record.releaseTag === tag);
    requireValue(
      record && record.remoteRevision == null,
      `No explicit legacy release identity for ${tag}`,
    );
    return record;
  }
  requireValue(
    metadata.schemaVersion === 2,
    "Schema 1 modern identities were never published; refusing invented schema-2 updater metadata",
  );
  const record =
    metadata.history.find((item) => item.releaseTag === tag) ??
    (metadata.current.releaseTag === tag ? metadata.current : null);
  requireValue(
    record,
    `No explicit release identity for ${tag}; refusing to infer an installation version`,
  );
  requireValue(
    allowUnready ||
      record.status === "published" ||
      record.releaseReady === true,
    `${tag} is not release-ready`,
  );
  if (
    !allowUnready &&
    record === metadata.current &&
    record.status !== "published"
  ) {
    verifyReleaseReadiness(metadata, REPO_ROOT, { checkNotes: false });
  }
  return record;
}

export function updaterReleaseIdentity(record) {
  if (record.remoteRevision == null) return undefined;
  validateRecord(record);
  return {
    schemaVersion: 2,
    upstreamVersion: record.upstreamVersion,
    upstreamCommit: record.upstreamCommit,
    remoteRevision: record.remoteRevision,
    releaseTag: record.releaseTag,
    packageVersion: record.packageVersion,
  };
}

export function verifyBuildIdentity(metadata, root = REPO_ROOT) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  verifyMigrationBoundary(metadata);
  validateRecord(metadata.current);
  const packageVersion = metadata.current.packageVersion;
  const cargoPackage = read("src-tauri/Cargo.toml").match(
    /\[package\]([\s\S]*?)(?=\n\[)/,
  )?.[1];
  const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lockVersion = read("src-tauri/Cargo.lock").match(
    /\[\[package\]\]\r?\nname = "cc-switch-remote"\r?\nversion = "([^"]+)"/,
  )?.[1];
  for (const [file, version] of Object.entries({
    "package.json": JSON.parse(read("package.json")).version,
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json"))
      .version,
    "src-tauri/Cargo.toml": cargoVersion,
    "src-tauri/Cargo.lock": lockVersion,
  })) {
    requireValue(
      version === packageVersion,
      `${file}: installation version ${version} does not match ${packageVersion}`,
    );
  }
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  requireValue(
    tauri.bundle?.windows?.wix?.version === metadata.current.upstreamVersion,
    "MSI numeric version must equal upstreamVersion",
  );
  requireValue(
    tauri.bundle?.macOS?.bundleVersion === metadata.current.upstreamVersion &&
      tauri.bundle.macOS.infoPlist === "Info.plist",
    "macOS numeric bundle version must equal upstreamVersion",
  );
  requireValue(
    read("src-tauri/Info.plist").includes(
      `<key>CFBundleShortVersionString</key>\n  <string>${metadata.current.upstreamVersion}</string>`,
    ) ||
      read("src-tauri/Info.plist")
        .replaceAll("\r", "")
        .includes(
          `<key>CFBundleShortVersionString</key>\n  <string>${metadata.current.upstreamVersion}</string>`,
        ),
    "macOS short version must equal upstreamVersion",
  );
  for (const previous of modernHistory(metadata)) {
    requireValue(
      comparePackageVersions(packageVersion, previous.packageVersion) >= 0,
      "Build installation version is older than a published new-scheme version",
    );
  }
  if (metadata.current.releaseReady) verifyReleaseReadiness(metadata, root);
}

export function verifyReleaseReadiness(
  metadata,
  root = REPO_ROOT,
  { checkNotes = true, legacyBoundary = LEGACY_BOUNDARY } = {},
) {
  const current = metadata.current;
  requireValue(current.releaseReady, "Release blocked: releaseReady=false");
  validateRecord(current);
  verifyMigrationBoundary(metadata, legacyBoundary);
  requireValue(
    metadata.upgradeValidation.manualClientMigration ===
      "manual-migration-approved" &&
      metadata.upgradeValidation.futureUpdaterContract ===
        "contract-reviewed" &&
      metadata.upgradeValidation.installerContract === "contract-reviewed",
    "Release blocked: migration approval / upgrade paths contract review / explicit unverified installation evidence is incomplete",
  );
  verifyRealInstallEvidence(metadata);
  requireValue(
    current.status === "unreleased",
    "Only a new, unreleased identity may be published",
  );
  requireValue(
    !metadata.history.some(
      (record) => record.releaseTag === current.releaseTag,
    ),
    "Public tag has already been published",
  );
  for (const previous of metadata.history) {
    if (previous.remoteRevision != null) {
      validateRecord(previous);
      requireValue(
        comparePackageVersions(
          current.packageVersion,
          previous.packageVersion,
        ) > 0,
        `Installation version must be strictly newer than ${previous.releaseTag}`,
      );
    }
    requireValue(
      comparePackageVersions(
        current.upstreamVersion,
        previous.upstreamVersion,
      ) >= 0,
      "Upstream baseline cannot silently go backwards",
    );
  }
  const revisions = modernHistory(metadata).filter(
    (record) => record.upstreamVersion === current.upstreamVersion,
  );
  const nextRevision =
    Math.max(0, ...revisions.map((record) => record.remoteRevision)) + 1;
  requireValue(
    current.remoteRevision === nextRevision,
    `Expected Remote r${nextRevision} for this baseline`,
  );
  if (!checkNotes) return;
  const notes = fs.readFileSync(path.join(root, current.notesFile), "utf8");
  requireValue(
    notes.includes(current.releaseTag) &&
      notes.includes(current.packageVersion),
    "Fork release notes must identify public tag and derived installation version",
  );
  requireValue(
    notes.includes("<!-- manual-client-reinstall -->"),
    "Release notes must document the approved manual client migration",
  );
  const evidence = fs.readFileSync(
    path.join(root, metadata.migration.evidenceFile),
    "utf8",
  );
  const realInstallMarker =
    metadata.upgradeValidation.realInstallValidation === "not-performed"
      ? "<!-- real-install-not-performed -->"
      : "<!-- real-install-verified-with-evidence -->";
  if (
    metadata.upgradeValidation.realInstallValidation ===
    "verified-with-evidence"
  ) {
    const realEvidence = fs.readFileSync(
      path.join(root, metadata.upgradeValidation.realInstallEvidence),
      "utf8",
    );
    requireValue(
      realEvidence.includes(current.releaseTag) &&
        realEvidence.includes(current.packageVersion) &&
        realEvidence.includes("<!-- real-install-verified-with-evidence -->"),
      "Real installation evidence must identify this release and its verification",
    );
  }
  requireValue(
    evidence.includes("<!-- manual-migration-approved -->") &&
      evidence.includes("<!-- contract-reviewed -->") &&
      evidence.includes(realInstallMarker),
    "Version policy must preserve approval, reviewed contracts and unperformed real-install evidence",
  );
}

function git(args, root = REPO_ROOT) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function verifyPublication(
  metadata,
  tag,
  publishedTagsFile,
  upstreamReleaseFile,
  {
    root = REPO_ROOT,
    eventCommit = process.env.GITHUB_SHA,
    legacyBoundary = LEGACY_BOUNDARY,
  } = {},
) {
  // CLI always uses the real repository; callers may validate a separate checkout.
  const runGit = (args) => git(args, root);
  verifyReleaseReadiness(metadata, root, { legacyBoundary });
  requireValue(
    tag === metadata.current.releaseTag,
    "Pushed tag must exactly match the release identity",
  );
  const head = runGit(["rev-parse", "HEAD"]);
  if (eventCommit) {
    requireValue(
      runGit(["rev-parse", `${eventCommit}^{}`]) === head,
      "Checked-out commit does not match the workflow event commit",
    );
  }
  requireValue(
    runGit(["rev-parse", `refs/tags/${tag}^{}`]) === head,
    "Release tag does not point to the checked-out commit",
  );
  runGit(["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"]);
  const upstreamTag = `v${metadata.current.upstreamVersion}`;
  requireValue(
    upstreamReleaseFile,
    "--publish requires the official published release response",
  );
  const upstreamRelease = JSON.parse(
    fs.readFileSync(upstreamReleaseFile, "utf8"),
  );
  requireValue(
    upstreamRelease.tag_name === upstreamTag &&
      upstreamRelease.draft === false &&
      upstreamRelease.prerelease === false &&
      upstreamRelease.published_at,
    "Baseline must be an official published stable release",
  );
  requireValue(
    upstreamRelease.html_url ===
      `https://github.com/farion1231/cc-switch/releases/tag/${upstreamTag}`,
    "Upstream release response does not belong to the official repository",
  );
  requireValue(
    runGit(["rev-parse", `refs/remotes/upstream/tags/${upstreamTag}^{}`]) ===
      metadata.current.upstreamCommit,
    "upstreamCommit does not match the peeled official release tag",
  );
  runGit([
    "merge-base",
    "--is-ancestor",
    metadata.current.upstreamCommit,
    head,
  ]);
  for (const previous of metadata.history) {
    requireValue(
      runGit(["rev-parse", `refs/tags/${previous.releaseTag}^{}`]) ===
        previous.releaseCommit,
      `Historical fork tag moved: ${previous.releaseTag}`,
    );
    runGit(["merge-base", "--is-ancestor", previous.releaseCommit, head]);
  }
  requireValue(
    publishedTagsFile,
    "--publish requires the actual GitHub published release tag list",
  );
  const publishedTags = fs
    .readFileSync(publishedTagsFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  requireValue(
    publishedTags.length > 0,
    "Published release inventory is empty",
  );
  requireValue(
    new Set(publishedTags).size === publishedTags.length,
    "Duplicate published inventory entries",
  );
  for (const record of metadata.history)
    requireValue(
      publishedTags.includes(record.releaseTag),
      `Published inventory is missing historical release ${record.releaseTag}`,
    );
  for (const previousTag of publishedTags) {
    if (previousTag === "remote-helper-latest") continue;
    requireValue(
      previousTag !== tag,
      `${tag} already exists as a published release`,
    );
    const previous = resolveReleaseIdentity(previousTag, { metadata });
    if (previous.remoteRevision == null) {
      // A frozen inventory exemption, never startsWith("v") or a version range.
      requireValue(
        legacyBoundary.releases.some(
          (record) =>
            record.releaseTag === previousTag &&
            record.releaseCommit === previous.releaseCommit &&
            record.packageVersion === previous.packageVersion,
        ),
        `Published legacy release is outside the approved boundary: ${previousTag}`,
      );
    } else {
      requireValue(
        comparePackageVersions(
          metadata.current.packageVersion,
          previous.packageVersion,
        ) > 0,
        `Installation version is not newer than published ${previousTag}`,
      );
    }
  }
}

function main() {
  const args = {};
  const flags = new Set([
    "--publish",
    "--resolve-only",
    "--require-fork-notes",
  ]);
  const options = new Set([
    "--identity-file",
    "--tag",
    "--published-tags-file",
    "--upstream-release-file",
    "--github-output",
    "--notes-file",
  ]);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (flags.has(argv[i])) args[argv[i]] = true;
    else if (options.has(argv[i]) && argv[i + 1]) args[argv[i]] = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  const metadata = readReleaseMetadata(args["--identity-file"]);
  if (!args["--resolve-only"]) verifyBuildIdentity(metadata);
  const tag = args["--tag"] ?? metadata.current.releaseTag;
  const record = resolveReleaseIdentity(tag, {
    metadata,
    allowUnready: !args["--resolve-only"] && !args["--publish"],
  });
  if (args["--publish"])
    verifyPublication(
      metadata,
      tag,
      args["--published-tags-file"],
      args["--upstream-release-file"],
    );
  if (args["--require-fork-notes"]) {
    requireValue(
      args["--notes-file"] === `docs/release-notes/${tag}-remote-zh.md`,
      "Refusing unrelated/upstream release notes",
    );
    requireValue(
      fs.existsSync(path.join(REPO_ROOT, args["--notes-file"])),
      "Fork release note file does not exist",
    );
  }
  const output = {
    "release-tag": record.releaseTag,
    "package-version": record.packageVersion,
    "display-version": publicVersion(record),
    "release-ready": String(metadata.current.releaseReady),
    "notes-file": record.notesFile ?? `docs/release-notes/${tag}-remote-zh.md`,
  };
  if (args["--github-output"])
    fs.appendFileSync(
      args["--github-output"],
      Object.entries(output)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  console.log(JSON.stringify(output, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
