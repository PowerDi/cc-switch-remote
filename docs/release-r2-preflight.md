# Remote r2 发布前审阅

## 基线与线上清单（2026-11-27）

- 候选基于本地 `main` 的 `c06be4d0`，包含 `c724bfea`（账号管理）、`97dac9da`（模型表单）、`c06be4d0`（设置并发）。审阅时 `origin/main` 为 `e98194494ae09bbc0294287ad6e01c714f523e7b`。不合并上游、不增加裸 `v*` tag、不改历史发布。
- GitHub 公共 Releases API 返回 8 个非草稿记录：桌面 `remote-v4.0.21-r1`、`v4.1.0`、`v4.0.9`、`v4.0.8`、`v4.0.7`、`v4.0.6`、`v4.0.5`，及独立 prerelease `remote-helper-latest`。`git ls-remote --tags origin` 解引用后的 7 个桌面 tag 与 `release-identity.json` 的历史 SHA 对应；旧 v2/v3 tag 不是现存公开 Release。尚无 r2 远端 tag 或公开 Release。
- r1 Release ID `459053371` 是 API `/releases/latest` 的实际返回；annotated tag `08fb2940e63a058f8ba4d7663f81d44a5829f0cd` 解引用为 `c0b701e44bf89fb1d264236949a3af2745af1989`，不是 `origin/main` 或维护工作流 commit。r1 随包 identity 是 tag 发布前的未发布快照，保留原样；本次只在新 identity 的 `history` 归档其公开发布事实。
- r1 资产共 13 个：Windows MSI、MSI `.sig`、便携 ZIP，两个 Linux 架构各有 AppImage、AppImage `.sig`、deb、rpm，以及 `latest.json` 和 `release-identity.json`。实际 updater 端点返回 `4.0.21-remote.1`，与 r1 tag 的清单一致，仅含 `windows-x86_64`、`linux-x86_64`、`linux-aarch64` 的 r1 资产。三份清单签名匹配同名 `.sig` 和 key ID `E490AF071AC1237F`；本轮未重验 r1 大工件的密码学签名。Helper Release ID `411740731`，滚动 tag 审阅时亦指向 `c0b701e4`，两个 Linux 架构各有短 SHA 和 `latest` 命名的二进制，共 4 件。
- 官方 API 确认 `farion1231/cc-switch` 的 `v4.0.21` 为已发布稳定版；远端 peeled SHA `c4db63c60d2a1ddcb4bd9f81152b9c6126413659` 是本候选祖先。保留该基线，只把 Remote revision 从 1 递增为 2。

## Fork 边界差异

以 r1 peeled SHA 为左侧比较 Tauri/Cargo/README、数据路径、GitHub 配置及工作流；本补丁只动版本元数据、文档和定向发版测试夹具。

| 边界 | 比较结果 |
| --- | --- |
| 品牌与安装身份 | `CC Switch Remote`、`com.ccswitch.remote`、`ccswitch` / `ccswitch-remote` 未变。Cargo、Cargo.lock、package.json、Tauri 应用版本均为 `4.0.21-remote.2`；WiX 数字 `ProductVersion` 仍为 `4.0.21`，沿用同数字升级配置。保留的 macOS 数字元数据仍为 `4.0.21`，不表示有包。 |
| Updater / 发布仓库 | Tauri endpoint、公钥及 `PowerDi/cc-switch-remote` 不变；公钥 key ID `E490AF071AC1237F`。About、数据库恢复页及 updater 资产 URL 都指向本 fork。 |
| Helper | `main` 的 push 及路径过滤不变（本次 `Cargo.toml` / `Cargo.lock` 命中）；保留 `remote-helper-latest`、两个安装入口及 fork 下载默认值。r1 tag 之后已有的变更是 Linux-only、固定源 SHA、单平台或指定源的验证构建不发布；本候选不改 workflow。 |
| 数据隔离 | 发布/调试默认 `~/.cc-switch-remote` / `~/.cc-switch-remote-dev` 与 `app_paths.json` 的位置和覆盖规则不变；schema 23 不变。设置并发修复的锁跟随实际设置目录，不改变该目录的解析。不启动应用、不访问实际数据或读取用户 store。 |
| GitHub 元数据与 README | CODEOWNERS、issue templates、funding 未变化。r1 tag 之后英文/中文 README 有已接受的 Windows/Linux 支持范围和 Remote tag/资产命名改动；项目名、仓库、badge/下载链接维持 fork 身份，保留来源署名，无上游专属赞助/转介内容引入。 |
| URL 扫描 | 扫描 `src`、`src-tauri`、`scripts`、`.github`：官方地址只用于基线真实性校验、代码溯源/issue 注释和测试；无继承仓库的运行时发布地址、stale helper 默认仓库或 fork 别名。 |

## 旧客户端升级契约

- `4.0.21-remote.2 > 4.0.21-remote.1`，但低于 `4.1.0`。WiX 同数字 MSI 升级契约以及旧客户端一次备份后手动重装的策略不改；不回退 schema。deb/rpm 的实际版本及原生排序仍需在两类 Linux runner 验证。
- 对照 r1 源码和候选：About 通过共享更新上下文检查，非便携安装通过 `install_update_and_restart` 安装；恢复页调用 `check_app_update_available` 和同一安装命令。两个 Rust 命令只接收 `AppHandle`，更新器代理配置通过 `try_state` 在恢复模式回退，不要求已初始化的 `AppState`。打开配置目录、退出、发行页 fallback 也无需正常 `AppState`。两条更新入口都使用本 fork endpoint 和公钥。
- `releaseReady: true` 仅表示候选满足版本发布门槛，不表示批准推送或实机验证。`realInstallValidation: not-performed` 保留。实际升级须在隔离 Windows/Linux 测试机上用 r1 与数据库夹具核验，包括 About、无 `AppState` 的恢复检查/安装、重启、版本确认及手动 fallback；不能用 dev 启动或生产数据库代替。

## 定向验证结果

- `release-identity.mjs` 校验 r2 四份版本、发行说明和迁移证据，另以 `--resolve-only` 核验历史 r1；用真实 GitHub 清单交叉核对历史 tag SHA 及候选祖先，未对工作仓库执行需要正式 tag 的 `--publish`。
- Node 20 定向发版测试共 62 项通过：identity 15 项、平台工作流 7 项、其他发版脚本与 fork 边界 40 项。前两组在本机临时验证副本运行，平台工作流使用 Git Bash。r1 合成场景由固定测试数据提供，不再随生产 identity 切换到 r2；真实候选仍由独立版本一致性测试覆盖。
- `pnpm typecheck` 和 Windows `cargo check --locked --manifest-path src-tauri/Cargo.toml --bin cc-switch-remote-helper --no-default-features --features proxy-runtime` 通过。未运行全量测试，未构建或安装桌面包；Linux 两架构的实际构建、工件验签和实装仍待后续验证。

## 发布顺序与验收（本轮不执行）

1. 父代理审完 diff 和定向检查后，再取得一次 main push 所触发全量 CI 的明确授权。把精确候选提交推到 `main` 一次：**CI** 跑全量 `pnpm test:unit` / `cargo test` 等检查；**Remote Helper Artifacts** 发布并移动独立的 `remote-helper-latest`；**Sync Release Notes** 只会更新已有 tag 的说明，r2 尚不存在时跳过，不创建 Release。不要用 `[skip ci]` 绕过门槛。
2. 确认 CI 通过、Helper 两架构都来自候选 SHA（滚动 tag、短 SHA / `latest` 文件及版本 `4.0.21-remote.2`）。重新读非草稿清单和历史 peeled tags，确认待发提交在 `origin/main` 上。仅在确认后创建并推送 `remote-v4.0.21-r2`，检查 peeled SHA 等于候选。**Release** 工作流执行 `release-identity.mjs --publish` 并在发布前再次盘点，构建 Windows x64 与 Linux x86_64/arm64，创建并设为最新桌面 Release。桌面 `workflow_dispatch` 可固定源 SHA 做构建验证但不发布，不是默认必跑项。
3. 核对两架构实际 deb/rpm Version 是 `4.0.21-remote.2`，WiX 实际 ProductVersion 是 `4.0.21`；用 `dpkg --compare-versions 4.0.21-remote.2 gt 4.0.21-remote.1`、RPM `rpm.vercmp` 显式比较 r2 > r1。核对 13 个桌面资产与 r1 同类、以 r2 tag 命名、无 macOS；`release-identity.json` 与候选源码一致。`latest.json` 必须从真实构建资产组装，核对版本、三平台、每个 URL 属于本 fork 的 r2 tag，以及签名与同名 `.sig` 一致。自动化脚本 `verify-tauri-updater-signatures.mjs` 只查 key ID `E490AF071AC1237F`；验收还要把 Tauri 公钥和三份签名从外层 Base64 解码，用 `minisign -Vm <artifact> -x <decoded.sig> -p <decoded.pub>` 验证 MSI 和两件 AppImage 的实际字节与受信注释。发布后从真实 `releases/latest/download/latest.json` 重读并和 tag 资产比对，不能以本地样例代替。
4. 单平台失败只修受影响的 job/资产并保留已验证产物，不重建旧 r1 或无关平台。需要重传时使用来源可核验、同一提交的留存工件；整套测试重跑需重新授权。实际 r1 升级验证与残余风险单独记录，不把 Linux 包查询或构建通过当作实装。
