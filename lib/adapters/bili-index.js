import fs from 'node:fs';
import path from 'node:path';
import { biliSessionsRoot } from '../runtime/paths.js';
import { CONTENT_SOURCES, DELETE_TABLES, familyArgs, familyClause, tableColumns, } from './bili-sql.js';
import { kvMentionsFamily, purgeKvRows } from './bili-kv.js';
export function indexDbPath(root = biliSessionsRoot()) {
    return path.join(root, 'index.db');
}
/**
 * Open bili's index read-write. `node:sqlite` is imported lazily so a host
 * without it still loads the plugin and gets one clear warning instead of a
 * module-level crash.
 */
export async function openIndex(file, readOnly = false) {
    let sqlite;
    try {
        sqlite = await import('node:sqlite');
    }
    catch {
        return undefined;
    }
    try {
        return new sqlite.DatabaseSync(file, readOnly ? { readOnly: true } : {});
    }
    catch {
        return undefined;
    }
}
/** Rows this family still owns, across every table the purge deletes from. */
export function countFamilyRows(db, family) {
    let total = 0;
    for (const table of DELETE_TABLES) {
        const columns = tableColumns(db, table);
        if (!columns.includes('session_id'))
            continue;
        // Pinned checkpoints are bili's GC anchor and survive by design; counting
        // them would make every verify() report a leftover that is meant to be there.
        const where = table === 'checkpoints' && columns.includes('pinned')
            ? `${familyClause('session_id')} AND pinned = 0`
            : familyClause('session_id');
        try {
            const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...familyArgs(family));
            total += Number(row?.n ?? 0);
        }
        catch {
            /* a table this bili version does not have */
        }
    }
    return total;
}
/** One entry per content reference, duplicates included: refcount counts refs. */
export function collectHashes(db, family) {
    const hashes = [];
    for (const source of CONTENT_SOURCES) {
        const columns = tableColumns(db, source.table);
        if (!columns.includes('session_id') || !columns.includes(source.column))
            continue;
        const pinnedAware = source.table === 'checkpoints' && columns.includes('pinned');
        const where = pinnedAware ? `${familyClause('session_id')} AND pinned = 0` : familyClause('session_id');
        try {
            const rows = db.prepare(`SELECT "${source.column}" AS hash FROM "${source.table}" WHERE ${where}`).all(...familyArgs(family));
            for (const row of rows)
                if (typeof row.hash === 'string' && row.hash.length > 0)
                    hashes.push(row.hash);
        }
        catch {
            /* unreadable table: the purge still runs, the sweep keeps the blob */
        }
    }
    return hashes;
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
export async function backupIndexDb(dbFile, batchDir) {
    const fsPromises = fs.promises;
    await fsPromises.mkdir(batchDir, { recursive: true });
    const target = path.join(batchDir, 'index.db');
    try {
        const db = await openIndex(dbFile, true);
        if (db === undefined)
            throw new Error('node:sqlite unavailable');
        try {
            db.exec('PRAGMA busy_timeout = 4000');
            db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        }
        finally {
            try {
                db.close();
            }
            catch {
                /* already closed */
            }
        }
        return { mode: 'vacuum-into', files: [path.basename(target)], bytes: fs.statSync(target).size };
    }
    catch (error) {
        try {
            await fsPromises.rm(target, { force: true });
        }
        catch {
            /* a partial file left behind by the failed VACUUM */
        }
        const copied = [];
        let bytes = 0;
        for (const suffix of ['', '-wal', '-shm']) {
            const source = `${dbFile}${suffix}`;
            if (!fs.existsSync(source))
                continue;
            const destination = path.join(batchDir, `index.db${suffix}`);
            await fsPromises.copyFile(source, destination);
            copied.push(path.basename(destination));
            bytes += fs.statSync(destination).size;
        }
        if (copied.length === 0)
            throw error;
        return { mode: 'file-copy', files: copied, bytes };
    }
}
/**
 * Delete the family in one transaction: rows, content refcounts, the three
 * session-keyed blobs, then the orphan sweep. Mirrors bili's own
 * `deleteSession` and keeps its `pinned` exception.
 */
export function purgeFamily(db, family, deleted) {
    const exec = (sql) => db.exec(sql);
    // Without this, deleted rows stay readable in b-tree pages until a VACUUM,
    // which is opt-in. 1.3.0 set it; the rewrite dropped it (Codex, PR #8).
    exec('PRAGMA secure_delete = ON');
    exec('BEGIN IMMEDIATE');
    try {
        // Hash list and deletes must come from the same snapshot: a writer between
        // the two would leave refcounts that no longer match the rows (Codex, PR #8).
        const hashes = collectHashes(db, family);
        for (const table of DELETE_TABLES) {
            const columns = tableColumns(db, table);
            if (!columns.includes('session_id'))
                continue;
            const where = table === 'checkpoints' && columns.includes('pinned')
                ? `${familyClause('session_id')} AND pinned = 0`
                : familyClause('session_id');
            try {
                const run = db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...familyArgs(family));
                const changes = Number(run.changes ?? 0);
                if (changes > 0)
                    deleted[table] = changes;
            }
            catch (error) {
                deleted[`${table}:error`] = String(error);
            }
        }
        // Release after the rows are gone and before the orphan sweep, so blobs the
        // session owned drop to zero refs and get collected in the same transaction.
        let released = 0;
        try {
            const stmt = db.prepare('UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0');
            for (const hash of hashes) {
                const run = stmt.run(hash);
                if (Number(run.changes ?? 0) > 0)
                    released += 1;
            }
        }
        catch (error) {
            deleted['content:release-error'] = String(error);
        }
        if (released > 0)
            deleted['content:released'] = released;
        purgeKvRows(db, family, deleted);
        try {
            const orphan = db
                .prepare(`DELETE FROM content WHERE refcount <= 0 AND hash NOT IN (
             SELECT content_hash FROM messages
             UNION SELECT summary_hash FROM blocks
             UNION SELECT one_hash FROM blocks WHERE one_hash IS NOT NULL
             UNION SELECT content_hash FROM ccr_entries
             UNION SELECT media_hash FROM message_media
             UNION SELECT state_hash FROM checkpoints
           )`)
                .run();
            const changes = Number(orphan.changes ?? 0);
            if (changes > 0)
                deleted.content = changes;
        }
        catch (error) {
            deleted['content:error'] = String(error);
        }
        exec('COMMIT');
    }
    catch (error) {
        try {
            exec('ROLLBACK');
        }
        catch {
            /* the transaction may already be gone */
        }
        throw error;
    }
}
export function verifyFamily(db, family) {
    return { rows: countFamilyRows(db, family), kvHits: kvMentionsFamily(db, family) };
}
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
export async function vacuumIndex(dbFile, logger) {
    if (!fs.existsSync(dbFile))
        return { ok: false, reason: 'index.db-missing' };
    const db = await openIndex(dbFile);
    if (db === undefined)
        return { ok: false, reason: 'sqlite-unavailable' };
    const exec = (sql) => db.exec(sql);
    const bytesBefore = fs.statSync(dbFile).size;
    try {
        exec('PRAGMA busy_timeout = 4000');
        const pre = db.prepare('PRAGMA integrity_check').get();
        const preVerdict = pre === undefined ? undefined : Object.values(pre)[0];
        if (preVerdict !== 'ok')
            return { ok: false, reason: `integrity-before:${String(preVerdict)}`, bytesBefore };
        exec('VACUUM');
        const post = db.prepare('PRAGMA integrity_check').get();
        const postVerdict = post === undefined ? undefined : Object.values(post)[0];
        if (postVerdict !== 'ok') {
            logger?.warn(`session-leftover-purge: integrity_check failed after VACUUM: ${String(postVerdict)}`);
            return { ok: false, reason: `integrity-after:${String(postVerdict)}`, bytesBefore };
        }
        try {
            exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        catch {
            /* a busy WAL only costs disk, not correctness */
        }
        return { ok: true, bytesBefore, bytesAfter: fs.statSync(dbFile).size };
    }
    catch (error) {
        logger?.warn(`session-leftover-purge: VACUUM skipped (${String(error)})`);
        return { ok: false, reason: `vacuum-failed:${String(error)}`, bytesBefore };
    }
    finally {
        db.close();
    }
}
