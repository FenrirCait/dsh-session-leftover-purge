# dsh-session-leftover-purge

**简体中文** | [English](README.en.md)

删掉一个 DSH 会话后，DSH 自己的记录清干净了，但几个插件各自留着副本：**billion-context** 的快照与
`index.db`、**cost-meter** 的账本明细与每轮凭证、**dsh-context** 的上下文概览缓存、
**archive-manager** 的 projcache。

这个插件订阅 archive-manager 右键删除时发出的 `api-session/removed`，按**会话族**（父会话 + 它的
`session-<父>|sub:<hex>` 子代理）清理这些副本；开机时再做一次对账，找出"DSH 已经没有、插件还留着"的族。

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

四条命令都**不会随版本变化**，直接抄就行。**装完必须完全退出并重新打开 DSH**：host 半侧由 Loader 在
进程启动时装载，运行中新装的包不会挂进当前进程。

## 依赖

**必需**：DeepSeek Harness 本身（`>= 0.2.0-rc.1 < 0.3.0-0`）；运行时 **Node ≥ 22.13 或 ≥ 23.4**
（插件用内置 `node:sqlite` 读写 bili 索引，低于这个版本会打一行 `node:sqlite-unavailable` 并跳过索引部分）。

**配合**（缺了自动跳过，不会加载失败）：

| 组件 | 缺失时的表现 |
|---|---|
| `@michengai/dsh-archive-manager` | 没有「删除会话」入口，只有开机对账 |
| `billion-context` | 快照与索引两项跳过 |
| `dsh-cost-meter` | 账本与明细两项跳过 |
| `dsh-context` | 概览缓存一项跳过（默认也只报告） |

## 使用

装好后不需要任何操作。开关在 **设置 → 插件 → 插件管理 → dsh-session-leftover-purge**，改动即时生效。

| 项目 | 默认 | 说明 |
|---|---|---|
| 总开关 | 开 | 关掉后不清理，也不再监听删除 |
| bili JSON 快照 | 开 | 移走 bili 面板里该族的快照文件 |
| bili 索引 | 开 | 行、内容引用计数、三个会话键控 `kv_store` blob；写前 `VACUUM INTO` 备份 |
| cost-meter 账本明细 | 关 | 只删 `days[*].sessions[]` 里的明细行，总额不动 |
| cost-meter 明细文件 | 关 | 删掉每轮用量凭证（先复制进 trash） |
| cost-meter 改价备份报告 | 开 | 只在开机报告里列出 cost-meter 自己的 `before-reprice` 备份占用，**不删** |
| dsh-context 缓存 | 关 | 清 `overview-cache.v3` 分片里的会话条目（默认只报告） |
| archive-projcache | 关 | 清 `session_projcache` 里带会话 id 的文件（默认只报告） |
| 备份保留天数 | 7 天 | 过期即删；`0` = 永久保留 |
| 备份体积上限 | 2048 MB | 超出后从最旧批次开始删；`0` = 不限 |
| 演练模式 | 关 | 只报告，不移动也不删除（开机清扫同样遵守） |
| 开机对账 | 开 | 扫描孤儿快照族并写 `orphans.json` |
| 开机清理残留绑定 | 开 | 清 `kv_store` 里指向已删会话（含子代理）的条目，抢在 bili lane 启动前 |
| 自动清理孤儿 | 关 | 对账发现孤儿就直接清理 |
| 开机延迟 | 8000 ms | 开机对账前等待多久 |

「恢复最近备份 / 删除全部备份 / 立即备份 cost-meter 账本」三个字段是触发器：**填一个新数字并保存**
执行一次（DSH 的表单没有按钮，只能这样表达动作）。

## 会话存储后端

「这个会话还在不在」是清理前唯一要回答的问题。插件支持三种后端：

| 后端 | 判据 |
|---|---|
| `jsonl` | `$DSH_HOME/sessions/<project>/<session>/` 目录存在 |
| `sqlite` | `<sessions>/sessions.sqlite`，表名与 id 列自动探测 |
| `unknown` | 两者都读不到 |

`unknown` 一律回答"还活着"：**读不到状态时宁可不删**。开机对账在 `unknown` 下连孤儿报告都不出，
只写一行日志——避免 `自动清理孤儿` 拿到一份"全都是孤儿"的名单。

## 备份与恢复

每次清理在 `~/.dsh/storages/session-leftover-purge/trash/<时间戳>/` 留可还原副本：

- `index.db` —— 删行前的完整数据库（`VACUUM INTO` 单文件快照，旧版 SQLite 退回三文件拷贝）
- `session-…__*.json` —— 移走的 bili 快照
- `kv-store.json.bak` —— 开机清扫改写前的 `kv_store` 原始行（后缀不是 `.json`，否则会被当成快照写回 bili 目录）
- `ledger.json` —— 改账本前的完整副本
- `cost-files/`、`cache/`、`projcache/` —— 各适配器改写前的原件

恢复入口是「恢复最近备份」触发器。数据库或账本正被占用时，插件不会强写：改成
`*.restored-<时间戳>` 放在旁边，退出 DSH 后自行替换。

## 日志

`~/.dsh/storages/session-leftover-purge/`：

- `purge.log` —— 每次启动 `ready v…` + `roots state=… bili=… sessions=… store=…`，每次清理/恢复/清扫各一行
- `orphans.json` —— 最近一次对账结果（含 `store` 与 `evidence`）
- `triggers.json` —— 已执行过的触发器数字

## 边界

- 只处理 archive-manager 的右键删除；其它途径靠开机对账。
- 子代理只在父会话被清理时连带处理（DSH 不会为 `|sub:` 子会话单独发事件）。
- bili 的 lane 会把 `kv_store` 从内存写回，所以清扫必须抢在它启动之前；本机已被改过则本轮放弃
  （`changed-during-read`），下次开机再试。
- 插件自己的状态跟 `$DSH_HOME`（可用 `SESSION_LEFTOVER_PURGE_DIR` 覆盖）；bili 的数据目录是用户级的
  （`BILI_SESSIONS_DIR`），不随 profile 隔离。
- bili 的 `index.db` 属于另一个进程：`SQLITE_BUSY` 会跳过，下次再处理。
- 不碰 DSH 附件、不碰 Electron 的 localStorage。
- 任何失败都只写日志，不抛给 DSH 的删除流程。

MIT License.
