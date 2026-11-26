# Remote 版本身份、首次迁移与打包契约

## 唯一派生版本规则

根目录 `release-identity.json` schema 2 是当前身份源：

- 上游正式基线：`4.0.21`，精确 commit `c4db63c60d2a1ddcb4bd9f81152b9c6126413659`。
- Remote 修订号：`1`。
- **应用版本固定派生**：`${upstreamVersion}-remote.${remoteRevision}`，即 `4.0.21-remote.1`。`package.json`、Cargo.toml、Cargo.lock 的本包、tauri.conf.json 必须一致，不再独立选择安装数字。
- 公开 tag：`remote-v4.0.21-r1`；UI：**4.0.21 · Remote r1**。
- 同基线修复：`4.0.21-remote.2`；将来合入已发布官方 `v4.0.40` 后才可用 `4.0.40-remote.1`。本轮无上游合并。

SemVer 的 `-remote.N` 是 prerelease 语法，但 fork GitHub release 使用 `prerelease:false`，属于稳定发布通道。`+remote.N` 仅是 build metadata、不参与排序，禁止用作修订序列。也不抢占更大的 core 数字或新增裸 `v*` 兼容 tag。

## 已批准的单次旧方案切换

<!-- manual-migration-approved -->
<!-- manual-client-reinstall -->

用户已明确批准**所有旧客户端一次手动重新安装**，替代原先“安装版本永远大于 4.1.0”与“仅 portable 手动迁移”的旧方案。`4.0.21-remote.1 < 4.1.0` 是真实 SemVer 事实；旧正常 About updater 和数据库恢复 updater 都不会把它认作新版本，不能声称自动升级可行。旧硬编码 `v{安装版本}` 的详情/portable URL 也无法被新客户端追溯修复。手动入口始终是 [本 fork 发布页](https://github.com/PowerDi/cc-switch-remote/releases)。

只读 GitHub releases API 当前返回 7 项：以下六个桌面 stable release，加 `remote-helper-latest`（helper prerelease）。origin 的更早 v3 tags **不是当前公开 release 清单**，不能据此泛化豁免。

| 旧 tag / 原始应用版本 | 精确发布 commit |
| --- | --- |
| v4.0.5 / 4.0.5 | e751681e645ea5398d17197b09eee1c3a5b0dcab |
| v4.0.6 / 4.0.6 | 766f27f4cc6d1ba0ac612e5f5e15262fed5d8703 |
| v4.0.7 / 4.0.7 | 218135f43d285b140a090ff2c961736c66cdaf85 |
| v4.0.8 / 4.0.8 | 85bca82e3a7299dc65dd68018c21d2674db3e0b8 |
| v4.0.9 / 4.0.9 | ec5b6931c4ad845a945fa6dcbe8fab3664259531 |
| v4.1.0 / 4.1.0 | ed4353caf8536d8a7b902e799ff5f59c082178d5 |

`release-legacy-boundary.json` 保存此精确集合，验证器用 canonical JSON SHA-256 锁定。首次无新方案历史时，只允许 `remote-v4.0.21-r1 / 4.0.21-remote.1` 切换。之后必须归档该首次身份，新方案版本严格递增且同基线 revision 连续；不得重用首次豁免回退新方案历史。

正式 publication 每次（包括上传前持跨 tag 锁时）重新读取**全部非 draft** release inventory。未知 `v3`、`v99`、未知 Remote tag 或未记录 prerelease 一律阻断；已知历史必须仍存在、tag peeled SHA 不可移动且 commit 为候选祖先。仅 helper 专用 tag 被明确排除。schema 1 快照只能维护其中显式列出的历史身份，不允许新的构建/发布，也不能从任意 `v*` 猜测版本。

## 升级 / 安装契约审查

<!-- contract-reviewed -->
<!-- real-install-not-performed -->

这是源码、配置、定向测试及下述 Linux x64 实际构建/原生查询证据的 **contract-reviewed**，不是“已实机安装 verified”。`manualClientMigration=manual-migration-approved`、`futureUpdaterContract=contract-reviewed`、`installerContract=contract-reviewed`；经发布候选审核批准，当前 `releaseReady=true`，但 `realInstallValidation=not-performed` 保持不变。Windows/macOS 仍是锁定工具链的契约审查，其实际产物、签名与发布链继续由正式流程核对。`current.status=unreleased` 只表示准备时 release 尚未发布；ready 候选的 UI 不会因此永久显示“未发布”。将来实际完成安装验证时允许改为 `verified-with-evidence`，但必须提供当前 tag/应用版本对应的证据文档与验证标记；本次没有安装、启动应用或迁移用户数据库。

### 已安装数据与恢复路径逐项核对

- identifier 仍 `com.ccswitch.remote`；release 数据仍 `~/.cc-switch-remote`，debug 仍 `~/.cc-switch-remote-dev`。未改 schema 23、数据目录默认值、updater endpoint 或 key id `E490AF071AC1237F`。
- 手动替换前退出旧/开发应用，备份完整 fork 数据目录、数据库及配套文件、备份目录、Tauri store `app_paths.json` 与实际 override 目录。不改官方 `~/.cc-switch`，不删除/降级数据库来适配版本号。
- Windows MSI 为现有 per-user 模板。卸载/重新安装应用不等于授权删除用户数据；如旧安装器阻止替换，先备份，再只卸载程序。portable 必须完整保留 askpass sidecar。
- macOS 为 `.app` 替换；Linux AppImage 为文件替换，deb/rpm 由用户明确手动接受版本降低。无系统安装或包数据库写入在本轮执行。
- 新旧本批程序均支持 schema 23；存储版本 >23 时不能通过重新安装本版恢复。恢复页 updater 命令保持 state-free，但旧 4.1.0 的版本比较仍挡住本次迁移，必须手动发布页路径。正常/恢复/restart 的真实迁移尚未执行。
- 新方案 future updater 继续比较完整 SemVer，r1→r2、r9→r10、4.0.21-remote.99→4.0.40-remote.1 有定向排序测试；旧 4.1.0→首次新方案明确为 downgrade。新客户端使用 updater `rawJson.releaseIdentity` schema 2 校验派生关系；不明身份只回退 fork releases 页。

### 发布锁定工具链与平台映射

真实 `pnpm-lock.yaml` 锁定 **@tauri-apps/cli 2.10.1**；只读获取其 crates.io 源码 Cargo.lock 确认 **tauri-bundler 2.8.1**。本工作区现有依赖 junction 的 CLI 2.8.1 是旧缓存，**不能作为发布打包证据**，CI 使用 frozen lock 安装 2.10.1。未修改其他 worktree 依赖。下述源码审查以 2.10.1/2.8.1 为准。只读来源为 crates.io `tauri-cli/2.10.1` 的 Cargo.lock（bundler checksum `f0406e4f78c2caa61e312c2f98d4f9e97f11d0e3de55ced8f10cb3e34517c249`）与 `tauri-bundler/2.8.1` 的 `windows/msi/mod.rs`、`macos/app.rs`、`linux/debian.rs`、`linux/rpm.rs`。

| 平台/路径 | 审查结论与配置 | 未验证部分 |
| --- | --- | --- |
| Tauri updater 2.10.0 | 默认 `release.version > current_version`，使用 Rust SemVer；不依赖 GitHub prerelease 标志 | 正常/恢复 UI 的真实下载、重启与签名安装 |
| Windows WiX | bundler `convert_version` 拒绝非数字 `remote.1`；显式 `bundle.windows.wix.version=4.0.21` 避开自动转换。系统 ProductVersion 与上游主数字相同，应用 SemVer 仍带 suffix。现模板 allow_downgrades 默认分支允许旧安装数值回退，另一分支 `AllowSameVersionUpgrades=yes`，支持同 core r2 覆盖契约 | MSI 实际安装/同数字覆盖未实机执行；不是新的独立安装序列 |
| macOS | bundler 默认 CFBundleVersion/ShortVersion 写完整 app version，因此设置 `macOS.bundleVersion=4.0.21`，现有 Info.plist 覆盖 ShortVersion 为 4.0.21。Tauri runtime/updater 的版本仍来自应用配置而非这两个 OS 显示字段 | 实际签名、公证、替换与启动；同 core revision 不依靠 Apple 数字字段排序 |
| Debian | Linux x64 实际构建的 `dpkg-deb -f` 确认 `Version: 4.0.21-remote.1`，原生 `dpkg --compare-versions` 排序 gate 已通过，见下方运行证据 | 实际安装、旧客户端迁移及 arm64 产物仍未由该 x64 运行验证 |
| RPM | Linux x64 实际构建的 `rpm -qp` 确认 NAME=`cc-switch-remote`、VERSION=`4.0.21-remote.1`、RELEASE=`1`、ARCH=`x86_64`；原生 `rpm.vercmp` 排序 gate 已通过，不需要另设 Version/Release 映射 | 实际安装、旧客户端迁移及 arm64 产物仍未由该 x64 运行验证 |

`scripts/verify-linux-package-versions.mjs` 作为 Linux 构建后必经 gate：读取唯一 deb/rpm、要求实际 Version 与派生应用版本相同、调用 native rpm/dpkg 比较 r1→r2/新基线以及 legacy downgrade，输出日志证据。不安装、不修改系统数据库。Windows/macOS 数字包壳是格式适配，绝非恢复独立 `4.1.1` 序列。新 Remote revision 修改时，四份 app version 需随之派生；数字包壳仅随 upstreamVersion 改变。

### Linux x64 构建与原生查询证据

- 源码 commit：`78435710fa68b1f76898d916fed26051f73de16b`；准备分支 `release/remote-v4.0.21-r1`。
- [`release.yml` run 45749983081](https://github.com/PowerDi/cc-switch-remote/actions/runs/45749983081)：`workflow_dispatch(platform=linux-x64)`，不是正式发布或全量测试。identity job `139675156176` success；[Linux job `139675248238`](https://github.com/PowerDi/cc-switch-remote/actions/runs/45749983081/job/139675248238) success；publish skipped。
- `2026-11-26T03:49:00Z` 的 `verify-linux-package-versions` 输出：`packageVersion=4.0.21-remote.1`，RPM `cc-switch-remote / 4.0.21-remote.1 / 1 / x86_64`，`debVersion=4.0.21-remote.1`，`nativeComparisons=4`，**`installationPerformed=false`**。四组原生比较覆盖 Remote revision 递增、新基线递增及旧 `4.1.0` 到首次新方案必须手动重装的降序事实。
- 已生成 [artifact `15085925603` / `release-assets-Linux-X64`](https://github.com/PowerDi/cc-switch-remote/actions/runs/45749983081/artifacts/15085925603)。此证据针对上述 commit 的构建产物与包元数据，不将该旧准备构建冒充后续最终 tag 的产物；最终发布仍须核对 tag/commit、资产身份与签名。
- 本次收尾仅更新 readiness 与证据说明，不改变四份应用版本、打包逻辑或 schema 23。Linux 包查询成功不等于完成安装，Windows/macOS 与真实 SSH/数据库恢复升级仍保留原有未验证范围。

## 发布与维护门槛

- 验证派生 packageVersion、四份版本、Windows/macOS 数字映射及 schema 2 迁移边界；不能只开 `releaseReady` 绕过证据。
- 官方 baseline 必须来自 `farion1231/cc-switch` 已发布 stable tag，隔离 `refs/remotes/upstream/tags/v4.0.21` peeled SHA 精确一致且是候选祖先。
- 新 tag 与事件 commit/HEAD 一致，候选属于 `origin/main`；历史 tag 不动。并发旧构建在持锁上传前再次盘点 inventory，不能覆盖更新 release。
- `release.yml` 只有 push 新 Remote tag 才发布，manual dispatch 仅构建验证；Linux native gate 也适用于正式构建。产物齐全、签名 key id/URL/identity snapshot 核对后才创建 release。
- `release-maintenance.yml` 只维护指定已有发布，使用它的 identity 快照/日期/notes，不重复构建其他平台。`sync-release-notes.yml` 只修改 tag 对应 fork notes。
- `helper-artifacts.yml` 会独立更新 `remote-helper-latest`，不是第二桌面发布；本次 Rust/Cargo 改动可触发 helper fan-out，需要主代理发布前解释和管理。
- 不改上游官方版本规则、不合入 v4.0.40、不建新的裸 v* tag、不移动/改名任何旧 release。上游 tags 仍隔离在 remote namespace，不从 upstream 批量导入本 fork `refs/tags`。
