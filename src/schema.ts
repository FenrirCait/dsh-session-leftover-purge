import z from '@deepseek-ai/schemastery';

/**
 * Editable in Settings → Plugins. Every field is `.volatile()`, which is what
 * puts it in the plugin form and lets an edit take effect without a restart
 * (the Loader hands `apply` live references and commits edits in place).
 *
 * Descriptions are bilingual on purpose: schemastery descriptions are static
 * strings chosen at module load, so there is no per-locale variant to select —
 * the card itself (`lib/client.js`) is localised through `ctx.locale`, and these
 * strings are the fallback for hosts that render the raw schema.
 *
 * The last three fields are actions, not values: DSH renders schema fields, not
 * buttons, so an action is expressed as "bump this number". The plugin remembers
 * the last number it acted on, which makes each bump fire exactly once.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('总开关 / Master switch；关掉后不清理也不再监听删除 / off: no cleanup, no subscription')
    .volatile(),
  biliJson: z
    .boolean()
    .default(true)
    .description('bili JSON 快照 / bili JSON snapshots')
    .volatile(),
  biliIndexDb: z
    .boolean()
    .default(true)
    .description('bili 索引：行、引用计数、三个 kv blob，写前备份 / bili index: rows, refcounts, three kv blobs; VACUUM INTO backup first')
    .volatile(),
  costMeterLedger: z
    .boolean()
    .default(false)
    .description('cost-meter 账本明细行，总额不动 / cost-meter ledger rows, totals untouched')
    .volatile(),
  costMeterFiles: z
    .boolean()
    .default(false)
    .description('cost-meter 每轮明细文件 / cost-meter per-turn detail files')
    .volatile(),
  costMeterReportBackups: z
    .boolean()
    .default(true)
    .description('开机报告列出 cost-meter 改价备份占用（不删）/ report cost-meter reprice backups, never delete')
    .volatile(),
  dshContextCache: z
    .boolean()
    .default(false)
    .description('清理 dsh-context 概览缓存（默认只报告）/ purge dsh-context overview cache (report only by default)')
    .volatile(),
  archiveProjcache: z
    .boolean()
    .default(false)
    .description('清理 archive-manager projcache（默认只报告）/ purge archive-manager projcache (report only by default)')
    .volatile(),
  dryRun: z
    .boolean()
    .default(false)
    .description('演练模式：只报告，不移动也不删除 / dry run: report only')
    .volatile(),
  trashRetentionDays: z
    .natural()
    .default(7)
    .description('备份保留天数；0 = 永久 / backup retention days; 0 = forever')
    .volatile(),
  trashMaxMb: z
    .natural()
    .default(2048)
    .description('备份总体积上限（MB），超出从最旧批次删；0 = 不限 / backup size cap (MB); 0 = no cap')
    .volatile(),
  reconcileOnBoot: z
    .boolean()
    .default(true)
    .description('启动时扫描孤儿快照族并写报告 / reconcile orphan snapshot families on boot')
    .volatile(),
  sweepGhostKvOnBoot: z
    .boolean()
    .default(true)
    .description('启动时清掉指向已删会话的 kv 绑定（含子代理；dryRun 下只报数）/ sweep stale kv bindings on boot, dry-run aware')
    .volatile(),
  autoPurgeOrphans: z
    .boolean()
    .default(false)
    .description('对账发现孤儿就直接清理 / purge orphans found during reconcile')
    .volatile(),
  bootDelayMs: z
    .natural()
    .default(8000)
    .description('开机对账前等待毫秒数 / delay before the boot pass (ms)')
    .volatile(),
  vacuumIndexDb: z
    .boolean()
    .default(false)
    .description('开机回收 index.db 空间 / reclaim index.db space on boot')
    .volatile(),
  restoreBackupTrigger: z
    .natural()
    .default(0)
    .description('填新数字并保存 = 恢复最近备份 / bump to restore the latest backup')
    .volatile(),
  deleteBackupsTrigger: z
    .natural()
    .default(0)
    .description('填新数字并保存 = 删除全部备份 / bump to delete all backups')
    .volatile(),
  backupLedgerTrigger: z
    .natural()
    .default(0)
    .description('填新数字并保存 = 立即备份账本 / bump to snapshot the ledger now')
    .volatile(),
});
