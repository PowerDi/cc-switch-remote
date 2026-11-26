# Remote 版本身份与迁移策略

## 三个不同的编号

- **上游正式基线**：例如 `4.0.21`，对应官方已发布 tag 的确切 commit，不是上游当下 `main`。
- **Remote 公开版本**：`remote-v<上游基线>-r<Remote修订号>`，例如 `remote-v4.0.21-r1`；UI 显示 **4.0.21 · Remote r1**。`r1` 是 fork revision，不是 semver 预发布。
- **安装版本**：`packageVersion`，只用于 Tauri updater 的 semver 比较、Cargo/package/Tauri 和 MSI 等安装器。在 UI 的安装版本明细展示，不能当作上游版本或推算公开 tag。

唯一机器可读源是根目录 `release-identity.json`。`scripts/release-identity.mjs` 核对身份和四份安装版本；前端直接使用同一份元数据。历史映射的 `remoteRevision: null` 表示旧命名，**不追认旧版本为新命名 r1**。

本次只是能力实现：当前身份为**未发布**的 `remote-v4.0.21-r1`，安装版本暂留 `4.1.0`，`releaseReady=false`。没有发布该 tag，也没有选择下一次安装版本；禁止用已发布过的 `4.1.0` 再发布。

## 已发布版本保持原样

| 历史 fork tag / 安装版本 | 官方基线 | fork 发布 commit |
| --- | --- | --- |
| v4.0.5 / 4.0.5 | v4.0.4 (`a29a4f38`) | `e751681e` |
| v4.0.6 / 4.0.6 | v4.0.4 | `766f27f4` |
| v4.0.7 / 4.0.7 | v4.0.4 | `218135f4` |
| v4.0.8 / 4.0.8 | v4.0.4 | `85bca82e` |
| v4.0.9 / 4.0.9 | v4.0.4 | `ec5b6931` |
| v4.1.0 / 4.1.0 | v4.0.21 (`c4db63c6`) | `ed4353ca` |

所有既有 tag、release、资产名、下载 URL 均不移动、不重命名。更早旧 `vX` 的维护仍直接从**指定历史 tag**取安装版本；未确认的上游基线不猜测。维护新命名 release 时，使用它随资产上传的 `release-identity.json` 快照，不能拿当前源码版本重生成旧 `latest.json`。

## 如何递增

仅 Remote 修复：保持上游版本/commit，下一次公开版本为同基线 `r2`。合入官方正式 `v4.0.40` 后，才改成 `remote-v4.0.40-r1`。本轮没有合入 v4.0.40，也没有接受发布后 upstream main 的提交。

安装版本必须独立选择、严格高于所有已发布安装版本，并符合 MSI 数值范围。已安装 `4.1.0` 不能降成 `4.0.21` 或 `4.0.40`。将发布后的身份与确切 fork commit 归档到 `history`，再开始下一身份；不得改变历史映射来绕过递增检查。

发布校验要求：公开 tag 精确匹配元数据、commit 在 `origin/main` 内且包含记录的官方基线/历史 fork release、官方 API 确认该基线 tag 已正式发布且不是预发布、隔离 ref 中的官方 tag peeled SHA 与 `upstreamCommit` 精确相等、四份安装版本一致、比历史和实际 GitHub stable release 清单严格更新、Remote revision 连续、fork 专属 notes 标明两个版本以及便携版迁移、升级路径记录已验证。`releaseReady` 和 `upgradeValidation` 是人为审核状态，不是构建通过便自动置真的值。

`status: unreleased` 表示源代码准备身份时 GitHub release 尚未发布；发布所用构建通过全部门槛后嵌入 `releaseReady=true`，UI 按正式候选身份显示并使用真实 tag，不依赖发布后改写已打包 JSON。只有 `status: unreleased` **且** `releaseReady=false` 的开发脚手架显示“未发布”并回退发布列表。

## 分支与 tag refs 隔离（操作示例，未在本轮执行）

`main` 是 Remote 产品/发布分支；`upstream-main` 只追踪官方代码，不放 Remote 改动。`xiaoY233/cc-switch-remote` 只是历史起点，不再维护同步分支。

```bash
# 不把官方 tag 混入本 fork 的 refs/tags；目标 ref 明确隔离。
git fetch --no-tags upstream refs/tags/v4.0.40:refs/remotes/upstream/tags/v4.0.40
git rev-parse 'refs/remotes/upstream/tags/v4.0.40^{}'
# 在纯官方跟踪分支上按正式 release 快进；Remote main 的合并另行审核。
git switch upstream-main
git merge --ff-only 'refs/remotes/upstream/tags/v4.0.40^{}'
```

已有官方 v4.0.21 位于 `refs/remotes/upstream/tags/v4.0.21`；旧 v4.0.4 位于 `refs/remotes/upstream/releases/v4.0.4`，均属于隔离 refs，保留旧 ref 不动。新增示例统一使用 `refs/remotes/upstream/tags/<官方tag>`。不要执行会把全部 upstream tags 引入 `refs/tags` 的 fetch。

## 已批准的一次便携版手动迁移

<!-- manual-portable-migration -->

旧 v4.1.0（及使用相同构造器的更早客户端）把 portable 下载地址写死为：

```text
/releases/download/v{安装版本}/CC-Switch-Remote-v{安装版本}-Windows[-arm64]-Portable.zip
```

旧关于页详情链接也写死为 `/releases/tag/v{安装版本}`。仅修改新客户端，无法修复已经安装的这些旧客户端。GitHub 下这两个 URL 不能靠另加索引自然重定向；不假定所有用户先装桥接版。

**用户已接受方案 A**：首次新命名版本发布后，旧便携版用户从 [本 fork 发布页](https://github.com/PowerDi/cc-switch-remote/releases) 手动选对应架构的 Portable.zip，退出旧应用并按原便携版方式替换程序一次；保留数据并先备份。旧版本的详情链接可能失效，请直接访问上述发布页。**不创建新的裸 `v*` 兼容 tag/release**，不改任何历史发布。

正常安装版的旧 Tauri updater 按 `latest.json.version` 比较安装版本、按每个平台的明确 URL 下载；机制上不依赖公开 tag 等于 `v{version}`。endpoint、公钥、产品名、数据目录全部保持不变。但是**尚未实机验证旧安装版 → 新命名版本的正常/数据库恢复更新和一次 portable 迁移**，元数据中的三条 `upgradeValidation` 仍为 `pending`；不能把机制推演称为升级验证通过。

新客户端关于页读取 updater 的 `rawJson.releaseIdentity`，校验安装版本和新命名字段匹配后打开真实 tag。portable 入口打开真实 release 页，让用户明确选择架构；不调用旧 Rust 的安装版本 URL 构造器。身份缺失、无效或未知时回退 fork releases 页，绝不拼出猜测的 `v{packageVersion}`。未发布开发身份也只链接发布列表。

恢复页保留无强制 `AppState` 的 Rust 检查/安装命令，不新增依赖数据库的查询。现有检查只返回安装 semver：已知历史身份按映射显示；未知未来身份明确显示“公开版本身份未知”和安装版本明细，发布页回退仍是本 fork。安装动作继续走 state-free updater。

WhatsNew 的条目是**上游摘要**，只筛到实际基线；不再用安装版本 `4.1.0` 纳入未来上游内容。新 seen 值使用 `upstream:<基线>`；已确认的旧 fork 安装版本 seen 明确映射到其基线，不重写为猜测的 upstream 编号。未知旧 stamp 不能证明已看范围，仅按当前已知基线处理。

## 工作流边界

- `release.yml` 仅新命名 tag 自动发布；人工 dispatch 永远只校验/构建。未 ready 时 tag 在构建 fan-out 前阻断。
- 创建 release 前收齐资产，生成 `latest.json`（安装版本 + 实际 tag URL + 公开身份）并核对各签名 **key id**。key id 匹配**不等于密码学签名验证完成**。
- `release-maintenance.yml` 只维护指定既有 release，保留原 publication date/notes；旧命名与新命名分别解析，不重建其他平台资产。
- `sync-release-notes.yml` 只编辑既有 release，且文件必须是该 tag 的 `*-remote-zh.md`；上游说明不得覆盖 fork release。
- `helper-artifacts.yml` 未改：它会独立构建/更新 `remote-helper-latest`，不是新的桌面 app release。推送本实现将来可能触发 helper 构建（其路径规则覆盖 Rust/build 文件时）或 notes sync，但本轮没有推送或启动任何 workflow。

发布前仍须获得相应授权、递增安装版本、补充新身份路径的聚焦回归覆盖并完成安装用户真实升级路径审核。本说明不是发布授权。
