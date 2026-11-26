import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { assembleLatestJson } from './assemble-tauri-latest-json.mjs';
import { REPO_ROOT } from './release-identity.mjs';
import {
  candidateMetadata,
  frozenMetadata,
  removeFixture,
  writeJson,
} from './test-support/release-fixtures.mjs';

const dirs = [];
after(() => dirs.forEach(removeFixture));

function makeAssets(files) {
  const base = path.join(REPO_ROOT, '.validation', 'updater-assets');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'release-'));
  dirs.push(dir);
  writeJson(path.join(dir, 'frozen-identity.json'), frozenMetadata());
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('assembles signed updater metadata for all supported platforms', () => {
  const dir = makeAssets({
    'CC-Switch-Remote-v4.0.5-macOS.tar.gz': 'mac',
    'CC-Switch-Remote-v4.0.5-macOS.tar.gz.sig': 'mac-sig',
    'CC-Switch-Remote-v4.0.5-Linux-x86_64.AppImage': 'linux-x64',
    'CC-Switch-Remote-v4.0.5-Linux-x86_64.AppImage.sig': 'linux-x64-sig',
    'CC-Switch-Remote-v4.0.5-Linux-arm64.AppImage': 'linux-arm64',
    'CC-Switch-Remote-v4.0.5-Linux-arm64.AppImage.sig': 'linux-arm64-sig',
    'CC-Switch-Remote-v4.0.5-Windows.msi': 'windows',
    'CC-Switch-Remote-v4.0.5-Windows.msi.sig': 'windows-sig',
  });

  const latest = assembleLatestJson({
    assetsDir: dir,
    identityFile: path.join(dir, 'frozen-identity.json'),
    repo: 'PowerDi/cc-switch-remote',
    tag: 'v4.0.5',
    pubDate: '2026-06-04T00:00:00Z',
  });

  assert.equal(latest.version, '4.0.5');
  assert.equal(latest.platforms['darwin-aarch64'].signature, 'mac-sig');
  assert.equal(latest.platforms['darwin-x86_64'].signature, 'mac-sig');
  assert.equal(latest.platforms['linux-x86_64'].signature, 'linux-x64-sig');
  assert.equal(latest.platforms['linux-aarch64'].signature, 'linux-arm64-sig');
  assert.equal(latest.platforms['windows-x86_64'].signature, 'windows-sig');
});

test('fails when an updater artifact is missing its signature', () => {
  const dir = makeAssets({
    'CC-Switch-Remote-v4.0.5-Windows.msi': 'windows',
  });

  assert.throws(
    () =>
      assembleLatestJson({
        assetsDir: dir,
        identityFile: path.join(dir, 'frozen-identity.json'),
        repo: 'PowerDi/cc-switch-remote',
        tag: 'v4.0.5',
        requiredPlatforms: ['windows-x86_64'],
      }),
    /missing \.sig files.*Windows\.msi/,
  );
});

test('uses an asset names file so metadata repair does not download large artifacts', () => {
  const dir = makeAssets({
    'CC-Switch-Remote-v4.0.5-macOS.tar.gz.sig': 'mac-sig',
    'CC-Switch-Remote-v4.0.5-Linux-x86_64.AppImage.sig': 'linux-x64-sig',
    'CC-Switch-Remote-v4.0.5-Linux-arm64.AppImage.sig': 'linux-arm64-sig',
    'CC-Switch-Remote-v4.0.5-Windows.msi.sig': 'windows-sig',
  });
  const assetNamesFile = path.join(dir, 'asset-names.txt');
  fs.writeFileSync(
    assetNamesFile,
    [
      'CC-Switch-Remote-v4.0.5-macOS.tar.gz',
      'CC-Switch-Remote-v4.0.5-macOS.tar.gz.sig',
      'CC-Switch-Remote-v4.0.5-Linux-x86_64.AppImage',
      'CC-Switch-Remote-v4.0.5-Linux-x86_64.AppImage.sig',
      'CC-Switch-Remote-v4.0.5-Linux-arm64.AppImage',
      'CC-Switch-Remote-v4.0.5-Linux-arm64.AppImage.sig',
      'CC-Switch-Remote-v4.0.5-Windows.msi',
      'CC-Switch-Remote-v4.0.5-Windows.msi.sig',
    ].join('\n'),
  );

  const latest = assembleLatestJson({
    assetsDir: dir,
    identityFile: path.join(dir, 'frozen-identity.json'),
    assetNamesFile,
    repo: 'PowerDi/cc-switch-remote',
    tag: 'v4.0.5',
  });

  assert.equal(latest.platforms['windows-x86_64'].signature, 'windows-sig');
  assert.equal(latest.platforms['linux-aarch64'].signature, 'linux-arm64-sig');
});

const newTag = 'remote-v4.0.21-r1';
function newAssets(extra = {}) {
  const name = 'CC-Switch-Remote-' + newTag + '-Windows.msi';
  const assetsDir = makeAssets({
    [name]: 'synthetic installer',
    [name + '.sig']: 'synthetic signature fixture',
    ...extra,
  });
  const identityFile = writeJson(
    path.join(assetsDir, 'identity.json'),
    candidateMetadata(),
  );
  return {
    assetsDir,
    identityFile,
    repo: 'PowerDi/cc-switch-remote',
    tag: newTag,
    requiredPlatforms: ['windows-x86_64'],
  };
}

test('new release default requires only Windows and two Linux updater platforms', () => {
  const options = newAssets(Object.fromEntries(['x86_64', 'arm64'].flatMap(arch => [
    ['CC-Switch-Remote-' + newTag + '-Linux-' + arch + '.AppImage', 'binary'],
    ['CC-Switch-Remote-' + newTag + '-Linux-' + arch + '.AppImage.sig', 'signature'],
  ])));
  delete options.requiredPlatforms;
  assert.deepEqual(Object.keys(assembleLatestJson(options).platforms).sort(), ['linux-aarch64', 'linux-x86_64', 'windows-x86_64']);
});

test('new-scheme releases reject unexpected macOS assets even with signatures', () => {
  const options = newAssets({
    ['CC-Switch-Remote-' + newTag + '-macOS.tar.gz']: 'unexpected mac',
    ['CC-Switch-Remote-' + newTag + '-macOS.tar.gz.sig']: 'signature',
  });
  assert.throws(() => assembleLatestJson(options), /macOS artifacts are not permitted/);
  const existingLatestJson = writeJson(path.join(options.assetsDir, 'existing.json'), { version: '4.0.21-remote.1', platforms: { 'windows-x86_64': {} } });
  assert.throws(() => assembleLatestJson({ ...options, existingLatestJson }), /absent historical platform/);
});

test('maintenance cannot silently remove an existing historical macOS platform', () => {
  const options = newAssets();
  const existingLatestJson = writeJson(path.join(options.assetsDir, 'existing.json'), { version: '4.0.21-remote.1', platforms: { 'windows-x86_64': {}, 'darwin-aarch64': {}, 'darwin-x86_64': {} } });
  assert.throws(() => assembleLatestJson({ ...options, existingLatestJson }), /missing required platforms: darwin/);
  fs.writeFileSync(path.join(options.assetsDir, 'CC-Switch-Remote-' + newTag + '-macOS.tar.gz'), 'legacy mac');
  fs.writeFileSync(path.join(options.assetsDir, 'CC-Switch-Remote-' + newTag + '-macOS.tar.gz.sig'), 'legacy sig');
  const latest = assembleLatestJson({ ...options, existingLatestJson });
  assert.equal(latest.platforms['darwin-aarch64'].signature, 'legacy sig');
  assert.equal(latest.platforms['darwin-x86_64'].signature, 'legacy sig');
});

test('new tag metadata uses explicit installer semver and actual tag URLs', () => {
  const options = newAssets();
  const latest = assembleLatestJson(options);
  assert.equal(latest.version, '4.0.21-remote.1');
  assert.equal(latest.releaseIdentity.releaseTag, newTag);
  assert.equal(latest.releaseIdentity.upstreamVersion, '4.0.21');
  assert.equal(
    latest.platforms['windows-x86_64'].url,
    'https://github.com/PowerDi/cc-switch-remote/releases/download/' +
      newTag +
      '/CC-Switch-Remote-' +
      newTag +
      '-Windows.msi',
  );
});

test('legacy maintenance derives version from the historical tag, not current packageVersion', () => {
  const name = 'CC-Switch-v4.0.9-Windows.msi';
  const assetsDir = makeAssets({
    [name]: 'legacy',
    [name + '.sig']: 'signature',
  });
  const latest = assembleLatestJson({
    assetsDir,
    identityFile: path.join(assetsDir, 'frozen-identity.json'),
    repo: 'PowerDi/cc-switch-remote',
    tag: 'v4.0.9',
    requiredPlatforms: ['windows-x86_64'],
  });
  assert.equal(frozenMetadata().current.packageVersion, '4.1.0');
  assert.equal(latest.version, '4.0.9');
  assert.ok(latest.platforms['windows-x86_64'].url.endsWith('/v4.0.9/' + name));
});

test('archived new-naming release retains its own installation version', () => {
  const options = newAssets();
  const metadata = candidateMetadata();
  metadata.history.push({
    ...metadata.current,
    status: 'published',
    releaseCommit: 'b'.repeat(40),
  });
  metadata.current = {
    ...metadata.current,
    packageVersion: '4.0.21-remote.2',
    remoteRevision: 2,
    releaseTag: 'remote-v4.0.21-r2',
    notesFile: 'docs/release-notes/remote-v4.0.21-r2-remote-zh.md',
    releaseReady: false,
  };
  writeJson(options.identityFile, metadata);
  assert.equal(assembleLatestJson(options).version, '4.0.21-remote.1');
});

test('unready and unmapped future tags cannot produce updater metadata', () => {
  const options = newAssets();
  assert.throws(
    () =>
      assembleLatestJson({
        ...options,
        identityFile: path.join(options.assetsDir, 'frozen-identity.json'),
      }),
    /not release-ready|Schema 1 modern identities/,
  );
  assert.throws(
    () => assembleLatestJson({ ...options, tag: 'remote-v4.0.40-r1' }),
    /No explicit/,
  );
});

test('wrong fork repository, wrong tag and wrong branding artifacts are rejected', () => {
  const options = newAssets();
  assert.throws(
    () => assembleLatestJson({ ...options, repo: 'farion1231/cc-switch' }),
    /repository does not match/,
  );
  for (const name of [
    'CC-Switch-Remote-remote-v4.0.40-r1-Windows.msi',
    'CC-Switch-' + newTag + '-Windows.msi',
  ]) {
    const assetsDir = makeAssets({
      [name]: 'wrong release',
      [name + '.sig']: 'signature',
    });
    assert.throws(
      () => assembleLatestJson({ ...options, assetsDir }),
      /does not belong/,
    );
  }
});

test('duplicate updater platform and unsigned new-naming artifact are rejected', () => {
  const options = newAssets({
    ['CC-Switch-Remote-' + newTag + '-macOS.tar.gz']: 'mac',
    ['CC-Switch-Remote-' + newTag + '-macOS.tar.gz.sig']: 'sig',
    ['CC-Switch-Remote-' + newTag + '-macOS-extra.tar.gz']: 'duplicate',
    ['CC-Switch-Remote-' + newTag + '-macOS-extra.tar.gz.sig']: 'sig',
  });
  const existingLatestJson = writeJson(path.join(options.assetsDir, 'existing.json'), { version: '4.0.21-remote.1', platforms: { 'windows-x86_64': {}, 'darwin-aarch64': {}, 'darwin-x86_64': {} } });
  assert.throws(
    () => assembleLatestJson({ ...options, existingLatestJson }),
    /Multiple updater artifacts for darwin/,
  );
  const unsigned = newAssets();
  fs.unlinkSync(
    path.join(
      unsigned.assetsDir,
      'CC-Switch-Remote-' + newTag + '-Windows.msi.sig',
    ),
  );
  assert.throws(() => assembleLatestJson(unsigned), /missing \.sig files/);
});

test('CLI runs on an absolute Windows/Unicode path and uses supplied snapshot and notes', () => {
  const options = newAssets();
  const output = path.join(options.assetsDir, 'latest.json');
  const notes = path.join(options.assetsDir, 'notes.md');
  fs.writeFileSync(notes, 'Fork-only release notes');
  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts/assemble-tauri-latest-json.mjs'),
      '--repo',
      options.repo,
      '--tag',
      options.tag,
      '--identity-file',
      options.identityFile,
      '--assets-dir',
      options.assetsDir,
      '--required-platforms',
      'windows-x86_64',
      '--notes-file',
      notes,
      '--output',
      output,
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const latest = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(latest.version, '4.0.21-remote.1');
  assert.equal(latest.notes, 'Fork-only release notes');
});
