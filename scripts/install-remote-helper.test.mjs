import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const posix = (path) =>
  path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const script = posix(resolve("scripts/install-remote-helper.sh"));
const metadata = {
  ok: true,
  data: {
    version: "4.1.0",
    build: null,
    platform: "linux",
    arch: "x86_64",
    capabilities: ["providers", "session"],
  },
  error: null,
};
const binary = (value = metadata) =>
  `#!/bin/sh\n[ "$HOME" = "$CC_SWITCH_TEST_HOME" ] || exit 7\n[ -z "\${UNSAFE_OVERRIDE:-}" ] || exit 8\n[ ! -e "$HOME/production-marker" ] || exit 9\nprintf '%s\\n' '${JSON.stringify(value)}'\n`;
function setup(t) {
  const dir = mkdtempSync(
    join(tmpdir(), "cc-switch-installer-test-"),
  ).replaceAll("\\", "/");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "mock-bin").replaceAll("\\", "/");
  mkdirSync(bin);
  const target = `${dir}/helper 空 格`;
  writeFileSync(target, "#!/bin/sh\nprintf old-helper\n");
  chmodSync(target, 0o755);
  const old = readFileSync(target);
  writeFileSync(`${dir}/production-marker`, "untouched");
  const mock = (name, text) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/sh\n${text}\n`);
    chmodSync(`${bin}/${name}`, 0o755);
  };
  mock("uname", '[ "$1" = -s ] && echo Linux || echo x86_64');
  const run = (input, extra = {}) =>
    spawnSync("sh", [script], {
      input,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${posix(bin)}:${process.env.PATH}`,
        HOME: posix(dir),
        CC_SWITCH_HELPER_PATH: posix(target),
        CC_SWITCH_INSTALL_MODE: "upload",
        CC_SWITCH_REQUIRED_CAPABILITIES: "providers session",
        UNSAFE_OVERRIDE: "must-not-reach-helper",
        ...extra,
      },
    });
  const preserved = () => {
    assert.deepEqual(readFileSync(target), old);
    assert.equal(readFileSync(`${dir}/production-marker`, "utf8"), "untouched");
  };
  return { dir, bin, target, run, preserved, mock };
}

test("upload validates isolated metadata then atomically commits; path and mode preserved", (t) => {
  const { target, run } = setup(t);
  const mode = statSync(target).mode;
  const result = run(binary());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), metadata);
  assert.equal(readFileSync(target, "utf8"), binary());
  assert.equal(statSync(target).mode, mode);
  assert.equal(existsSync(`${target}.install-lock`), false);
});

for (const [name, bytes, code] of [
  ["truncated upload", "", "helper-validation"],
  ["non-running binary", "#!/bin/sh\nexit 3\n", "helper-validation"],
  [
    "invalid protocol with misleading ok/capability text",
    '#!/bin/sh\necho \'garbage "ok":true "version":"test" "providers" "session"\'\n',
    "helper-protocol",
  ],
  [
    "missing capability",
    binary({
      ...metadata,
      data: { ...metadata.data, capabilities: ["providers"] },
    }),
    "helper-capabilities",
  ],
  [
    "error envelope",
    binary({ ok: false, error: { code: "failed" } }),
    "helper-protocol",
  ],
])
  test(`${name} preserves the original binary and cleans its own lock`, (t) => {
    const f = setup(t);
    const result = f.run(bytes);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`CC_SWITCH_INSTALL_ERROR:${code}`));
    f.preserved();
    assert.equal(existsSync(`${f.target}.install-lock`), false);
  });

for (const [name, raw] of [
  [
    "duplicate ok",
    JSON.stringify(metadata).replace('"ok":true', '"ok":true,"ok":true'),
  ],
  [
    "duplicate data",
    JSON.stringify(metadata).replace(
      '"data":',
      '"data":' + JSON.stringify(metadata.data) + ',"data":',
    ),
  ],
  [
    "duplicate metadata key",
    JSON.stringify(metadata).replace(
      '"version":"4.1.0"',
      '"version":"4.1.0","version":"4.1.0"',
    ),
  ],
  [
    "multiple JSON records",
    JSON.stringify(metadata) + "\n" + JSON.stringify(metadata),
  ],
  [
    "missing platform",
    JSON.stringify({
      ...metadata,
      data: {
        version: "test",
        arch: "x86_64",
        capabilities: ["providers", "session"],
      },
    }),
  ],
])
  test(`rejects shell/Rust protocol mismatch: ${name}`, (t) => {
    const f = setup(t);
    const result = f.run(`#!/bin/sh\nprintf '%s\\n' '${raw}'\n`);
    assert.equal(result.status, 65, result.stderr);
    assert.match(result.stderr, /CC_SWITCH_INSTALL_ERROR:helper-protocol/);
    f.preserved();
  });

test("post-commit acknowledgement failure is not a precommit-preservation diagnostic", (t) => {
  const f = setup(t);
  // Same production script, stdout deliberately fails only once it prints ack.
  const result = spawnSync(
    "sh",
    ["-c", 'exec sh "$1" > /dev/full', "--", script],
    {
      input: binary(),
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${posix(f.bin)}:${process.env.PATH}`,
        HOME: posix(f.dir),
        CC_SWITCH_HELPER_PATH: posix(f.target),
        CC_SWITCH_INSTALL_MODE: "upload",
        CC_SWITCH_REQUIRED_CAPABILITIES: "providers session",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.target, "utf8"), binary());
  assert.doesNotMatch(result.stderr, /CC_SWITCH_INSTALL_ERROR:/);
});

test("an existing lock is never stolen or treated as network failure", (t) => {
  const f = setup(t);
  mkdirSync(`${f.target}.install-lock`);
  writeFileSync(`${f.target}.install-lock/phase`, "receiving");
  const result = f.run(binary());
  assert.equal(result.status, 75, result.stderr);
  f.preserved();
  assert.equal(
    readFileSync(`${f.target}.install-lock/phase`, "utf8"),
    "receiving",
  );
});

test("rename failure preserves the old installation", (t) => {
  const f = setup(t);
  f.mock("mv", "exit 1");
  const result = f.run(binary());
  assert.equal(result.status, 73, result.stderr);
  f.preserved();
});

test("only confirmed download failure carries the local fallback code", (t) => {
  const f = setup(t);
  f.mock("curl", "exit 28");
  f.mock("wget", "exit 4");
  const result = f.run("", { CC_SWITCH_INSTALL_MODE: "download" });
  assert.equal(result.status, 69, result.stderr);
  assert.match(result.stderr, /CC_SWITCH_INSTALL_ERROR:download-failed/);
  f.preserved();
  assert.equal(existsSync(`${f.target}.install-lock`), false);
});

test("download destination permission errors do not authorize network fallback", (t) => {
  const f = setup(t);
  f.mock("curl", "exit 23");
  const result = f.run("", { CC_SWITCH_INSTALL_MODE: "download" });
  assert.equal(result.status, 73, result.stderr);
  assert.doesNotMatch(result.stderr, /CC_SWITCH_INSTALL_ERROR:download-failed/);
  f.preserved();
});

test("unsupported remote platform fails before installation", (t) => {
  const f = setup(t);
  f.mock("uname", "echo unsupported");
  const result = f.run(binary());
  assert.equal(result.status, 66, result.stderr);
  f.preserved();
});

test("Windows portable packaging must fail when the fork askpass sidecar is missing", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(
    workflow,
    /throw 'Required cc-switch-remote-askpass\.exe sidecar is missing/,
  );
  assert.doesNotMatch(workflow, /Write-Warning 'SSH askpass sidecar not found/);
  const config = JSON.parse(
    readFileSync("src-tauri/tauri.windows.conf.json", "utf8"),
  );
  assert.ok(
    config.bundle.externalBin.some((value) =>
      value.includes("cc-switch-remote-askpass"),
    ),
  );
});
