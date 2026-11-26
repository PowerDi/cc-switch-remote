#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const DEFAULT_IDENTITY_FILE = path.join(
  REPO_ROOT,
  'release-identity.json',
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
  const prerelease = match[4]?.split('.') ?? [];
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

function validateRecord(record, legacy = false) {
  requireValue(
    STABLE_VERSION.test(record.packageVersion),
    'Invalid packageVersion',
  );
  const parts = record.packageVersion.split('.').map(Number);
  requireValue(
    parts[0] <= 255 && parts[1] <= 255 && parts[2] <= 65535,
    'packageVersion exceeds MSI version limits',
  );
  requireValue(
    STABLE_VERSION.test(record.upstreamVersion) &&
      SHA.test(record.upstreamCommit),
    'Invalid upstream release baseline',
  );
  if (legacy) {
    requireValue(
      record.remoteRevision === null &&
        record.releaseTag === `v${record.packageVersion}`,
      'Legacy release mapping must retain its original tag/version',
    );
  } else {
    requireValue(
      Number.isSafeInteger(record.remoteRevision) && record.remoteRevision > 0,
      'Invalid remoteRevision',
    );
    requireValue(
      record.releaseTag ===
        `remote-v${record.upstreamVersion}-r${record.remoteRevision}`,
      'releaseTag does not match upstreamVersion/remoteRevision',
    );
  }
}

export function readReleaseMetadata(identityFile = DEFAULT_IDENTITY_FILE) {
  const metadata = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  requireValue(
    metadata.schemaVersion === 1 &&
      metadata.repository === 'PowerDi/cc-switch-remote',
    'Unknown release identity schema/repository',
  );
  requireValue(
    Array.isArray(metadata.history) && metadata.history.length > 0,
    'Published release history is required',
  );
  const tags = new Set();
  const versions = new Set();
  const baselines = new Map();
  for (const record of [...metadata.history, metadata.current]) {
    requireValue(
      !baselines.has(record.upstreamVersion) ||
        baselines.get(record.upstreamVersion) === record.upstreamCommit,
      'The same upstream release version must retain the same official commit',
    );
    baselines.set(record.upstreamVersion, record.upstreamCommit);
  }
  for (const record of metadata.history) {
    validateRecord(record, record.releaseTag?.startsWith('v'));
    requireValue(
      record.status === 'published' && SHA.test(record.releaseCommit),
      'History must contain verified published commits',
    );
    requireValue(
      !tags.has(record.releaseTag) && !versions.has(record.packageVersion),
      'Duplicate published tag/installation version',
    );
    tags.add(record.releaseTag);
    versions.add(record.packageVersion);
  }
  validateRecord(metadata.current);
  requireValue(
    ['unreleased', 'published'].includes(metadata.current.status),
    'Invalid current release status',
  );
  requireValue(
    typeof metadata.current.releaseReady === 'boolean',
    'releaseReady must be explicit',
  );
  requireValue(
    metadata.current.notesFile ===
      `docs/release-notes/${metadata.current.releaseTag}-remote-zh.md`,
    'Release notes must be explicitly fork-owned and tag-specific',
  );
  requireValue(
    ['pending', 'manual-portable-migration'].includes(
      metadata.migration?.decision,
    ),
    'Unknown migration decision',
  );
  requireValue(
    STABLE_VERSION.test(metadata.migration.legacyPortableThrough) &&
      STABLE_VERSION.test(metadata.migration.legacyDetailsThrough),
    'Legacy compatibility boundaries must be explicit installation versions',
  );
  for (const key of ['normalUpdater', 'recoveryUpdater', 'portableMigration']) {
    requireValue(
      ['pending', 'verified'].includes(metadata.upgradeValidation?.[key]),
      `Upgrade validation status must be explicit: ${key}`,
    );
  }
  if (process.env.GITHUB_REPOSITORY)
    requireValue(
      process.env.GITHUB_REPOSITORY === metadata.repository,
      'Workflow repository is not the configured fork',
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
    parseSemver(legacy[1]);
    return (
      metadata.history.find((record) => record.releaseTag === tag) ?? {
        releaseTag: tag,
        packageVersion: legacy[1],
        remoteRevision: null,
      }
    );
  }
  const record =
    metadata.history.find((item) => item.releaseTag === tag) ??
    (metadata.current.releaseTag === tag ? metadata.current : null);
  requireValue(
    record,
    `No explicit release identity for ${tag}; refusing to infer an installation version`,
  );
  requireValue(
    allowUnready ||
      record.status === 'published' ||
      record.releaseReady === true,
    `${tag} is not release-ready`,
  );
  if (
    !allowUnready &&
    record === metadata.current &&
    record.status !== 'published'
  ) {
    verifyReleaseReadiness(metadata, REPO_ROOT, { checkNotes: false });
  }
  return record;
}

export function updaterReleaseIdentity(record) {
  if (record.remoteRevision == null) return undefined;
  return {
    schemaVersion: 1,
    upstreamVersion: record.upstreamVersion,
    upstreamCommit: record.upstreamCommit,
    remoteRevision: record.remoteRevision,
    releaseTag: record.releaseTag,
    packageVersion: record.packageVersion,
  };
}

export function verifyBuildIdentity(metadata, root = REPO_ROOT) {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const packageVersion = metadata.current.packageVersion;
  const cargoPackage = read('src-tauri/Cargo.toml').match(
    /\[package\]([\s\S]*?)(?=\n\[)/,
  )?.[1];
  const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lockVersion = read('src-tauri/Cargo.lock').match(
    /\[\[package\]\]\r?\nname = "cc-switch-remote"\r?\nversion = "([^"]+)"/,
  )?.[1];
  for (const [file, version] of Object.entries({
    'package.json': JSON.parse(read('package.json')).version,
    'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json'))
      .version,
    'src-tauri/Cargo.toml': cargoVersion,
    'src-tauri/Cargo.lock': lockVersion,
  })) {
    requireValue(
      version === packageVersion,
      `${file}: installation version ${version} does not match ${packageVersion}`,
    );
  }
  for (const previous of metadata.history) {
    requireValue(
      comparePackageVersions(packageVersion, previous.packageVersion) >= 0,
      'Build installation version is older than a published fork version',
    );
  }
  if (metadata.current.releaseReady) verifyReleaseReadiness(metadata, root);
}

export function verifyReleaseReadiness(
  metadata,
  root = REPO_ROOT,
  { checkNotes = true } = {},
) {
  const current = metadata.current;
  requireValue(
    current.releaseReady,
    'Release blocked: releaseReady=false (implementation build, not release preparation)',
  );
  requireValue(
    metadata.migration.decision === 'manual-portable-migration',
    'Release blocked: legacy portable migration decision is pending',
  );
  requireValue(
    Object.values(metadata.upgradeValidation).every(
      (status) => status === 'verified',
    ),
    'Release blocked: installed-client upgrade paths have not all been verified',
  );
  requireValue(
    current.status === 'unreleased',
    'Only a new, unreleased identity may be published',
  );
  requireValue(
    !metadata.history.some(
      (record) => record.releaseTag === current.releaseTag,
    ),
    'Public tag has already been published',
  );
  for (const previous of metadata.history) {
    requireValue(
      comparePackageVersions(current.packageVersion, previous.packageVersion) >
        0,
      `Installation version must be strictly newer than ${previous.releaseTag} (${previous.packageVersion})`,
    );
    requireValue(
      comparePackageVersions(
        current.upstreamVersion,
        previous.upstreamVersion,
      ) >= 0,
      'Upstream baseline cannot silently go backwards',
    );
  }
  const revisions = metadata.history.filter(
    (record) =>
      record.upstreamVersion === current.upstreamVersion &&
      record.remoteRevision != null,
  );
  const nextRevision =
    Math.max(0, ...revisions.map((record) => record.remoteRevision)) + 1;
  requireValue(
    current.remoteRevision === nextRevision,
    `Expected Remote r${nextRevision} for this baseline`,
  );
  if (!checkNotes) return;
  const notes = fs.readFileSync(path.join(root, current.notesFile), 'utf8');
  requireValue(
    notes.includes(current.releaseTag) &&
      notes.includes(current.packageVersion),
    'Fork release notes must identify both public tag and installation version',
  );
  requireValue(
    notes.includes('<!-- manual-portable-migration -->'),
    'First new naming releases must explicitly document the approved legacy portable migration',
  );
}

function git(args, root = REPO_ROOT) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function verifyPublication(
  metadata,
  tag,
  publishedTagsFile,
  upstreamReleaseFile,
  { root = REPO_ROOT, eventCommit = process.env.GITHUB_SHA } = {},
) {
  // CLI always uses the real repository; callers may validate a separate checkout.
  const runGit = (args) => git(args, root);
  verifyReleaseReadiness(metadata, root);
  requireValue(
    tag === metadata.current.releaseTag,
    'Pushed tag must exactly match the release identity',
  );
  const head = runGit(['rev-parse', 'HEAD']);
  if (eventCommit) {
    requireValue(
      runGit(['rev-parse', `${eventCommit}^{}`]) === head,
      'Checked-out commit does not match the workflow event commit',
    );
  }
  requireValue(
    runGit(['rev-parse', `refs/tags/${tag}^{}`]) === head,
    'Release tag does not point to the checked-out commit',
  );
  runGit(['merge-base', '--is-ancestor', head, 'refs/remotes/origin/main']);
  const upstreamTag = `v${metadata.current.upstreamVersion}`;
  requireValue(
    upstreamReleaseFile,
    '--publish requires the official published release response',
  );
  const upstreamRelease = JSON.parse(
    fs.readFileSync(upstreamReleaseFile, 'utf8'),
  );
  requireValue(
    upstreamRelease.tag_name === upstreamTag &&
      upstreamRelease.draft === false &&
      upstreamRelease.prerelease === false &&
      upstreamRelease.published_at,
    'Baseline must be an official published stable release',
  );
  requireValue(
    upstreamRelease.html_url ===
      `https://github.com/farion1231/cc-switch/releases/tag/${upstreamTag}`,
    'Upstream release response does not belong to the official repository',
  );
  requireValue(
    runGit(['rev-parse', `refs/remotes/upstream/tags/${upstreamTag}^{}`]) ===
      metadata.current.upstreamCommit,
    'upstreamCommit does not match the peeled official release tag',
  );
  runGit([
    'merge-base',
    '--is-ancestor',
    metadata.current.upstreamCommit,
    head,
  ]);
  for (const previous of metadata.history) {
    requireValue(
      runGit(['rev-parse', `refs/tags/${previous.releaseTag}^{}`]) ===
        previous.releaseCommit,
      `Historical fork tag moved: ${previous.releaseTag}`,
    );
    runGit(['merge-base', '--is-ancestor', previous.releaseCommit, head]);
  }
  requireValue(
    publishedTagsFile,
    '--publish requires the actual GitHub published release tag list',
  );
  const publishedTags = fs
    .readFileSync(publishedTagsFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  requireValue(
    publishedTags.length > 0,
    'Published release inventory is empty',
  );
  for (const previousTag of publishedTags) {
    if (previousTag === 'remote-helper-latest') continue;
    requireValue(
      previousTag !== tag,
      `${tag} already exists as a published release`,
    );
    const previous = resolveReleaseIdentity(previousTag, { metadata });
    // Existing legacy releases may use semver prerelease identifiers even when
    // GitHub marks them stable; compare their actual installer semver, not the tag label.
    requireValue(
      comparePackageVersions(
        metadata.current.packageVersion,
        previous.packageVersion,
      ) > 0,
      `Installation version is not newer than published ${previousTag}`,
    );
  }
}

function main() {
  const args = {};
  const flags = new Set([
    '--publish',
    '--resolve-only',
    '--require-fork-notes',
  ]);
  const options = new Set([
    '--identity-file',
    '--tag',
    '--published-tags-file',
    '--upstream-release-file',
    '--github-output',
    '--notes-file',
  ]);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (flags.has(argv[i])) args[argv[i]] = true;
    else if (options.has(argv[i]) && argv[i + 1]) args[argv[i]] = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  const metadata = readReleaseMetadata(args['--identity-file']);
  if (!args['--resolve-only']) verifyBuildIdentity(metadata);
  const tag = args['--tag'] ?? metadata.current.releaseTag;
  const record = resolveReleaseIdentity(tag, {
    metadata,
    allowUnready: !args['--resolve-only'] && !args['--publish'],
  });
  if (args['--publish'])
    verifyPublication(
      metadata,
      tag,
      args['--published-tags-file'],
      args['--upstream-release-file'],
    );
  if (args['--require-fork-notes']) {
    requireValue(
      args['--notes-file'] === `docs/release-notes/${tag}-remote-zh.md`,
      'Refusing unrelated/upstream release notes',
    );
    requireValue(
      fs.existsSync(path.join(REPO_ROOT, args['--notes-file'])),
      'Fork release note file does not exist',
    );
  }
  const output = {
    'release-tag': record.releaseTag,
    'package-version': record.packageVersion,
    'display-version': publicVersion(record),
    'release-ready': String(metadata.current.releaseReady),
    'notes-file': record.notesFile ?? `docs/release-notes/${tag}-remote-zh.md`,
  };
  if (args['--github-output'])
    fs.appendFileSync(
      args['--github-output'],
      Object.entries(output)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
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
