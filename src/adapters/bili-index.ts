import fs from 'node:fs';
import path from 'node:path';

import type { Family } from '../types.js';
import { biliSessionsRoot } from '../runtime/paths.js';
import {
  CONTENT_SOURCES,
  DELETE_TABLES,
  familyArgs,
  familyClause,
  tableColumns,
  type Sql,
} from './bili-sql.js';
import { kvMentionsFamily, purgeKvRows } from './bili-kv.js';

export type DeletedCounts = Record<string, number | string>;

export function indexDbPath(root: string = biliSessionsRoot()): string {
  return path.join(root, 'index.db');
}

/**
 * Open bili's index read-write. `node:sqlite` is imported lazily so a host
 * without it still loads the plugin and gets one clear warning instead of a
 * module-level crash.
 */
export async function openIndex(file: string, readOnly = false): Promise<Sql | undefined> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return undefined;
  }
  try {
    return new sqlite.DatabaseSync(file, readOnly ? { readOnly: true } : {});
  } catch {
    return undefined;
  }
}

/** Rows this family still owns, across every table the purge deletes from. */
export function countFamilyRows(db: Sql, family: Family): number {
  let total = 0;
  for (const table of DELETE_TABLES) {
    const columns = tableColumns(db, table);
    if (!columns.includes('session_id')) continue;
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${familyClause('session_id')}`).get(...familyArgs(family)) as
        | { n?: unknown }
        | undefined;
      total += Number(row?.n ?? 0);
    } catch {
      /* a table this bili version does not have */
    }
  }
  return total;
}

/** One entry per content reference, duplicates included: refcount counts refs. */
export function collectHashes(db: Sql, family: Family): string[] {
  const hashes: string[] = [];
  for (const source of CONTENT_SOURCES) {
    const columns = tableColumns(db, source.table);
    if (!columns.includes('session_id') || !columns.includes(source.column)) continue;
    const pinnedAware = source.table === 'checkpoints' && columns.includes('pinned');
    const where = pinnedAware ? `${familyClause('session_id')} AND pinned = 0` : familyClause('session_id');
    try {
      const rows = db.prepare(`SELECT "${source.column}" AS hash FROM "${source.table}" WHERE ${where}`).all(
        ...familyArgs(family),
      ) as Array<{ hash?: unknown }>;
      for (const row of rows) if (typeof row.hash === 'string' && row.hash.length > 0) hashes.push(row.hash);
    } catch {
      /* unreadable table: the purge still runs, the sweep keeps the blob */
    }
  }
  return hashes;
}

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
export async function backupIndexDb(dbFile: string, batchDir: string): Promise<BackupResult> {
  const fsPromises = fs.promises;
  await fsPromises.mkdir(batchDir, { recursive: true });
  const target = path.join(batchDir, 'index.db');
  try {
    const db = await openIndex(dbFile, true);
    if (db === undefined) throw new Error('node:sqlite unavailable');
    try {
      (db as unknown as { exec(sql: string): void }).exec('PRAGMA busy_timeout = 4000');
      (db as unknown as { exec(sql: string): void }).exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    return { mode: 'vacuum-into', files: [path.basename(target)], bytes: fs.statSync(target).size };
  } catch (error) {
    try {
      await fsPromises.rm(target, { force: true });
    } catch {
      /* a partial file left behind by the failed VACUUM */
    }
    const copied: string[] = [];
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${dbFile}${suffix}`;
      if (!fs.existsSync(source)) continue;
      const destination = path.join(batchDir, `index.db${suffix}`);
      await fsPromises.copyFile(source, destination);
      copied.push(path.basename(destination));
      bytes += fs.statSync(destination).size;
    }
    if (copied.length === 0) throw error;
    return { mode: 'file-copy', files: copied, bytes };
  }
}

/**
 * Delete the family in one transaction: rows, content refcounts, the three
 * session-keyed blobs, then the orphan sweep. Mirrors bili's own
 * `deleteSession` and keeps its `pinned` exception.
 */
export function purgeFamily(db: Sql, family: Family, deleted: DeletedCounts): void {
  const exec = (sql: string): void => (db as unknown as { exec(sql: string): void }).exec(sql);

  const hashes = collectHashes(db, family);
  exec('BEGIN IMMEDIATE');
  try {
    for (const table of DELETE_TABLES) {
      const columns = tableColumns(db, table);
      if (!columns.includes('session_id')) continue;
      const where =
        table === 'checkpoints' && columns.includes('pinned')
          ? `${familyClause('session_id')} AND pinned = 0`
          : familyClause('session_id');
      try {
        const run = db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...familyArgs(family)) as { changes?: unknown };
        const changes = Number(run.changes ?? 0);
        if (changes > 0) deleted[table] = changes;
      } catch (error) {
        deleted[`${table}:error`] = String(error);
      }
    }

    // Release after the rows are gone and before the orphan sweep, so blobs the
    // session owned drop to zero refs and get collected in the same transaction.
    let released = 0;
    try {
      const stmt = db.prepare('UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0');
      for (const hash of hashes) {
        const run = stmt.run(hash) as { changes?: unknown };
        if (Number(run.changes ?? 0) > 0) released += 1;
      }
    } catch (error) {
      deleted['content:release-error'] = String(error);
    }
    if (released > 0) deleted['content:released'] = released;

    purgeKvRows(db, family, deleted);

    try {
      const orphan = db
        .prepare(
          `DELETE FROM content WHERE refcount <= 0 AND hash NOT IN (
             SELECT content_hash FROM messages
             UNION SELECT summary_hash FROM blocks
             UNION SELECT one_hash FROM blocks WHERE one_hash IS NOT NULL
             UNION SELECT content_hash FROM ccr_entries
             UNION SELECT media_hash FROM message_media
             UNION SELECT state_hash FROM checkpoints
           )`,
        )
        .run() as { changes?: unknown };
      const changes = Number(orphan.changes ?? 0);
      if (changes > 0) deleted.content = changes;
    } catch (error) {
      deleted['content:error'] = String(error);
    }

    exec('COMMIT');
  } catch (error) {
    try {
      exec('ROLLBACK');
    } catch {
      /* the transaction may already be gone */
    }
    throw error;
  }
}

export interface FamilyVerify {
  rows: number;
  kvHits: string[];
}

export function verifyFamily(db: Sql, family: Family): FamilyVerify {
  return { rows: countFamilyRows(db, family), kvHits: kvMentionsFamily(db, family) };
}
