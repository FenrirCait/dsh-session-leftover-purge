import type { Family } from '../types.js';
import { type Sql } from './bili-sql.js';
export type DeletedCounts = Record<string, number | string>;
export declare function indexDbPath(root?: string): string;
/**
 * Open bili's index read-write. `node:sqlite` is imported lazily so a host
 * without it still loads the plugin and gets one clear warning instead of a
 * module-level crash.
 */
export declare function openIndex(file: string, readOnly?: boolean): Promise<Sql | undefined>;
/** Rows this family still owns, across every table the purge deletes from. */
export declare function countFamilyRows(db: Sql, family: Family): number;
/** One entry per content reference, duplicates included: refcount counts refs. */
export declare function collectHashes(db: Sql, family: Family): string[];
export interface BackupResult {
    mode: 'vacuum-into' | 'file-copy';
    files: string[];
    bytes: number;
}
/**
 * Snapshot the index into the batch before a single row is touched.
 *
 * `VACUUM INTO` reads one consistent snapshot through the WAL and writes a
 * compact single file: smaller than a raw copy (free pages dropped) and safer
 * than copying `index.db` + `-wal` + `-shm` by hand, where a stale sidecar can
 * be replayed against a different main file. Older SQLite builds fall back to
 * the byte copy.
 */
export declare function backupIndexDb(dbFile: string, batchDir: string): Promise<BackupResult>;
/**
 * Delete the family in one transaction: rows, content refcounts, the three
 * session-keyed blobs, then the orphan sweep. Mirrors bili's own
 * `deleteSession` and keeps its `pinned` exception.
 */
export declare function purgeFamily(db: Sql, family: Family, deleted: DeletedCounts): void;
export interface FamilyVerify {
    rows: number;
    kvHits: string[];
}
export declare function verifyFamily(db: Sql, family: Family): FamilyVerify;
/**
 * Reclaim the space deleted rows leave behind.
 *
 * `DELETE` only marks pages free; the old bytes stay in the file and the WAL,
 * which is why a plain grep still finds a removed session id. VACUUM rewrites
 * the file and `wal_checkpoint(TRUNCATE)` empties the journalled copy. This
 * takes an exclusive lock on another process's database, so it runs once per
 * boot, after an integrity check: vacuuming an already-damaged database can
 * turn a readable file into a broken one.
 */
export declare function vacuumIndex(dbFile: string, logger?: {
    warn(message: string): void;
}): Promise<{
    ok: boolean;
    reason?: string;
    bytesBefore?: number;
    bytesAfter?: number;
}>;
