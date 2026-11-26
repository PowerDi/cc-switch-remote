import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const posix = (path) =>
  path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const script = posix(resolve("scripts/probe-remote-helper.sh"));
function fixture(t) {
  const home = mkdtempSync(`${tmpdir()}/cc-switch-probe-test-`).replaceAll(
    "\\",
    "/",
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(`${home}/bin`);
  const run = (mode, path) =>
    spawnSync("sh", [script, mode, path], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        HOME: posix(home),
        CC_SWITCH_TEST_HOME: "unsafe-inherited-value",
        PATH: `${posix(home)}/bin:${process.env.PATH}`,
      },
    });
  const helper = (
    name,
    body = `printf '%s\\n' '{"ok":true,"data":{"version":"fixture","capabilities":["session"]}}'`,
  ) => {
    writeFileSync(`${home}/bin/${name}`, `#!/bin/sh\n${body}\n`);
    chmodSync(`${home}/bin/${name}`, 0o755);
  };
  return { home, run, helper };
}

test("probe distinguishes missing and executable files and resolves bare PATH names", (t) => {
  const f = fixture(t);
  f.helper("helper");
  for (const path of [
    "helper",
    "~/bin/helper",
    `${posix(f.home)}/bin/helper`,
  ]) {
    const result = f.run("presence", path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "executable");
  }
  assert.equal(f.run("presence", "~/bin/absent").stdout, "missing");
  writeFileSync(`${f.home}/bin/nonexec`, "not executable");
  chmodSync(`${f.home}/bin/nonexec`, 0o644);
  assert.equal(f.run("presence", "~/bin/nonexec").stdout, "not-executable");
  assert.equal(f.run("presence", "nonexec").stdout, "not-executable");
});

test("tilde, spaces, non-ASCII and shell punctuation are data, never shell arguments", (t) => {
  const f = fixture(t);
  const name = "辅助 helper'; touch INJECTION";
  f.helper(name);
  const result = f.run("presence", `~/bin/${name}`);
  assert.equal(result.stdout, "executable", result.stderr);
  assert.equal(existsSync(`${f.home}/INJECTION`), false);
});

test("old status initialization writes only inside isolated HOME, not original profile data", (t) => {
  const f = fixture(t);
  f.helper(
    "old-helper",
    `mkdir -p "$HOME/.cc-switch-remote"\nprintf fixture > "$HOME/.cc-switch-remote/db"\n[ "$HOME" = "$CC_SWITCH_TEST_HOME" ] || exit 1\nprintf '%s\\n' '{"ok":true,"data":{"version":"old","capabilities":["session"]}}'`,
  );
  const result = f.run("status", "old-helper");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.version, "old");
  assert.equal(existsSync(`${f.home}/.cc-switch-remote`), false);
});

test("helper Permission denied / exit 255 is a helper failure, not SSH auth failure", (t) => {
  const f = fixture(t);
  f.helper("bad-helper", 'echo "Permission denied" >&2; exit 255');
  assert.equal(f.run("presence", "bad-helper").stdout, "executable");
  const result = f.run("status", "bad-helper");
  assert.equal(result.status, 65);
  assert.match(result.stderr, /Permission denied/);
});
