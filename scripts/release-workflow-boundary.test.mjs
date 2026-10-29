import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/release.yml'),
  'utf8',
);

test('release body uses only an explicitly fork-owned note or the fork fallback', () => {
  const prepareStep = releaseWorkflow.match(
    /- name: Prepare Release Notes[\s\S]*?(?=\n\s+- name:)/,
  )?.[0];

  assert.ok(prepareStep, 'Prepare Release Notes step must exist');
  assert.match(prepareStep, /docs\/release-notes\/\$\{TAG\}-remote-zh\.md/);
  assert.doesNotMatch(prepareStep, /docs\/release-notes\/\$\{TAG\}\.md/);
  assert.doesNotMatch(prepareStep, /docs\/release-notes\/\$\{TAG\}-zh\.md/);
  assert.match(prepareStep, /## CC Switch Remote \$\{TAG\}/);
});

test('release-note sync only touches fork releases from fork-owned notes', () => {
  // v4.1.0 incident: pushing the v4.0.21 merge to main made this workflow sync
  // upstream's v4.0.5-v4.0.9 notes onto the fork releases with the same tags.
  const syncWorkflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/sync-release-notes.yml'),
    'utf8',
  );
  assert.match(syncWorkflow, /- "docs\/release-notes\/\*-remote-zh\.md"/);
  assert.doesNotMatch(syncWorkflow, /- "docs\/release-notes\/\*\.md"/);
  assert.match(syncWorkflow, /-- 'docs\/release-notes\/\*-remote-zh\.md'/);
  assert.doesNotMatch(syncWorkflow, /-- 'docs\/release-notes\/\*\.md'/);
  assert.match(syncWorkflow, /\$\{INPUT_TAG\}-remote-zh\.md/);
  assert.match(syncWorkflow, /tag="\$\{base%-remote-zh\}"/);
});

test('Windows title and tray tooltip preserve the fork product identity', () => {
  const windowsConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.windows.conf.json'), 'utf8'),
  );
  const rustApp = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8');

  assert.equal(windowsConfig.app.windows[0].title, 'CC Switch Remote');
  assert.match(rustApp, /\.tooltip\("CC Switch Remote"\)/);
  assert.doesNotMatch(rustApp, /\.tooltip\("CC Switch"\)/);
});
