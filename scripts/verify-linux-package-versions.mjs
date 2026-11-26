#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  readReleaseMetadata,
  derivedPackageVersion,
} from "./release-identity.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
const execute = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Query artifacts and native comparators only. Never installs packages or writes system DBs. */
export function verifyLinuxPackageVersions({
  bundleDir,
  metadata = readReleaseMetadata(),
  run = execute,
}) {
  const current = metadata.current;
  const version = derivedPackageVersion(current);
  assert(
    version === current.packageVersion,
    "Derived application version mismatch",
  );
  assert(
    /^\d+\.\d+\.\d+-remote\.[1-9]\d*$/.test(version),
    "Invalid version for native comparator",
  );
  const files = filesUnder(bundleDir);
  const artifact = (extension) => {
    const matches = files.filter((file) => file.endsWith(extension));
    assert(
      matches.length === 1,
      `Expected exactly one ${extension} package, got ${matches.length}`,
    );
    return matches[0];
  };
  const rpmFile = artifact(".rpm");
  const debFile = artifact(".deb");
  const rpm = run("rpm", [
    "-qp",
    "--qf",
    "%{NAME}\n%{VERSION}\n%{RELEASE}\n%{ARCH}",
    rpmFile,
  ]).split(/\r?\n/);
  const deb = run("dpkg-deb", ["-f", debFile, "Version"]).trim();
  assert(
    rpm.length === 4 && rpm.every(Boolean),
    "Incomplete RPM package metadata",
  );
  assert(rpm[1] === version, `RPM Version ${rpm[1]} != application ${version}`);
  assert(deb === version, `Deb Version ${deb} != application ${version}`);
  const next = `${current.upstreamVersion}-remote.${current.remoteRevision + 1}`;
  const [major, minor, patch] = current.upstreamVersion.split(".").map(Number);
  const nextBaseline = `${major}.${minor}.${patch + 1}-remote.1`;
  const comparisons = [
    [next, version, 1],
    [nextBaseline, next, 1],
    ["4.0.40-remote.1", "4.0.21-remote.99", 1],
    ["4.0.21-remote.1", "4.1.0", -1],
  ];
  for (const [a, b, direction] of comparisons) {
    const result = Number(
      run("rpm", ["--eval", `%{lua:print(rpm.vercmp("${a}", "${b}"))}`]),
    );
    assert(
      Math.sign(result) === direction,
      `RPM comparator mismatch: ${a} vs ${b}: ${result}`,
    );
    run("dpkg", ["--compare-versions", a, direction > 0 ? "gt" : "lt", b]);
  }
  return {
    packageVersion: version,
    rpm: { name: rpm[0], version: rpm[1], release: rpm[2], arch: rpm[3] },
    debVersion: deb,
    nativeComparisons: comparisons.length,
    installationPerformed: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    assert(
      process.argv[2] === "--bundle-dir" && process.argv.length === 4,
      "Usage: --bundle-dir <built bundle directory>",
    );
    console.log(
      JSON.stringify(
        verifyLinuxPackageVersions({ bundleDir: process.argv[3] }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
