# CC Switch Remote 4.0.21 · Remote r1（未发布草稿）

公开身份：`remote-v4.0.21-r1`。上游正式基线：`v4.0.21`（`c4db63c60d2a1ddcb4bd9f81152b9c6126413659`）。`r1` 是 Remote 修订号，不是预发布版本。

本轮仅实现版本身份管理，**不是发布准备**：安装版本暂留 `4.1.0`，与已发布历史版本相同，不能复用发布；下一次安装版本尚未选择，`releaseReady=false`，升级验证仍未完成。本草稿不表示该公开 tag 已存在。

## 新命名

UI 主版本按上游基线 + Remote revision 展示，安装 semver 另列明细。公开 tag、资产 URL、安装版本和上游摘要筛选不再相互推算；历史 `v4.0.5` 至 `v4.1.0` 及更早发布保持原样。

## 旧便携版需一次手动迁移（已批准）

<!-- manual-portable-migration -->

首次新命名版本正式发布后，已安装旧 v4.1.0 等硬编码旧 URL 的 **Windows 便携版**用户，请从 [CC Switch Remote 发布页](https://github.com/PowerDi/cc-switch-remote/releases) 手动选对应架构的 `CC-Switch-Remote-remote-v4.0.21-r1-Windows[-arm64]-Portable.zip`，备份数据、退出旧应用，再按原便携版方式替换程序一次。

旧 portable 按安装版本构造 `/download/v{version}/...`，旧关于页详情按 `/tag/v{version}` 构造；新公开 tag 不再是裸 `v{安装版本}`。新客户端无法追溯修复已安装旧客户端的这两个链接；旧详情链接可能失效，请直接打开上述 fork 发布页。**不会新建裸 `v*` 兼容 tag/release，也不会移动历史 tag。**

正常安装版保持既有 updater endpoint 和公钥，`latest.json.version` 仍是严格递增的安装版本，资产 URL 使用真实新 tag。机制上支持跨命名下载，但旧安装版的正常更新、数据库恢复更新和本次一次手动迁移**均未实机验证**，不能声称升级验证已通过。

新客户端 portable 更新打开实际 release 页选择架构；更新身份未知时只回退 fork 发布页，不猜测版本链接。

详细策略见 [Remote 版本身份与迁移策略](../remote-version-policy.md)。正式发布前必须明确新的安装版本并更新本草稿，不得直接发布当前 `4.1.0` 安装版本。
