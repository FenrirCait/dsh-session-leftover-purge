import type { Family, PlanItem } from '../types.js';
/**
 * Read the session id out of a snapshot file without parsing it.
 *
 * The old scan called `JSON.parse` on every file — 131 files / 80 MB on this
 * machine, ~384 ms per boot — to look at one field. A snapshot's `id` sits in
 * the first object of the file, so 8 KB of head plus a regex is enough for the
 * common case; only a file whose id is not in that window falls back to a full
 * parse, and the fallback is bounded by `MAX_JSON_BYTES`.
 */
export declare function readSnapshotId(file: string): string | undefined;
/** Every `<root>/<protocol>/*.json` snapshot file. */
export declare function listSnapshotFiles(root?: string): string[];
export interface SnapshotHit {
    file: string;
    id: string;
    bytes: number;
}
/** Snapshot files that belong to this family, with the id that matched. */
export declare function findFamilySnapshots(family: Family, root?: string): SnapshotHit[];
export declare function snapshotPlanItems(hits: SnapshotHit[], reportOnly: boolean): PlanItem[];
/**
 * Move a snapshot into the batch. `rename` first (same volume, atomic); the
 * copy+unlink fallback exists because the batch directory can sit on another
 * drive, and a half-moved file must never be left behind.
 */
export declare function moveSnapshot(file: string, sessionId: string, batchDir: string): Promise<string>;
/** Remaining snapshot files for a family — used by verify(). */
export declare function remainingSnapshots(family: Family, root?: string): string[];
