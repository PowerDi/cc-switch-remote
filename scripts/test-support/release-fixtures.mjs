import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parsers } from "prettier/plugins/yaml";
import { REPO_ROOT, readReleaseMetadata } from "../release-identity.mjs";

export const read = (file) =>
  fs.readFileSync(path.join(REPO_ROOT, file), "utf8");

// Parse YAML with the already-declared Prettier dependency (no new dependency or network).
// Unknown AST shapes fail closed rather than silently dropping workflow protections.
export function parseWorkflow(source) {
  function value(node) {
    if (!node) return null;
    if (node.type === "root") {
      assert.equal(node.children.length, 1, "Expected one YAML document");
      return value(node.children[0]);
    }
    if (node.type === "document")
      return value(
        node.children.find((child) => child.type === "documentBody"),
      );
    if (node.type === "mapping") {
      const result = {};
      for (const item of node.children) {
        const key = value(item.children[0]);
        assert.ok(!Object.hasOwn(result, key), `Duplicate YAML key: ${key}`);
        result[key] = value(item.children[1]);
      }
      return result;
    }
    if (["sequence", "flowSequence"].includes(node.type))
      return node.children.map(value);
    if (
      [
        "documentBody",
        "mappingKey",
        "mappingValue",
        "sequenceItem",
        "flowSequenceItem",
      ].includes(node.type)
    ) {
      assert.ok(node.children.length <= 1, `Unexpected wrapper: ${node.type}`);
      return value(node.children[0]);
    }
    if (
      [
        "plain",
        "quoteDouble",
        "quoteSingle",
        "blockLiteral",
        "blockFolded",
      ].includes(node.type)
    ) {
      if (
        node.type === "plain" &&
        ["true", "false", "null"].includes(node.value)
      )
        return JSON.parse(node.value);
      return node.value;
    }
    throw new Error(`Unsupported YAML AST node: ${node.type}`);
  }
  return value(parsers.yaml.parse(source));
}

export const workflow = (file) =>
  parseWorkflow(read(`.github/workflows/${file}`));
export function step(job, name) {
  const matches = job.steps.filter((item) => item.name === name);
  assert.equal(matches.length, 1, `Expected exactly one step: ${name}`);
  return matches[0];
}

// Node 24 on this Windows host can return from rmSync without removing files.
// Use explicit unlink/rmdir, and never traverse symlinks or leave .validation.
export function removeFixture(file) {
  const base = path.join(REPO_ROOT, ".validation") + path.sep;
  assert.ok(
    path.resolve(file).startsWith(base),
    "Fixture cleanup must remain inside .validation",
  );
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(file))
      removeFixture(path.join(file, entry));
    fs.rmdirSync(file);
  } else {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      fs.chmodSync(file, 0o666);
      fs.unlinkSync(file);
    }
  }
}

export function tempDir(t) {
  const base = path.join(REPO_ROOT, ".validation", "script-fixtures");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "release-"));
  t.after(() => removeFixture(dir));
  return dir;
}

export function frozenMetadata() {
  return JSON.parse(read("tests/fixtures/releaseIdentityLegacy.json"));
}

export function candidateMetadata() {
  const metadata = structuredClone(readReleaseMetadata());
  metadata.current.releaseReady = true;
  // Synthetic verification flags are confined to test fixtures, never production metadata.
  metadata.upgradeValidation.installerContract = "contract-reviewed";
  return metadata;
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}
