import assert from "node:assert/strict";
import test from "node:test";
import {
  readReleaseMetadata,
  verifyBuildIdentity,
} from "./release-identity.mjs";

test("four installer versions follow machine-readable identity, not public tag numbering", () => {
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

test("derived versions and explicit migration contracts remain release gates", () => {
  const metadata = readReleaseMetadata();
  if (
    metadata.history.some(
      (record) => record.packageVersion === metadata.current.packageVersion,
    )
  )
    assert.equal(metadata.current.releaseReady, false);
  if (metadata.current.releaseReady)
    assert.ok(
      metadata.upgradeValidation.installerContract === "contract-reviewed" &&
        metadata.upgradeValidation.futureUpdaterContract ===
          "contract-reviewed",
    );
  assert.equal(metadata.migration.decision, "manual-client-reinstall");
  assert.equal(
    metadata.current.packageVersion,
    `${metadata.current.upstreamVersion}-remote.${metadata.current.remoteRevision}`,
  );
  assert.equal(
    metadata.upgradeValidation.realInstallValidation,
    "not-performed",
  );
});
