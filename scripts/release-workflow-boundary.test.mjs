import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './release-identity.mjs';
import { read, workflow, step } from './test-support/release-fixtures.mjs';

const release = workflow('release.yml');
const publish = release.jobs['publish-release'];
const invokeIdentity = (...args) =>
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/release-identity.mjs'), ...args],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

test('publication requires exact tag-specific fork notes with no fallback', () => {
  const prepare = step(publish, 'Prepare Release Notes').run;
  assert.match(
    prepare,
    /test "\$NOTES_FILE" = "docs\/release-notes\/\$\{TAG\}-remote-zh\.md"/,
  );
  assert.match(prepare, /--require-fork-notes --notes-file "\$NOTES_FILE"/);
  assert.match(prepare, /cp "\$NOTES_FILE" release-body\.md/);
  assert.doesNotMatch(
    prepare,
    /\belse\b|cat\s*>|\$\{TAG\}-zh\.md|\$\{TAG\}\.md/,
  );
  assert.doesNotThrow(() =>
    invokeIdentity(
      '--resolve-only',
      '--tag',
      'v4.1.0',
      '--require-fork-notes',
      '--notes-file',
      'docs/release-notes/v4.1.0-remote-zh.md',
    ),
  );
  for (const notes of [
    'docs/release-notes/v4.0.21-zh.md',
    'docs/release-notes/v4.0.9-remote-zh.md',
    '../v4.1.0-remote-zh.md',
  ]) {
    assert.throws(
      () =>
        invokeIdentity(
          '--resolve-only',
          '--tag',
          'v4.1.0',
          '--require-fork-notes',
          '--notes-file',
          notes,
        ),
      /Refusing unrelated\/upstream/,
    );
  }
});

test('only new public tags auto-publish and manual dispatch never publishes', () => {
  assert.deepEqual(release.on.push.tags, ['remote-v*-r*']);
  assert.ok(release.on.workflow_dispatch);
  assert.deepEqual(publish.needs, ['identity', 'release']);
  assert.equal(
    publish.if,
    "github.event_name == 'push' && needs.identity.outputs.release-ready == 'true'",
  );
  for (const [id, job] of Object.entries(release.jobs)) {
    for (const item of job.steps) {
      if (
        item.uses?.startsWith('softprops/action-gh-release') ||
        /gh release (?:create|edit|upload)/.test(item.run ?? '')
      )
        assert.equal(id, 'publish-release');
    }
  }
  assert.equal(step(publish, 'Upload Release Assets').with.prerelease, false);
  assert.equal(
    step(publish, 'Upload Release Assets').with.name,
    'CC Switch Remote ${{ needs.identity.outputs.display-version }}',
  );
});

test('publication rechecks actual releases under a cross-tag lock immediately before upload', () => {
  assert.deepEqual(publish.concurrency, {
    group: 'remote-app-publication',
    'cancel-in-progress': false,
  });
  const names = publish.steps.map((item) => item.name);
  assert.equal(names.at(-2), 'Revalidate immediately before publishing');
  assert.equal(names.at(-1), 'Upload Release Assets');
  for (const item of [
    step(release.jobs.identity, 'Validate build or new public tag'),
    step(publish, 'Revalidate immediately before publishing'),
  ]) {
    assert.match(
      item.run,
      /gh api --paginate "repos\/\$GITHUB_REPOSITORY\/releases"/,
    );
    assert.match(
      item.run,
      /select\(\.draft == false\)/,
    );
    assert.match(item.run, /--publish --tag/);
    assert.match(
      item.run,
      /--published-tags-file published-tags\.txt --upstream-release-file upstream-release\.json/,
    );
    assert.match(
      item.run,
      /git fetch --no-tags https:\/\/github\.com\/farion1231\/cc-switch\.git/,
    );
    assert.match(
      item.run,
      /refs\/tags\/\$UPSTREAM_TAG:refs\/remotes\/upstream\/tags\/\$UPSTREAM_TAG/,
    );
  }
  assert.equal(release.jobs.release.needs, 'identity');
});

test('all signed platform metadata is checked before release mutation', () => {
  const names = publish.steps.map((item) => item.name);
  assert.ok(
    names.indexOf('Validate updater metadata before creating a release') <
      names.indexOf('Upload Release Assets'),
  );
  const check = step(
    publish,
    'Validate updater metadata before creating a release',
  ).run;
  assert.match(check, /assemble-tauri-latest-json\.mjs/);
  assert.match(check, /--tag "\$RELEASE_TAG" --notes-file release-body\.md/);
  assert.match(check, /verify-tauri-updater-signatures\.mjs/);
  assert.match(
    check,
    /cp release-identity\.json release-assets\/release-identity\.json/,
  );
});

test('maintenance uses the requested release snapshot, publication date and notes', () => {
  const job = workflow('release-maintenance.yml').jobs['maintain-release'];
  const resolve = step(
    job,
    'Resolve the requested release, not the current build version',
  ).run;
  assert.match(resolve, /if \[\[ "\$TAG" == remote-v\* \]\]; then/);
  assert.match(
    resolve,
    /gh release download "\$TAG".*--pattern release-identity\.json/,
  );
  assert.match(
    resolve,
    /cp identity\/release-identity\.json requested-identity\.json/,
  );
  const generate = step(job, 'Generate latest.json').run;
  assert.match(generate, /--identity-file requested-identity\.json/);
  assert.match(generate, /--existing-latest-json existing\/latest\.json/);
  assert.match(step(job, 'Preserve existing updater platform set').run, /gh release download.*--pattern latest\.json/);
  assert.match(generate, /--notes-file requested-notes\.md/);
  assert.match(generate, /PUB_DATE=\$\(<published-at\.txt\)/);
  assert.match(generate, /--tag "\$TAG"/);
  assert.doesNotMatch(
    step(job, 'Sign Windows MSI if needed').run,
    /gh release upload/,
  );
  assert.equal(job.steps.at(-1).name, 'Upload validated maintenance assets');
});

test('release-note sync touches only matching fork notes on existing releases', () => {
  const sync = workflow('sync-release-notes.yml');
  assert.ok(sync.on.push.paths.includes('docs/release-notes/*-remote-zh.md'));
  assert.ok(!sync.on.push.paths.includes('docs/release-notes/*.md'));
  const run = step(sync.jobs['sync-release-notes'], 'Sync release notes').run;
  assert.match(run, /-- 'docs\/release-notes\/\*-remote-zh\.md'/);
  assert.match(run, /\$\{INPUT_TAG\}-remote-zh\.md/);
  assert.match(run, /tag="\$\{base%-remote-zh\}"/);
  assert.ok(
    run.indexOf('gh release view "$tag"') <
      run.indexOf('gh release edit "$tag"'),
  );
  assert.match(run, /--require-fork-notes --notes-file "\$file"/);
});

test('identity-only changes trigger production identity and frontend CI checks', () => {
  const ci = workflow('ci.yml');
  const filters = step(ci.jobs.changes, 'Detect changed paths').with.filters;
  assert.match(filters, /"release-identity\.json"/);
  assert.match(filters, /"scripts\/\*\*"/);
  assert.equal(
    step(ci.jobs.frontend, 'Verify fork release identity').run,
    'node scripts/release-identity.mjs',
  );
});

test('Windows title and tray tooltip preserve fork identity', () => {
  assert.equal(
    JSON.parse(read('src-tauri/tauri.windows.conf.json')).app.windows[0].title,
    'CC Switch Remote',
  );
  assert.match(read('src-tauri/src/lib.rs'), /\.tooltip\("CC Switch Remote"\)/);
  assert.doesNotMatch(read('src-tauri/src/lib.rs'), /\.tooltip\("CC Switch"\)/);
});
