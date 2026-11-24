import type { Logger, PluginConfig } from '../types.js';
export declare function logLine(line: string): Promise<void>;
export interface Batch {
    name: string;
    dir: string;
    files: string[];
    bytes: number;
}
/** Newest first. Batch names are ISO timestamps, so name order is time order. */
export declare function listBatches(): Batch[];
/**
 * Drop batches that are too old, then batches that make the trash too big.
 *
 * A batch holds a full copy of what was deleted — for bili that is the whole
 * conversation and, for the index, the whole database. `trashRetentionDays: 0`
 * disables the age rule but the size cap still applies; set both to 0 to keep
 * everything. Oldest goes first either way.
 */
export declare function sweepTrash(cfg: PluginConfig, logger?: Logger): Promise<{
    removed: number;
    expired: number;
    trimmed: number;
    bytes: number;
    bytesAfter: number;
}>;
/** Delete every batch. Irreversible; only wired to the explicit trigger. */
export declare function deleteAllBatches(logger?: Logger): Promise<{
    removed: number;
    failed: string[];
}>;
/**
 * Re-apply a kv restore at boot, before bili's lane can start.
 * Returns `none` when there is nothing pending.
 */
export declare function applyPendingKvRestore(): Promise<string>;
/**
 * Put renamed-aside files back. The target may be a *partial* copy left by a
 * failed `copyFile`, so it is removed first: an existing file does not mean the
 * copy succeeded (Codex, PR #10).
 */
export declare function restoreAsides(moved: Array<{
    live: string;
    aside: string;
}>): Promise<void>;
/**
 * Put the newest batch back.
 *
 * The rule everywhere is the same: never overwrite a file some other process is
 * actively using. A locked database or ledger is *staged* next to the live file
 * as `*.restored-<stamp>` and the caller is told to swap it after quitting DSH.
 */
export declare function restoreLatest(logger?: Logger): Promise<{
    ok: boolean;
    reason?: string;
    batch?: string;
    snapshots?: number;
    database?: string;
    ledger?: string;
    costFiles?: number;
    kv?: string;
    caches?: number;
}>;
