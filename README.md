# dsh-session-leftover-purge

**简体中文** | [English](README.en.md)

删掉一个会话后，DeepSeek Harness 自己的记录清干净了，但 **billion-context** 的快照和索引、
**cost-meter** 的账本明细还留着。于是 bili 面板里还能看到那条会话，它的正文也还在
`index.db` 里。这个插件订阅 DSH 的 `api-session/removed` 事件，把剩下的部分补完。

## 安装

```bash
# 最省事：从 npm 装最新版，不需要 git，也不需要访问 GitHub
dsh plugin add dsh-session-leftover-purge

# 默认：永远装 main 的最新提交（需要本机有 git）
dsh plugin add github:FenrirCait/dsh-session-leftover-purge

# 需要锁死版本时，把 vX.Y.Z 换成 tags 页里的任意 tag
dsh plugin add github:FenrirCait/dsh-session-leftover-purge#vX.Y.Z

# 不需要 git：永远取最新一版的 tgz
dsh plugin add https://github.com/FenrirCait/dsh-session-leftover-purge/releases/latest/download/dsh-session-leftover-purge.tgz
```

四条命令都**不会随版本变化**，直接抄就行。

第一条走 npm registry，最省事也最稳；中间两条由 pnpm 走 git 协议，目标机器必须有 `git`；
最后一条是普通 HTTPS 下载，只要求能访问
GitHub。每次发版都会同时上传两个附件：带版本号的 `…-X.Y.Z.tgz` 和固定名的
`dsh-session-leftover-purge.tgz`，后者就是 `latest/download/` 指向的那个。

**装完必须完全退出并重新打开 DSH。** host 半侧由 Loader 在进程启动时装载，运行中新装的包
不会挂进当前进程。刷新页面只更新设置页里的表单，不会让清理逻辑生效。

## 依赖

**必需**：DeepSeek Harness 本身（`>= 0.2.0-rc.1 < 0.3.0-0`）。插件不跑常驻服务；它唯一 import
的第三方包 `@deepseek-ai/schemastery` 由宿主提供——在 `peerDependencies` 里声明为 optional，
DSH 自带的 `dsh-settings` 本来就会装它，**不需要额外安装任何东西**。

插件用 Node 内置的 `node:sqlite` 读写 bili 的索引：**Node ≥ 22.13 或 ≥ 23.4** 才能免 flag 加载。
低于这个版本时装得上但 `index.db` 那一半会静默跳过——日志会有一行
`node:sqlite-unavailable node=…`，看到它就知道该升级运行时时了（`engines.node` 同此口径）。

**功能上配合**（缺了不会报错，只是对应能力自动跳过）：

| 组件 | 缺失时的表现 |
|---|---|
| `@michengai/dsh-archive-manager` | 没有「删除会话」入口，也不会触发清理，只能靠开机对账 |
| `billion-context`（bili） | 快照与索引两项跳过，日志记 `bili-sessions-root-missing` |
| `dsh-cost-meter` | 账本与明细文件两项跳过，日志记 `ledger-missing` / `cost-files-root-missing` |

也就是说：装上就能跑，缺谁就少清谁，不会因为别的插件没装而加载失败。

## 使用

装好后不需要任何操作。默认只做两件事：清掉 bili 的 JSON 快照和 `index.db` 里的行。

| 项目 | 默认 | 说明 |
|---|---|---|
| 总开关 | 开 | 关掉后不再清理，也不再监听删除 |
| bili JSON 快照 | 开 | 删掉 bili 面板里该会话的那一条 |
| bili SQLite 索引 | 开 | 删掉 bili 索引里的行；删前自动备份，可回滚 |
| cost-meter 账本明细 | 关 | 只删 cost-meter 账本里的明细行，总额不动 |
| cost-meter 原始明细文件 | 关 | 删掉 cost-meter 每轮用量的凭证文件 |
| 开机回收 index.db 空间 | 关 | 回收已删行占用的空间；失败不影响数据 |
| 备份保留天数 | 7 天 | 过期即删；`0` = 永久保留 |
| 演练模式 | 关 | 只写日志，不移动也不删除 |
| 开机对账 | 开 | 启动时扫描孤儿快照并写报告 |
| 开机清理残留绑定 | 开 | 启动时删掉 `index.db` 里指向已删会话（含其子代理）的三个 `kv_store` blob 条目；写前先备份，演练模式下只报数（须赶在 bili 的 lane 启动之前） |
| 自动清理孤儿 | 关 | 对账发现孤儿就直接清理 |
| 开机延迟 | 8000 ms | 开机对账前等待多久 |

开关在 **设置 → 插件 → 插件管理 → dsh-session-leftover-purge**。改动即时生效，不用重启。

「恢复最近备份 / 删除全部备份 / 立即备份 cost-meter 账本」三个字段是触发器：**填入一个新数字
并保存**就执行一次（DSH 的表单没有按钮，只能这样表达动作）。

## bili 索引里究竟删了什么

`index.db` 不是一张表，删干净一个会话要同时处理四类引用：

- **行**：`messages` / `message_media` / `refs` / `blocks` / `dead_refs` / `checkpoints`
  （只删非 pinned 的）/ `ccr_entries` / `session_ext` / `conversations` / `sessions`
- **`content` 的引用计数**：每个被删掉的 `content_hash` / `media_hash` / `summary_hash` /
  `one_hash` / `state_hash` 都要把 `refcount` 减一。不减的话 blob 永远停在 `refcount > 0`，
  孤儿清扫永远看不到它——真实环境里就是这么攒出几百行「没人引用但删不掉」的泄漏
- **JSON blob**：`kv_store` 里有三个 blob 用会话 id 做键——`plugin-conversations/table`、
  `prefix-affinity/v1`、`session-order/v1`（bili 启动时会把它回放进 skeleton 缓存）。按
  `session_id` 列删表的做法碰不到它们，会留下一条面板看不见的绑定
- **子代理伪会话**：bili 把子代理存成独立会话 `session-<父>|sub:<hex>`。它自己的
  `deleteSession` 只按精确 id 删，DSH 的删除事件也只发父会话，所以这一整类以前会永久留下。
  现在删一个父会话会连带它的全部 `|sub:` 子会话：行、内容引用、三个 blob 条目、快照文件

最后一项有个时序坑：bili 的 lane 进程把整张会话表放在内存里，**每处理一个请求就整表覆盖一次
`kv_store`**。所以删除当时清掉的绑定，几秒后会被写回内存里的旧值。真正有效的窗口是
**lane 启动之前**——开机清扫就是抢这个窗口：删掉指向不存在会话的绑定，lane 起来时读到的
已经是干净的表。

## 备份与恢复

每次清理都在 `~/.dsh/storages/session-leftover-purge/trash/<时间戳>/` 留一份可还原的副本：

- `index.db` / `index.db-wal` / `index.db-shm` —— 删行前的完整数据库
- `session-…__*.json` —— 移走的 bili 快照
- `kv-store.json.bak` —— 开机清扫改写前的 `kv_store` 原始行（后缀不是 `.json`，否则「恢复最近备份」会把它当成快照写回 bili 目录）
- `ledger.json` —— 改账本前的完整副本（如果动过账本）
- `cost-files/` —— 删掉的 cost-meter 明细文件

恢复入口就是上面那个「恢复最近备份」触发器。恢复时如果 bili 正持有数据库锁，会把文件写成
`index.db.restored-<时间戳>*` 让你手动换，不会强行覆盖。

## 日志

`~/.dsh/storages/session-leftover-purge/`：

- `purge.log` —— 每次启动一行 `ready v…`，每次清理 / 恢复 / 删备份各一行
- `orphans.json` —— 最近一次对账结果
- `triggers.json` —— 已执行过的触发器数字

## 边界

- 只处理通过 archive-manager 删除会话的场景；其它途径靠开机对账发现。
- 子代理只在父会话被清理或对账时连带处理：DSH 不会为 `|sub:` 子会话单独发事件。
- 开机清扫要抢在 bili 的 lane 启动之前。lane 已在写时本轮放弃（日志 `changed-during-read`），
  下次开机再试；写前必留 `kv-store.json.bak`。
- 插件状态目录跟 `$DSH_HOME` 走（未设时是 `~/.dsh`），但 bili 的数据目录是用户级的
  （`~/.local/share/billion-context/sessions` 或 `BILI_SESSIONS_DIR`），不随 profile 隔离。
- bili 的 `index.db` 属于另一个进程，遇到 `SQLITE_BUSY` 会跳过，下次再处理。
- 不碰 DSH 的附件、不碰 Electron 的 localStorage。
- 任何失败都只写日志，不抛给 DSH 的删除流程。

MIT License.
