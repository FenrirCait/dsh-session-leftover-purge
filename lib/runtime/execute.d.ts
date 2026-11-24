import type { Adapter, AdapterPlan, AdapterResult, Family, Logger, PluginConfig, SessionStore, VerifyResult } from '../types.js';
export interface AdapterRun {
    adapter: string;
    probed: boolean;
    plan?: AdapterPlan;
    result?: AdapterResult;
    verify?: VerifyResult;
    skipped?: string;
    error?: string;
}
export interface FamilyRun {
    family: Family;
    skipped?: string;
    batchDir?: string;
    adapters: AdapterRun[];
}
export interface PurgeDeps {
    cfg: PluginConfig;
    logger: Logger;
    store: SessionStore;
    adapters: Adapter[];
}
/**
 * Run every adapter for one family: probe → plan → apply → verify.
 *
 * Ordering rules that matter:
 *  - a family the session store still has is never touched (the store answers
 *    "alive" when it cannot read the backend at all, so a broken probe fails
 *    closed);
 *  - `plan()` is read-only, so `dryRun` needs no special adapter code;
 *  - one adapter failing never stops the next one: a broken cost-meter must not
 *    keep bili's leftovers alive.
 */
export declare function purgeFamily(family: Family, deps: PurgeDeps): Promise<FamilyRun>;
export interface OrphanFamily {
    id: string;
    files: string[];
}
export interface ReconcileResult {
    scanned: number;
    orphans: OrphanFamily[];
}
/**
 * Read-only pass: bili snapshots whose session family DSH no longer has.
 *
 * Grouped by family root, because a subagent snapshot (`session-x|sub:y`) is
 * not its own orphan — purging it alone would leave the parent's data behind
 * and the plugin used to report one line per child.
 */
export declare function findOrphanFamilies(store: SessionStore, root?: string): ReconcileResult;
