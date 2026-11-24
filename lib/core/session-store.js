import fs from 'node:fs';
import path from 'node:path';
import { dshSessionsRoot } from '../runtime/paths.js';
/**
 * "Does this session still exist?" — asked before any adapter deletes anything.
 *
 * Historically the answer was "is there a directory under
 * `~/.dsh/sessions/<project>/<session>/`". That assumption quietly breaks once
 * DSH gains a SQLite persistence backend: `sessions.sqlite` exists, no JSONL
 * directories do, and a directory probe calls every living session dead — which
 * is exactly how an "orphan cleanup" turns into a mass delete.
 *
 * So the probe has three answers, and `unknown` is a real one:
 *   - `jsonl`   — directories under the sessions root (0.2.x default)
 *   - `sqlite`  — `<sessions root>/sessions.sqlite`, table/column discovered
 *   - `unknown` — neither readable; callers must assume every session is alive
 */
const ID_COLUMNS = ['session_id', 'sessionId', 'id'];
function listDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
/** Session ids under `<root>/<project>/<session>` (jsonl backend). */
function jsonlSessionIds(root) {
    const ids = new Set();
    for (const workspace of listDirs(root)) {
        if (!workspace.isDirectory())
            continue;
        for (const session of listDirs(path.join(root, workspace.name))) {
            if (session.isDirectory())
                ids.add(session.name);
        }
    }
    return ids;
}
/** First table/column pair that looks like a session registry. */
function discoverSessionTable(db) {
    let tables = [];
    try {
        tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
            .map((row) => row.name)
            .filter((name) => typeof name === 'string');
    }
    catch {
        return {};
    }
    // A table literally called `sessions` wins; otherwise the first one carrying
    // an id-shaped column, so a future rename does not silently disable the probe.
    const ordered = [
        ...tables.filter((name) => /^sessions?$/i.test(name)),
        ...tables.filter((name) => !/^sessions?$/i.test(name)),
    ];
    for (const table of ordered) {
        let columns = [];
        try {
            columns = db.prepare(`PRAGMA table_info("${table}")`).all()
                .map((row) => row.name)
                .filter((name) => typeof name === 'string');
        }
        catch {
            continue;
        }
        const column = ID_COLUMNS.find((candidate) => columns.includes(candidate));
        if (column !== undefined)
            return { table, column };
    }
    return {};
}
async function readSqliteIds(file) {
    let sqlite;
    try {
        sqlite = await import('node:sqlite');
    }
    catch {
        return undefined;
    }
    let db;
    try {
        db = new sqlite.DatabaseSync(file, { readOnly: true });
    }
    catch {
        return undefined;
    }
    try {
        const { table, column } = discoverSessionTable(db);
        if (table === undefined || column === undefined)
            return undefined;
        const ids = new Set();
        for (const row of db.prepare(`SELECT "${column}" AS id FROM "${table}"`).all()) {
            if (typeof row.id === 'string' && row.id.length > 0)
                ids.add(row.id);
        }
        return ids.size > 0 ? ids : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        try {
            db.close();
        }
        catch {
            /* already closed */
        }
    }
}
function storeOf(probe, ids) {
    return {
        probe: () => probe,
        liveIds: () => ids,
        has: (sessionId) => ids.has(sessionId),
    };
}
/**
 * `unknown` deliberately answers "alive" for every id: the only thing worse
 * than leaving a leftover behind is deleting a session that still exists.
 */
function unknownStore(root, evidence) {
    const probe = { kind: 'unknown', root, evidence };
    return { probe: () => probe, liveIds: () => null, has: () => true };
}
/**
 * Resolve the backend once and cache the id set. Every caller asks the same
 * question during one boot pass, and the answer cannot change while DSH runs.
 */
export async function loadSessionStore(root = dshSessionsRoot()) {
    const sqlitePath = path.join(root, 'sessions.sqlite');
    if (fs.existsSync(sqlitePath)) {
        const ids = await readSqliteIds(sqlitePath);
        if (ids === undefined) {
            return unknownStore(root, `sessions.sqlite present but unreadable: ${sqlitePath}`);
        }
        return storeOf({ kind: 'sqlite', root, evidence: `${ids.size} session row(s) in ${sqlitePath}` }, ids);
    }
    const ids = jsonlSessionIds(root);
    if (ids.size > 0) {
        return storeOf({ kind: 'jsonl', root, evidence: `${ids.size} session dir(s) under ${root}` }, ids);
    }
    return unknownStore(root, `no sessions.sqlite and no session dirs under ${root}`);
}
