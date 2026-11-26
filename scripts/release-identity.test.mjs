import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  REPO_ROOT,
  LEGACY_BOUNDARY,
  comparePackageVersions,
  publicVersion,
  readReleaseMetadata,
  resolveReleaseIdentity,
  verifyBuildIdentity,
  verifyReleaseReadiness,
  verifyPublication,
} from "./release-identity.mjs";
import {
  candidateMetadata,
  removeFixture,
  tempDir,
  writeJson,
} from "./test-support/release-fixtures.mjs";

function writeNotes(root, metadata) {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs/remote-version-policy.md"),
    "<!-- manual-migration-approved --><!-- contract-reviewed --><!-- real-install-not-performed -->",
  );
  const file = path.join(root, metadata.current.notesFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${metadata.current.releaseTag}\nInstallation ${metadata.current.packageVersion}\n<!-- manual-client-reinstall -->`,
  );
}

function writeVersions(root, version) {
  writeJson(path.join(root, "package.json"), { version });
  writeJson(path.join(root, "src-tauri/tauri.conf.json"), {
    version,
    bundle: {
      windows: { wix: { version: "4.0.21" } },
      macOS: { bundleVersion: "4.0.21", infoPlist: "Info.plist" },
    },
  });
  fs.writeFileSync(
    path.join(root, "src-tauri/Info.plist"),
    "<key>CFBundleShortVersionString</key>\n  <string>4.0.21</string>",
  );
  fs.writeFileSync(
    path.join(root, "src-tauri/Cargo.toml"),
    `[package]\nname = "cc-switch-remote"\nversion = "${version}"\n\n[lib]\n`,
  );
  fs.writeFileSync(
    path.join(root, "src-tauri/Cargo.lock"),
    `[[package]]\nname = "cc-switch-remote"\nversion = "${version}"\n`,
  );
}

function gitFixture(t) {
  const root = tempDir(t);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Release Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        `core.hooksPath=${path.join(root, "disabled-hooks")}`,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init");
  git("commit", "--allow-empty", "-m", "synthetic upstream baseline");
  const upstream = git("rev-parse", "HEAD");
  git(
    "tag",
    "-a",
    "fixture-upstream",
    "-m",
    "synthetic annotated official tag",
  );
  git(
    "update-ref",
    "refs/remotes/upstream/tags/v4.0.21",
    git("rev-parse", "fixture-upstream"),
  );
  git("commit", "--allow-empty", "-m", "synthetic legacy fork release");
  const previous = git("rev-parse", "HEAD");
  git("tag", "v4.1.0");
  git("commit", "--allow-empty", "-m", "synthetic new fork release");
  const head = git("rev-parse", "HEAD");
  const metadata = candidateMetadata();
  metadata.history = [
    {
      ...metadata.history.at(-1),
      upstreamCommit: upstream,
      releaseCommit: previous,
    },
  ];
  metadata.current.upstreamCommit = upstream;
  const legacyBoundary = {
    ...LEGACY_BOUNDARY,
    releases: structuredClone(metadata.history),
  };
  git("tag", metadata.current.releaseTag);
  git("update-ref", "refs/remotes/origin/main", head);
  writeNotes(root, metadata);
  const published = path.join(root, "published-tags.txt");
  fs.writeFileSync(published, "v4.1.0\nremote-helper-latest\n");
  const official = path.join(root, "official-release.json");
  const response = {
    tag_name: "v4.0.21",
    draft: false,
    prerelease: false,
    published_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/farion1231/cc-switch/releases/tag/v4.0.21",
  };
  writeJson(official, response);
  return {
    root,
    git,
    metadata,
    published,
    official,
    response,
    head,
    upstream,
    previous,
    legacyBoundary,
    verify: (m = metadata) =>
      verifyPublication(m, m.current.releaseTag, published, official, {
        root,
        eventCommit: head,
        legacyBoundary,
      }),
  };
}

test("public tag and installer semver derive from the same upstream/revision", (t) => {
  const root = tempDir(t);
  const metadata = candidateMetadata();
  writeVersions(root, "4.0.21-remote.1");
  writeNotes(root, metadata);
  assert.equal(publicVersion(metadata.current), "4.0.21 · Remote r1");
  assert.equal(
    resolveReleaseIdentity("remote-v4.0.21-r1", { metadata }).packageVersion,
    "4.0.21-remote.1",
  );
  assert.doesNotThrow(() => verifyBuildIdentity(metadata, root));
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    writeJson(path.join(root, file), { version: "4.1.0" });
    assert.throws(() => verifyBuildIdentity(metadata, root), /does not match/);
    writeJson(path.join(root, file), { version: "4.0.21-remote.1" });
  }
  fs.writeFileSync(
    path.join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "cc-switch-remote"\nversion = "4.1.0"\n\n[lib]\n',
  );
  assert.throws(
    () => verifyBuildIdentity(metadata, root),
    /Cargo.toml.*does not match/,
  );
  writeVersions(root, "4.0.21-remote.1");
  fs.writeFileSync(
    path.join(root, "src-tauri/Cargo.lock"),
    '[[package]]\nname = "cc-switch-remote"\nversion = "4.1.0"\n',
  );
  assert.throws(
    () => verifyBuildIdentity(metadata, root),
    /Cargo.lock.*does not match/,
  );
});

test("unready, pending contracts and an independently chosen installer version block publication", (t) => {
  const production = readReleaseMetadata();
  const root = tempDir(t);
  const metadata = candidateMetadata();
  writeNotes(root, metadata);
  metadata.current.releaseReady = false;
  assert.throws(
    () => verifyReleaseReadiness(metadata, root),
    /releaseReady=false/,
  );
  metadata.current.releaseReady = true;
  for (const key of ["futureUpdaterContract", "installerContract"]) {
    metadata.upgradeValidation[key] = "pending";
    assert.throws(
      () => verifyReleaseReadiness(metadata, root),
      /upgrade paths/,
    );
    metadata.upgradeValidation[key] = "contract-reviewed";
  }
  metadata.current.packageVersion = "4.1.0";
  assert.throws(
    () => verifyReleaseReadiness(metadata, root),
    /must be derived/,
  );
  assert.deepEqual(
    readReleaseMetadata(),
    production,
    "Synthetic verification flags must not alter production identity",
  );
});

test("invalid schema/repository/tag/baseline/history records fail closed", (t) => {
  const file = path.join(tempDir(t), "identity.json");
  const changes = [
    (m) => (m.schemaVersion = 99),
    (m) => (m.repository = "farion1231/cc-switch"),
    (m) => (m.current.releaseTag = "v4.2.0"),
    (m) => (m.current.remoteRevision = 0),
    (m) => (m.current.upstreamVersion = "4.0.21-beta.1"),
    (m) => (m.current.upstreamCommit = "bad-sha"),
    (m) => (m.current.upstreamCommit = "a".repeat(40)),
    (m) => (m.history[0].status = "unreleased"),
    (m) => m.history.push(structuredClone(m.history[0])),
    (m) => (m.current.notesFile = "docs/release-notes/v4.0.21-zh.md"),
  ];
  for (const change of changes) {
    const metadata = candidateMetadata();
    change(metadata);
    writeJson(file, metadata);
    assert.throws(() => readReleaseMetadata(file), Error);
  }
});

test("new-scheme revisions cannot skip, repeat, or roll back after first migration", (t) => {
  const root = tempDir(t);
  const metadata = candidateMetadata();
  metadata.history.push({
    ...metadata.current,
    status: "published",
    releaseCommit: "b".repeat(40),
  });
  Object.assign(metadata.current, {
    remoteRevision: 3,
    releaseTag: "remote-v4.0.21-r3",
    packageVersion: "4.0.21-remote.3",
  });
  assert.throws(
    () => verifyReleaseReadiness(metadata, root),
    /Expected Remote r2/,
  );
  Object.assign(metadata.current, {
    remoteRevision: 1,
    releaseTag: "remote-v4.0.4-r1",
    upstreamVersion: "4.0.4",
    packageVersion: "4.0.4-remote.1",
  });
  assert.throws(
    () => verifyReleaseReadiness(metadata, root),
    /strictly newer|cannot silently go backwards/,
  );
});

test("legacy and archived new releases never use the current installer version", () => {
  const metadata = candidateMetadata();
  assert.equal(
    resolveReleaseIdentity("v4.0.9", { metadata }).packageVersion,
    "4.0.9",
  );
  for (const tag of ["v3.16.2", "v4.1.0-beta.1", "v99.0.0"])
    assert.throws(
      () => resolveReleaseIdentity(tag, { metadata }),
      /No explicit legacy/,
    );
  assert.throws(
    () => resolveReleaseIdentity("remote-v4.0.40-r1", { metadata }),
    /No explicit/,
  );
  metadata.history.push({
    ...metadata.current,
    status: "published",
    releaseCommit: "b".repeat(40),
  });
  metadata.current = {
    ...metadata.current,
    packageVersion: "4.0.21-remote.2",
    remoteRevision: 2,
    releaseTag: "remote-v4.0.21-r2",
    releaseReady: false,
  };
  assert.equal(
    resolveReleaseIdentity("remote-v4.0.21-r1", { metadata }).packageVersion,
    "4.0.21-remote.1",
  );
});

test("installer semver orders Remote revisions numerically and preserves legacy downgrade truth", () => {
  assert.equal(comparePackageVersions("4.0.21-remote.1", "4.1.0"), -1);
  assert.equal(comparePackageVersions("4.0.21-remote.2", "4.0.21-remote.1"), 1);
  assert.equal(
    comparePackageVersions("4.0.21-remote.10", "4.0.21-remote.9"),
    1,
  );
  assert.equal(
    comparePackageVersions("4.0.40-remote.1", "4.0.21-remote.99"),
    1,
  );
  assert.equal(comparePackageVersions("4.1.0", "4.1.0+build"), 0);
  assert.equal(comparePackageVersions("4.1.0-beta.2", "4.1.0-beta.11"), -1);
  assert.throws(
    () => comparePackageVersions("remote-v4.0.21-r1", "4.1.0"),
    /Invalid installation/,
  );
});

test("publication verifies annotated official baseline, tag/head/main and history in a separate fixture repository", (t) => {
  const f = gitFixture(t);
  assert.doesNotThrow(() => f.verify());
  assert.throws(
    () =>
      verifyPublication(
        f.metadata,
        "remote-v4.0.21-r2",
        f.published,
        f.official,
        { root: f.root, eventCommit: f.head, legacyBoundary: f.legacyBoundary },
      ),
    /Pushed tag/,
  );
  assert.throws(
    () =>
      verifyPublication(
        f.metadata,
        f.metadata.current.releaseTag,
        f.published,
        f.official,
        {
          root: f.root,
          eventCommit: f.upstream,
          legacyBoundary: f.legacyBoundary,
        },
      ),
    /workflow event/,
  );
  f.git("update-ref", "refs/remotes/origin/main", f.previous);
  assert.throws(() => f.verify(), Error);
  f.git("update-ref", "refs/remotes/origin/main", f.head);
  f.git("tag", "-f", "v4.1.0", f.head);
  assert.throws(() => f.verify(), /Historical fork tag moved/);
});

test("official release must exist, be published stable, and belong to the official repository", (t) => {
  const f = gitFixture(t);
  for (const change of [
    { draft: true },
    { prerelease: true },
    { published_at: null },
    { tag_name: "v4.0.40" },
    {
      html_url:
        "https://github.com/PowerDi/cc-switch-remote/releases/tag/v4.0.21",
    },
  ]) {
    writeJson(f.official, { ...f.response, ...change });
    assert.throws(() => f.verify(), /official|Baseline/);
  }
  fs.unlinkSync(f.official);
  assert.throws(() => f.verify(), /ENOENT/);
});

test("a wrong baseline SHA is rejected even when it is an ancestor of the intended release", (t) => {
  const f = gitFixture(t);
  f.metadata.history.push({
    ...f.metadata.current,
    status: "published",
    releaseCommit: f.head,
  });
  f.metadata.current.upstreamVersion = "4.0.40";
  f.metadata.current.packageVersion = "4.0.40-remote.1";
  f.metadata.current.releaseTag = "remote-v4.0.40-r1";
  f.metadata.current.notesFile =
    "docs/release-notes/remote-v4.0.40-r1-remote-zh.md";
  writeNotes(f.root, f.metadata);
  f.git("tag", f.metadata.current.releaseTag);
  f.git("update-ref", "refs/remotes/upstream/tags/v4.0.40", f.previous);
  writeJson(f.official, {
    ...f.response,
    tag_name: "v4.0.40",
    html_url: "https://github.com/farion1231/cc-switch/releases/tag/v4.0.40",
  });
  assert.throws(() => f.verify(), /peeled official release tag/);
});

test("a freshly published newer installer blocks an older build from replacing latest", (t) => {
  const f = gitFixture(t);
  fs.appendFileSync(f.published, "v4.2.1\n");
  assert.throws(() => f.verify(), /No explicit legacy/);
  fs.writeFileSync(f.published, "v4.1.0\nremote-v4.0.21-r2\n");
  assert.throws(() => f.verify(), /No explicit release identity/);
  fs.writeFileSync(f.published, `v4.1.0\n${f.metadata.current.releaseTag}\n`);
  assert.throws(() => f.verify(), /already exists/);
});

test("actual inventory rejects unknown v3, unknown prereleases and incomplete legacy history", (t) => {
  const f = gitFixture(t);
  for (const tag of [
    "v3.99.0",
    "v99.0.0",
    "v4.1.0-beta.1",
    "remote-v4.0.21-r99",
  ]) {
    fs.writeFileSync(f.published, "v4.1.0\n" + tag + "\n");
    assert.throws(() => f.verify(), /No explicit/);
  }
  fs.writeFileSync(f.published, "remote-helper-latest\n");
  assert.throws(() => f.verify(), /missing historical release/);
});

test("legacy exemption is exact and new-scheme history can never reuse it", (t) => {
  const root = tempDir(t);
  const metadata = candidateMetadata();
  writeNotes(root, metadata);
  metadata.history[0].releaseCommit = "a".repeat(40);
  assert.throws(() => verifyReleaseReadiness(metadata, root), /exactly match/);
  const repeat = candidateMetadata();
  repeat.history.push({
    ...repeat.current,
    status: "published",
    releaseCommit: "b".repeat(40),
  });
  assert.throws(
    () => verifyReleaseReadiness(repeat, root),
    /already been published/,
  );
  const unauthorized = candidateMetadata();
  unauthorized.history.push({
    ...unauthorized.history[0],
    releaseTag: "v99.0.0",
    packageVersion: "99.0.0",
  });
  assert.throws(
    () => verifyReleaseReadiness(unauthorized, root),
    /exactly match/,
  );
});

test("real-install evidence can be recorded later but never inferred from readiness", (t) => {
  const root = tempDir(t);
  const metadata = candidateMetadata();
  writeNotes(root, metadata);
  metadata.upgradeValidation.realInstallValidation = "verified-with-evidence";
  assert.throws(
    () => verifyReleaseReadiness(metadata, root),
    /explicit evidence/,
  );
  metadata.upgradeValidation.realInstallEvidence =
    "docs/installed-validation.md";
  assert.throws(() => verifyReleaseReadiness(metadata, root), /ENOENT/);
  fs.writeFileSync(
    path.join(root, metadata.upgradeValidation.realInstallEvidence),
    metadata.current.releaseTag +
      "\n" +
      metadata.current.packageVersion +
      "\n<!-- real-install-verified-with-evidence -->",
  );
  fs.appendFileSync(
    path.join(root, metadata.migration.evidenceFile),
    "<!-- real-install-verified-with-evidence -->",
  );
  assert.doesNotThrow(() => verifyReleaseReadiness(metadata, root));
});

test("Windows-compatible CLI entrypoint actually runs without publishing or changing refs", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/release-identity.mjs")],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const expected = readReleaseMetadata().current;
  const actual = JSON.parse(output);
  assert.equal(actual["release-ready"], String(expected.releaseReady));
  assert.equal(actual["release-tag"], expected.releaseTag);
  assert.equal(actual["package-version"], expected.packageVersion);
});

test("fixture cleanup removes read-only nested files and refuses the real repository", (t) => {
  const root = tempDir(t);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  const file = path.join(nested, "fixture");
  fs.writeFileSync(file, "synthetic");
  fs.chmodSync(file, 0o444);
  removeFixture(root);
  assert.equal(fs.existsSync(root), false);
  assert.throws(() => removeFixture(REPO_ROOT), /inside .validation/);
});
