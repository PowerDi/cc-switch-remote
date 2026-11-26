import assert from "node:assert/strict";
import test from "node:test";
import { read, workflow, step } from "./test-support/release-fixtures.mjs";

const recovery = workflow("recover-r1-artifacts.yml");
const job = recovery.jobs.recover;
const code = read("scripts/recover-r1-artifacts.py");

test("r1 recovery is manual only and pins original source without any build/test commands", () => {
  assert.deepEqual(Object.keys(recovery.on), ["workflow_dispatch"]);
  assert.equal(
    recovery.on.workflow_dispatch.inputs.source_sha.default,
    "c0b701e44bf89fb1d264236949a3af2745af1989",
  );
  assert.equal(
    recovery.on.workflow_dispatch.inputs.tag.default,
    "remote-v4.0.21-r1",
  );
  assert.equal(
    step(job, "Checkout immutable original release source").with.ref,
    "c0b701e44bf89fb1d264236949a3af2745af1989",
  );
  assert.equal(
    step(job, "Checkout reviewed recovery tooling").with.ref,
    "${{ github.sha }}",
  );
  for (const item of job.steps)
    assert.doesNotMatch(
      item.run ?? "",
      /cargo |pnpm |vitest|unittest|tauri build|git (?:push|tag)/,
    );
  assert.equal(job.environment, "release");
  assert.equal(job.permissions.contents, "write");
  assert.equal(job.permissions.actions, "read");
});

test("desktop and helper use distinct publication locks also shared with normal workflows", () => {
  assert.match(job.concurrency.group, /remote-app-publication/);
  assert.match(job.concurrency.group, /remote-helper-publication/);
  assert.equal(job.concurrency["cancel-in-progress"], false);
  assert.equal(
    workflow("release.yml").jobs["publish-release"].concurrency.group,
    "remote-app-publication",
  );
  assert.equal(
    workflow("helper-artifacts.yml").jobs["publish-helper-release"].concurrency
      .group,
    "remote-helper-publication",
  );
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(recovery.on.workflow_dispatch.inputs.operation.options, [
    "desktop",
    "helper",
    "all",
  ]);
});

test("durable backup upload gates apply, and failure evidence is retained", () => {
  const prepare = step(
    job,
    "Validate provenance and prepare artifacts without mutation",
  );
  const backup = step(
    job,
    "Preserve evidence and helper rollback bytes before any mutation",
  );
  const apply = step(job, "Apply verified release transaction");
  assert.ok(job.steps.indexOf(prepare) < job.steps.indexOf(backup));
  assert.ok(job.steps.indexOf(backup) < job.steps.indexOf(apply));
  assert.match(prepare.run, / prepare /);
  assert.match(apply.run, / apply /);
  assert.match(backup.with.path, /recovery\/backup\/\*\*/);
  assert.equal(backup["continue-on-error"], undefined);
  assert.equal(apply.if, undefined); // Normal success gating, not always().
  assert.equal(
    apply.env.RECOVERY_BACKUP_ARTIFACT_ID,
    "${{ steps.backup.outputs.artifact-id }}",
  );
  assert.equal(
    apply.env.RECOVERY_BACKUP_ARTIFACT_DIGEST,
    "${{ steps.backup.outputs.artifact-digest }}",
  );
  assert.equal(job.steps.at(-1).if, "always()");
  assert.match(code, /Recovery backup upload digest mismatch/);
});

test("allowlisted r1 run inputs and source tag checks prevent arbitrary external artifact promotion", () => {
  const inputs = recovery.on.workflow_dispatch.inputs;
  for (const [name, id] of Object.entries({
    desktop_original: "45752512886",
    helper_original: "45752621175",
  })) {
    assert.equal(inputs[name].default, id);
    assert.ok(code.includes(id));
  }
  assert.match(code, /Unapproved artifact run input/);
  assert.match(code, /Foreign run repository/);
  assert.equal(inputs.desktop_macos, undefined);
  assert.equal(inputs.helper_macos, undefined);
  assert.match(
    code,
    /REQUIRED_PLATFORMS = "windows-x86_64,linux-x86_64,linux-aarch64"/,
  );
  assert.match(code, /exactly 13 assets/);
  assert.match(code, /Need three real artifact/);
  assert.doesNotMatch(code, /45755465267|45755471545/);
  assert.match(code, /Desktop release tag moved/);
  assert.match(code, /merge-base", "--is-ancestor", SOURCE/);
  assert.match(code, /scripts\/release-identity\.mjs", "--publish"/);
  assert.match(code, /scripts\/assemble-tauri-latest-json\.mjs/);
  assert.doesNotMatch(code, /git", "tag|git", "push/);
  assert.match(code, /git\/refs\/tags\/\{HELPER_TAG\}/);
});
