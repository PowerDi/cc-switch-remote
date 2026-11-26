import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  tempDir,
  candidateMetadata,
  workflow,
  step,
} from "./test-support/release-fixtures.mjs";
import { verifyLinuxPackageVersions } from "./verify-linux-package-versions.mjs";

function fixture(t, overrides = {}) {
  const bundleDir = tempDir(t);
  fs.writeFileSync(path.join(bundleDir, "fixture package.rpm"), "synthetic");
  fs.writeFileSync(path.join(bundleDir, "fixture package.deb"), "synthetic");
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "rpm" && args[0] === "-qp")
      return `cc-switch-remote\n${overrides.rpmVersion ?? "4.0.21-remote.1"}\n1\nx86_64`;
    if (command === "dpkg-deb")
      return overrides.debVersion ?? "4.0.21-remote.1";
    if (command === "rpm")
      return overrides.compare ?? (args[1].includes('"4.1.0"') ? "-1" : "1");
    if (command === "dpkg") return "";
    throw new Error("Unexpected executable");
  };
  return { bundleDir, run, calls, metadata: candidateMetadata() };
}
test("Linux native gate queries built metadata and compares without any installation", (t) => {
  const f = fixture(t);
  const result = verifyLinuxPackageVersions(f);
  assert.equal(result.installationPerformed, false);
  assert.equal(result.nativeComparisons, 4);
  assert.equal(result.rpm.version, "4.0.21-remote.1");
  assert.equal(f.calls.length, 10);
  assert.ok(
    f.calls.every(
      ([cmd, args]) =>
        cmd === "dpkg-deb" ||
        (cmd === "dpkg" && args[0] === "--compare-versions") ||
        (cmd === "rpm" && ["-qp", "--eval"].includes(args[0])),
    ),
  );
});
for (const [field, error] of [
  ["rpmVersion", /RPM Version/],
  ["debVersion", /Deb Version/],
  ["compare", /RPM comparator mismatch/],
]) {
  test(`Linux native gate fails closed on ${field}`, (t) =>
    assert.throws(
      () =>
        verifyLinuxPackageVersions(
          fixture(t, { [field]: field === "compare" ? "0" : "4.1.0" }),
        ),
      error,
    ));
}
test("Linux native artifact gate runs immediately after build for dispatch and tag builds", () => {
  const jobs = workflow("release.yml").jobs;
  const job = Object.values(jobs).find((job) =>
    job.steps?.some((item) => item.name === "Build Tauri App (Linux)"),
  );
  const build = step(job, "Build Tauri App (Linux)");
  const gate = step(
    job,
    "Validate native Linux package versions (no installation)",
  );
  assert.equal(gate.if, "runner.os == 'Linux'");
  assert.match(
    gate.run,
    /node scripts\/verify-linux-package-versions.mjs --bundle-dir src-tauri\/target\/release\/bundle/,
  );
  assert.ok(job.steps.indexOf(gate) > job.steps.indexOf(build));
  assert.ok(
    job.steps.indexOf(gate) <
      job.steps.indexOf(step(job, "Prepare Linux Assets")),
  );
});
