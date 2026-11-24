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
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    biliJson: z<boolean, boolean, "volatile-defined">;
    biliIndexDb: z<boolean, boolean, "volatile-defined">;
    costMeterLedger: z<boolean, boolean, "volatile-defined">;
    costMeterFiles: z<boolean, boolean, "volatile-defined">;
    costMeterReportBackups: z<boolean, boolean, "volatile-defined">;
    dshContextCache: z<boolean, boolean, "volatile-defined">;
    archiveProjcache: z<boolean, boolean, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    trashRetentionDays: z<number, number, "volatile-defined">;
    trashMaxMb: z<number, number, "volatile-defined">;
    reconcileOnBoot: z<boolean, boolean, "volatile-defined">;
    sweepGhostKvOnBoot: z<boolean, boolean, "volatile-defined">;
    autoPurgeOrphans: z<boolean, boolean, "volatile-defined">;
    bootDelayMs: z<number, number, "volatile-defined">;
    vacuumIndexDb: z<boolean, boolean, "volatile-defined">;
    restoreBackupTrigger: z<number, number, "volatile-defined">;
    deleteBackupsTrigger: z<number, number, "volatile-defined">;
    backupLedgerTrigger: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    biliJson: z<boolean, boolean, "volatile-defined">;
    biliIndexDb: z<boolean, boolean, "volatile-defined">;
    costMeterLedger: z<boolean, boolean, "volatile-defined">;
    costMeterFiles: z<boolean, boolean, "volatile-defined">;
    costMeterReportBackups: z<boolean, boolean, "volatile-defined">;
    dshContextCache: z<boolean, boolean, "volatile-defined">;
    archiveProjcache: z<boolean, boolean, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    trashRetentionDays: z<number, number, "volatile-defined">;
    trashMaxMb: z<number, number, "volatile-defined">;
    reconcileOnBoot: z<boolean, boolean, "volatile-defined">;
    sweepGhostKvOnBoot: z<boolean, boolean, "volatile-defined">;
    autoPurgeOrphans: z<boolean, boolean, "volatile-defined">;
    bootDelayMs: z<number, number, "volatile-defined">;
    vacuumIndexDb: z<boolean, boolean, "volatile-defined">;
    restoreBackupTrigger: z<number, number, "volatile-defined">;
    deleteBackupsTrigger: z<number, number, "volatile-defined">;
    backupLedgerTrigger: z<number, number, "volatile-defined">;
}>>, "plain">;
