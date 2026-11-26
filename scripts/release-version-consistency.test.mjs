import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readReleaseMetadata,
  verifyBuildIdentity,
} from './release-identity.mjs';

test('four installer versions follow machine-readable identity, not public tag numbering', () => {
  const metadata = readReleaseMetadata();
  assert.doesNotThrow(() => verifyBuildIdentity(metadata));
  assert.equal(
    metadata.current.releaseTag,
    `remote-v${metadata.current.upstreamVersion}-r${metadata.current.remoteRevision}`,
  );
  assert.notEqual(
    metadata.current.releaseTag,
    `v${metadata.current.packageVersion}`,
  );
});

test('a reused installer version cannot be marked ready, and ready identities require verified upgrade paths', () => {
  const metadata = readReleaseMetadata();
  if (
    metadata.history.some(
      (record) => record.packageVersion === metadata.current.packageVersion,
    )
  )
    assert.equal(metadata.current.releaseReady, false);
  if (metadata.current.releaseReady)
    assert.ok(
      Object.values(metadata.upgradeValidation).every(
        (status) => status === 'verified',
      ),
    );
  assert.equal(metadata.migration.decision, 'manual-portable-migration');
});
