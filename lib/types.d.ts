/**
 * The contract every cleanup target implements.
 *
 * Three rules shape this file:
 *  - an adapter never decides *whether* to act (the runtime does), it only
 *    describes what it would do (`plan`) and then does exactly that (`apply`);
 *  - `plan()` is read-only, so `dryRun` and the settings preview share one code
 *    path with the real run;
 *  - nothing here knows about Cordis. `src/index.ts` is the only place that does.
 */
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
}
/** A DSH session plus every subagent pseudo-session bili derived from it. */
export interface Family {
    id: string;
    /** `session-<id>|sub:<hex>` ids owned by this session, sorted, parent excluded. */
    children: string[];
}
export type AdapterId = 'bili' | 'cost-meter' | 'dsh-context' | 'archive-projcache';
export interface Probe {
    available: boolean;
    /** Resolved root the adapter would touch — logged and asserted in tests. */
    root?: string;
    /** Version string when it is cheap to read; never used as a gate. */
    version?: string;
    /** What was found and what was missing, in one line. */
    evidence: string;
    /** Named capabilities: snapshots, indexRows, kvBlobs, ledger, details, cache, … */
    capabilities: string[];
}
export type Risk = 'low' | 'medium' | 'high';
export interface PlanItem {
    /** Stable id for logs and dedupe: `snapshot:<path>`, `kv:<ns>/<key>`, … */
    key: string;
    /** Machine-readable kind: snapshot | index-rows | kv-entry | ledger-row | detail-file | cache-entry. */
    kind: string;
    /** Absolute path, table name, or `namespace/key`. */
    target: string;
    bytes?: number;
    rows?: number;
    risk: Risk;
    /** Reported, never applied — the "look but do not touch" switch. */
    reportOnly?: boolean;
}
export interface AdapterPlan {
    adapter: AdapterId;
    /** The family this plan was built for; `apply()` gets it back. */
    family: Family;
    items: PlanItem[];
    /** Free-form lines shown in the dry-run report. */
    notes: string[];
    /** Items that would actually be written; 0 means apply() is a no-op. */
    writes: number;
}
export interface ApplyOptions {
    cfg: PluginConfig;
    dryRun: boolean;
    /** Batch directory created by the runtime before apply(). */
    batchDir: string;
    logger: Logger;
}
export interface ItemOutcome {
    key: string;
    status: 'done' | 'skipped' | 'failed' | 'reported';
    detail?: string;
    /** Why it was skipped; surfaced so the next run can retry. */
    reason?: string;
}
export interface AdapterResult {
    adapter: AdapterId;
    outcomes: ItemOutcome[];
    /** Bytes freed, best effort. */
    freed?: number;
    /** Backup path that makes this apply reversible. */
    backup?: string;
    /** Set when the adapter could not run at all. */
    error?: string;
}
export interface VerifyResult {
    adapter: AdapterId;
    ok: boolean;
    /** What is still present for this family. */
    remaining: PlanItem[];
    evidence: string;
}
export interface Adapter {
    readonly id: AdapterId;
    probe(): Promise<Probe>;
    plan(family: Family, cfg: PluginConfig): Promise<AdapterPlan>;
    apply(plan: AdapterPlan, opts: ApplyOptions): Promise<AdapterResult>;
    verify(family: Family): Promise<VerifyResult>;
}
/** Runtime configuration, with every default resolved. */
export interface PluginConfig {
    enabled: boolean;
    biliJson: boolean;
    biliIndexDb: boolean;
    costMeterLedger: boolean;
    costMeterFiles: boolean;
    /** Report cost-meter's own reprice backups (never deletes them). */
    costMeterReportBackups: boolean;
    /** Purge dsh-context overview-cache entries (default: report only). */
    dshContextCache: boolean;
    /** Purge archive-manager projcache entries (default: report only). */
    archiveProjcache: boolean;
    dryRun: boolean;
    trashRetentionDays: number;
    trashMaxMb: number;
    reconcileOnBoot: boolean;
    autoPurgeOrphans: boolean;
    bootDelayMs: number;
    sweepGhostKvOnBoot: boolean;
    vacuumIndexDb: boolean;
    restoreBackupTrigger: number;
    deleteBackupsTrigger: number;
    backupLedgerTrigger: number;
}
/** How a session is still represented on disk today. */
export type StoreKind = 'jsonl' | 'sqlite' | 'unknown';
export interface StoreProbe {
    kind: StoreKind;
    root: string;
    evidence: string;
}
/**
 * "Does this session still exist?" — the single question the rest of the plugin
 * asks before it deletes anything.
 *
 * `unknown` is a first-class answer: when the storage backend cannot be read,
 * callers must treat every session as alive rather than purge on a guess.
 */
export interface SessionStore {
    probe(): StoreProbe;
    /** Ids still stored, or `null` when the backend could not be read. */
    liveIds(): Set<string> | null;
    /** True when the session (or an unreadable backend) may still own data. */
    has(sessionId: string): boolean;
}
