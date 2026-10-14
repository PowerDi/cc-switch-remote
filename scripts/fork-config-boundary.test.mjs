import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");

test("upstream merges preserve Remote product, binary and deep-link identities", () => {
  assert.equal(tauri.productName, "CC Switch Remote");
  assert.equal(tauri.identifier, "com.ccswitch.remote");
  assert.deepEqual(tauri.plugins["deep-link"].desktop.schemes, [
    "ccswitch",
    "ccswitch-remote",
  ]);
  assert.match(cargo, /^name = "cc-switch-remote"$/m);
  assert.match(cargo, /^default-run = "cc-switch-remote"$/m);
  assert.match(cargo, /^autobins = false$/m);
  assert.match(
    cargo,
    /\[\[bin\]\]\s+name = "cc-switch-remote"\s+path = "src\/main.rs"\s+required-features = \["desktop"\]/,
  );
  assert.match(
    cargo,
    /\[\[bin\]\]\s+name = "cc-switch-remote-helper"\s+path = "src\/bin\/cc-switch-cli.rs"/,
  );
  assert.match(cargo, /^default = \["desktop"\]$/m);
  assert.match(cargo, /^proxy-runtime = \[\]$/m);
  assert.match(cargo, /^tauri = .*optional = true/m);
});

test("updater stays on the fork repository and retains its trusted public key", () => {
  // 2026-10-13：本 fork 轮换了自己的 updater 签名密钥（旧 key id 9BAF0EEE4E844E4C
  // 的私钥已不可用），公钥与最新 key id 必须一起更新，别只改一边。
  const repository = cargo.match(/^repository = "([^"]+)"$/m)?.[1];
  // The fork owns its release chain now: the inherited xiaoY233 repository is no
  // longer maintained here, and upstream's repository must never be adopted.
  assert.equal(repository, "https://github.com/PowerDi/cc-switch-remote");
  assert.deepEqual(tauri.plugins.updater.endpoints, [
    `${repository}/releases/latest/download/latest.json`,
  ]);
  const publicKey = Buffer.from(tauri.plugins.updater.pubkey, "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  const packet = Buffer.from(publicKey[1], "base64");
  assert.equal(packet.length, 42);
  assert.equal(packet.subarray(0, 2).toString(), "Ed");
  const keyId = Buffer.from(packet.subarray(2, 10))
    .reverse()
    .toString("hex")
    .toUpperCase();
  assert.equal(keyId, "E490AF071AC1237F");
});

test("development and release data directory names remain distinct from upstream", () => {
  const config = read("src-tauri/src/config.rs");
  assert.match(
    config,
    /const APP_CONFIG_DIR_NAME: &str = "\.cc-switch-remote";/,
  );
  assert.match(
    config,
    /const DEV_APP_CONFIG_DIR_NAME: &str = "\.cc-switch-remote-dev";/,
  );
  assert.match(
    config,
    /const LEGACY_APP_CONFIG_DIR_NAME: &str = "\.cc-switch";/,
  );
});

test("fork packaging and helper artifacts are not replaced by official names", () => {
  assert.equal(tauri.bundle.windows.wix.template, "wix/per-user-main.wxs");
  const release = read(".github/workflows/release.yml");
  const helper = read(".github/workflows/helper-artifacts.yml");
  assert.match(release, /CC-Switch-Remote-/);
  assert.match(release, /verify-tauri-updater-signatures\.mjs/);
  assert.match(helper, /remote-helper-latest/);
  assert.match(helper, /cc-switch-remote-helper-latest-/);
  // 工作流按 $GITHUB_REPOSITORY 发布，所以在哪个仓库跑就发到哪个仓库。
  assert.match(helper, /--repo "\$GITHUB_REPOSITORY"/);
  assert.match(helper, /--no-default-features --features proxy-runtime/);
  for (const workflow of [release, helper]) {
    assert.doesNotMatch(workflow, /farion1231\/cc-switch/);
  }
});

test("helper downloads come from this fork's release chain, not the inherited repo", () => {
  // 继承来的 xiaoY233 仓库不再由本项目维护，也不该再有新工件；helper 的下载源
  // （Rust 安装命令 + 独立安装脚本）必须和发布工作流的仓库一致，否则用户永远装到旧 helper。
  const sources = [
    read("src-tauri/src/remote/ssh.rs"),
    read("scripts/install-remote-helper.sh"),
  ];
  for (const source of sources) {
    assert.match(source, /PowerDi\/cc-switch-remote/);
    assert.doesNotMatch(source, /xiaoY233/);
  }
});

test("remote ssh processes never open a Windows console window", () => {
  // GUI 进程 spawn 控制台程序会新建控制台窗口：远端模块里只允许两个构造器直接
  // new ssh，并且两者都必须设置 CREATE_NO_WINDOW（否则每发一条命令都闪一个黑窗）。
  const ssh = read("src-tauri/src/remote/ssh.rs");
  const session = read("src-tauri/src/remote/session.rs");
  assert.equal((ssh.match(/Command::new\("ssh"\)/g) || []).length, 2);
  assert.equal((session.match(/Command::new\("ssh"\)/g) || []).length, 0);
  assert.equal(
    (ssh.match(/creation_flags\(CREATE_NO_WINDOW\)/g) || []).length,
    2,
  );
  assert.match(session, /ssh_tokio_command\(\)/);
  assert.match(ssh, /pub\(crate\) fn ssh_command\(\) -> Command/);
  assert.match(
    ssh,
    /pub\(crate\) fn ssh_tokio_command\(\) -> tokio::process::Command/,
  );
});

test("helper build identity follows real worktree refs without watching missing paths", () => {
  const build = read("src-tauri/build.rs");
  assert.match(build, /"rev-parse", "--git-path"/);
  assert.match(build, /"symbolic-ref", "-q", "HEAD"/);
  assert.match(build, /Path::new\(&path\)\.exists\(\)/);
  assert.match(
    build,
    /rustc-env=CC_SWITCH_REMOTE_HELPER_BUILD=\{helper_build\}/,
  );
  assert.doesNotMatch(
    build,
    /println!\("cargo:rerun-if-changed=\.\.\/\.git\/HEAD"\)/,
  );
  assert.match(build, /var\("GITHUB_SHA"\)[\s\S]*?or_else\(\|\| git_output/);
});

test("about and recovery UI retain the same fork release chain and Remote branding", () => {
  const repository = cargo.match(/^repository = "([^"]+)"$/m)?.[1];
  assert.ok(repository);
  const about = read("src/components/settings/AboutSection.tsx");
  const recovery = read("src/components/DatabaseUpgrade.tsx");
  assert.match(about, />CC Switch Remote<\/div>/);
  assert.equal(
    about.match(/const APP_RELEASES_URL\s*=\s*"([^"]+)"/)?.[1],
    `${repository}/releases`,
  );
  assert.equal(
    about.match(/const APP_REPOSITORY_URL\s*=\s*"([^"]+)"/)?.[1],
    repository,
  );
  assert.match(about, /const APP_WEBSITE_URL = APP_REPOSITORY_URL;/);
  assert.match(about, /openExternal\(APP_RELEASES_URL\)/);
  assert.match(about, /openExternal\(APP_REPOSITORY_URL\)/);
  assert.match(about, /openExternal\(APP_WEBSITE_URL\)/);
  assert.equal(
    recovery.match(/const RELEASES_URL\s*=\s*"([^"]+)"/)?.[1],
    `${repository}/releases`,
  );
  for (const source of [about, recovery]) {
    assert.doesNotMatch(
      source,
      /https:\/\/(?:github\.com\/farion1231\/cc-switch|ccswitch\.io)/,
    );
  }
});

test("every runtime release link, updater endpoint and repository URL is this fork", () => {
  // 运行时出现的仓库/发布/更新地址必须全部指向本 fork：继承仓库不再维护新工件，
  // 上游仓库更是别的发布链。文档里的历史发布说明与 README 的来源署名不在扫描范围内。
  const repository = cargo.match(/^repository = "([^"]+)"$/m)?.[1];
  assert.equal(repository, "https://github.com/PowerDi/cc-switch-remote");
  assert.equal(
    tauri.plugins.updater.endpoints[0],
    `${repository}/releases/latest/download/latest.json`,
  );
  const runtimeSources = [
    read("src/lib/forkReleases.ts"),
    read("src/components/settings/AboutSection.tsx"),
    read("src/components/DatabaseUpgrade.tsx"),
    read("src-tauri/src/commands/misc.rs"),
    read("src-tauri/src/tray.rs"),
    read("src-tauri/src/remote/ssh.rs"),
    read("src-tauri/src/commands/remote.rs"),
    read("scripts/install-remote-helper.sh"),
    read(".github/FUNDING.yml"),
  ];
  for (const source of runtimeSources) {
    assert.doesNotMatch(source, /xiaoY233/);
  }
  assert.equal(
    read("src/lib/forkReleases.ts").match(
      /FORK_RELEASES_URL\s*=\s*"([^"]+)"/,
    )?.[1],
    `${repository}/releases`,
  );
});

test("upstream merge does not resurrect the removed full WSL nightly", () => {
  assert.equal(
    fs.existsSync(path.join(root, ".github/workflows/wsl2-nightly.yml")),
    false,
  );
});
