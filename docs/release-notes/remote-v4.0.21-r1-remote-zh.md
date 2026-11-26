# CC Switch Remote 4.0.21 · Remote r1

- 公开 tag：`remote-v4.0.21-r1`
- 应用 / Cargo / Tauri / updater 版本：`4.0.21-remote.1`
- 上游正式基线：`v4.0.21`，commit `c4db63c60d2a1ddcb4bd9f81152b9c6126413659`
- 本轮没有合并新的上游版本，数据库 schema 继续为 **23**。

## 版本规则与一次手动重新安装

<!-- manual-client-reinstall -->

今后所有应用版本均由上游主版本和 Remote 修订号派生：`4.0.21-remote.1` → `4.0.21-remote.2`；未来合入官方新基线后才进入例如 `4.0.40-remote.1`。UI 显示 **4.0.21 · Remote r1**，公开 tag 使用 `remote-v4.0.21-r1`。不再使用独立的 `4.1.1` 安装序列，不使用不参与排序的 `+remote.N`，也不创建新的裸 `v*` tag。

`-remote.1` 在 SemVer 语法上属于 prerelease，但这是本 fork 的 **GitHub stable release（prerelease=false）**，不是上游官方预发布。历史 fork `v4.0.5`—`v4.1.0` 的 tag、资产和链接保持原样。

**旧客户端需要一次手动重新安装，不仅是便携版。** 已安装的 `4.1.0` 按正常 SemVer 比较不会把 `4.0.21-remote.1` 当作更新；旧“关于”页和数据库恢复页的自动检查均不能完成这次版本序列切换。请直接使用 [本 fork 发布页](https://github.com/PowerDi/cc-switch-remote/releases)，不要反复点更新或修改 updater 公钥/endpoint。

1. 退出旧客户端及正在运行的开发版本。先备份完整 `~/.cc-switch-remote`、其数据库/备份文件、应用 `app_paths.json` 或自定义配置目录；若设置过覆盖目录，也备份该目录。Windows 用实际用户目录，不用 Git Bash 的另一个 HOME。
2. 下载下方对应平台包。Windows 安装版重新运行 MSI；若系统不允许直接替换，卸载旧**应用程序**后安装新 MSI，保留已备份的数据。便携版解压到新目录并完整保留 askpass 组件。macOS 退出后替换 `.app`；Linux 按使用的 AppImage / deb / rpm 方式手动替换，发行版包管理器可能需要明确确认版本降低。不要复制覆盖官方 CC Switch 数据目录。
3. 本版仍支持 schema 23，**不要降低或删除数据库版本来迁就版本号**。若数据库比 23 更新，保留原文件并停止；仅重新安装程序并不能降级数据库。开发数据目录仍隔离在 `~/.cc-switch-remote-dev`。
4. 首次打开后核对 **4.0.21 · Remote r1 / 4.0.21-remote.1**、连接配置和实际数据目录。新方案以后由完整 SemVer 排序，r1 → r2 和新基线 → r1 的比较契约已有定向测试；并不代表这些真实安装路径已经实机验证。

## SSH 与 Helper 安全修复

- SSH 一次性命令使用真正的执行 deadline；上传 stdin 与 stdout/stderr 同时处理，避免大文件管道死锁。超时请求终止并回收本机 SSH，不再仅停止等待；本机回收不证明远端操作已经停止。
- 测试先确认 SSH/认证，再区分 Helper 未安装、存在但不可执行、执行失败和协议错误。支持 PATH 名、`~/`、空格及非 ASCII 路径；不再隐式重复连接测试。
- 主机页和设置页区分 SSH、Helper **元信息可读取**、实际管理会话。metadata 成功不保证真实数据库或运行态可用，也不声称已建立长连接。
- 切换主机、编辑同一 profile 的地址/凭据时，旧检查或安装结果不再污染新页面、错误提示或 busy 状态。安装完成也不会关闭同 ID 新连接的 session。
- GUI 与独立安装脚本共用锁、同目录 staging、校验和原子替换。下载、上传、校验及提交前失败保留旧 binary/权限和运行会话。
- **仅确认远端下载失败**才尝试桌面共享出站代理下载并通过 SSH 上传；认证、host-key、权限、不支持平台、校验错误不会盲目 fallback。超时、提交后回执丢失等“不确定”结果不自动重试或删锁，请先检查远端阶段/版本。
- 新 Helper `status` 在配置/数据库/迁移初始化之前返回元信息。旧 Helper 探测与安装校验使用清理环境和临时 HOME，避免为了测试而迁移真实数据库。这是已知 helper 的配置隔离，不是任意二进制安全沙箱。
- Windows portable 缺少 `cc-switch-remote-askpass.exe` 会阻止打包发布，不再交付缺密码认证组件的包。

## 下载文件

发布资产前缀均为 `CC-Switch-Remote-remote-v4.0.21-r1-`：

| 平台 | 文件后缀 |
| --- | --- |
| Windows x64 | `Windows.msi`、`Windows-Portable.zip` |
| macOS universal（Intel / Apple Silicon） | `macOS.dmg`、`macOS.zip`、updater 用 `macOS.tar.gz` |
| Linux x86_64 | `Linux-x86_64.AppImage`、`.deb`、`.rpm` |
| Linux arm64 | `Linux-arm64.AppImage`、`.deb`、`.rpm` |

本轮工作流**不提供 Windows ARM64 原生包**。Updater 工件同时附带 `.sig`；`latest.json` 只使用本 fork 实际 URL 与签名链。MSI/macOS 系统包壳要求的数字版本为 `4.0.21`，不改变应用内部 `4.0.21-remote.1`。

Helper 由独立工作流更新 `remote-helper-latest`；它不是第二个桌面 release。Helper 安装仍需用户明确触发，不会因打开页面自动重装。

## 验证范围与限制

连接、事务安装、跨目标异步、metadata 无 DB 写入、版本派生/排序和发布边界已有临时夹具定向回归；没有声称 Windows 密码 SSH、实际远端安装、MSI/macOS/Linux 安装及旧客户端迁移已经实机通过。跨平台产物仍须在发布流程核对，Linux 构建会用 `rpm -qp` / `rpm.vercmp`、`dpkg-deb` / `dpkg --compare-versions` 查询和比较产物，不执行系统安装。没有本轮数据库 schema 迁移。

发布准备的阻断状态与契约证据见 [Remote 版本策略](../remote-version-policy.md)；`releaseReady` 不能代替真实产物或安装验证。
