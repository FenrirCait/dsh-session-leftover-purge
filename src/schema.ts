import z from '@deepseek-ai/schemastery';

/**
 * Editable in Settings → Plugins. Every field is `.volatile()`, which is what
 * puts it in the plugin form and lets an edit take effect without a restart
 * (the Loader hands `apply` live references and commits edits in place).
 *
 * The last three fields are actions, not values: DSH renders schema fields, not
 * buttons, so an action is expressed as "bump this number". The plugin remembers
 * the last number it acted on, which makes each bump fire exactly once.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关；关掉后不清理也不再监听删除').volatile(),
  biliJson: z.boolean().default(true).description('bili JSON 快照').volatile(),
  biliIndexDb: z
    .boolean()
    .default(true)
    .description('bili 索引：行、引用计数、三个 kv blob（写前自动备份）')
    .volatile(),
  costMeterLedger: z.boolean().default(false).description('cost-meter 账本明细行（总额不动）').volatile(),
  costMeterFiles: z.boolean().default(false).description('cost-meter 每轮明细文件').volatile(),
  costMeterReportBackups: z
    .boolean()
    .default(true)
    .description('开机报告里列出 cost-meter 自己的改价备份占用（不删）')
    .volatile(),
  dshContextCache: z.boolean().default(false).description('清理 dsh-context 概览缓存条目（默认只报告）').volatile(),
  archiveProjcache: z
    .boolean()
    .default(false)
    .description('清理 archive-manager 的 projcache 条目（默认只报告）')
    .volatile(),
  dryRun: z.boolean().default(false).description('演练模式：只写日志，不移动也不删除').volatile(),
  trashRetentionDays: z.natural().default(7).description('备份保留天数；0 = 永久保留').volatile(),
  trashMaxMb: z
    .natural()
    .default(2048)
    .description('备份总体积上限（MB）；超出后从最旧批次开始删，0 = 不限')
    .volatile(),
  reconcileOnBoot: z.boolean().default(true).description('启动时扫描孤儿快照并写报告').volatile(),
  sweepGhostKvOnBoot: z
    .boolean()
    .default(true)
    .description('启动时清掉 bili 索引里指向已删会话的残留绑定（含子代理；dryRun 下只报数）')
    .volatile(),
  autoPurgeOrphans: z.boolean().default(false).description('对账发现孤儿就直接清理').volatile(),
  bootDelayMs: z.natural().default(8000).description('开机对账前等待的毫秒数').volatile(),
  vacuumIndexDb: z.boolean().default(false).description('开机回收 index.db 空间（失败不影响数据）').volatile(),
  restoreBackupTrigger: z.natural().default(0).description('填入新数字并保存 = 执行一次恢复').volatile(),
  deleteBackupsTrigger: z.natural().default(0).description('填入新数字并保存 = 删除全部备份').volatile(),
  backupLedgerTrigger: z.natural().default(0).description('填入新数字并保存 = 立即备份账本').volatile(),
});
