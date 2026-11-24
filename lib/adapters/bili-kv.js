import fs from 'node:fs';
import path from 'node:path';
import { familyRootOf, inFamily, isFamilyId } from '../core/family.js';
import { hasTable, tableColumns } from './bili-sql.js';
/**
 * `kv_store` namespaces whose JSON values are keyed by session id.
 *
 * `index.db` deletes rows by `session_id`, which covers every table carrying the
 * id in a column. These three carry it *inside a JSON blob*, so a column-wise
 * delete never reaches them and the binding survives — first in bili's panel,
 * then, after the lane rewrites the blob from memory, forever.
 *
 *   - plugin-conversations/table — `{ "<session-id>": { sessionId, lastSeen } }`
 *   - prefix-affinity/v1 — `{ version, entries: [{ sessionId, … }] }`
 *   - session-order/v1 — `{ version, entries: [{ id, kinds, … }] }`, replayed
 *     into bili's skeleton cache on start
 *
 * Entries are removed one by one, never by dropping a whole blob: the same JSON
 * also holds the ids of every session that still exists.
 */
export const KV_TARGETS = [
    { namespace: 'plugin-conversations', key: 'table' },
    { namespace: 'prefix-affinity', key: 'v1' },
    { namespace: 'session-order', key: 'v1' },
];
function owns(value, family) {
    if (value === null || typeof value !== 'object')
        return false;
    const record = value;
    return inFamily(record.sessionId, family.id) || inFamily(record.session, family.id) || inFamily(record.id, family.id);
}
/**
 * Remove every trace of one family from a session-keyed JSON blob.
 * Returns the rewritten text, or `null` when nothing matched (so a caller never
 * rewrites a row it did not change). Unparseable JSON is left exactly as it is.
 */
export function scrubSessionFromJson(text, family) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object')
        return null;
    let dropped = 0;
    const walk = (node) => {
        if (Array.isArray(node)) {
            for (let index = node.length - 1; index >= 0; index -= 1) {
                const item = node[index];
                if (owns(item, family)) {
                    node.splice(index, 1);
                    dropped += 1;
                }
                else {
                    walk(item);
                }
            }
            return;
        }
        if (node === null || typeof node !== 'object')
            return;
        const record = node;
        for (const key of Object.keys(record)) {
            if (inFamily(key, family.id) || owns(record[key], family)) {
                delete record[key];
                dropped += 1;
            }
            else {
                walk(record[key]);
            }
        }
    };
    walk(parsed);
    return dropped === 0 ? null : { text: JSON.stringify(parsed), dropped };
}
/** Delete this family's entries from the three session-keyed blobs. */
export function purgeKvRows(db, family, deleted) {
    if (!hasTable(db, 'kv_store'))
        return;
    const columns = tableColumns(db, 'kv_store');
    if (!columns.includes('namespace') || !columns.includes('key') || !columns.includes('value_json'))
        return;
    const hasUpdatedAt = columns.includes('updated_at');
    const update = hasUpdatedAt
        ? db.prepare('UPDATE kv_store SET value_json = ?, updated_at = ? WHERE namespace = ? AND key = ?')
        : db.prepare('UPDATE kv_store SET value_json = ? WHERE namespace = ? AND key = ?');
    const read = db.prepare('SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?');
    for (const target of KV_TARGETS) {
        const label = `kv_store:${target.namespace}`;
        try {
            const row = read.get(target.namespace, target.key);
            if (row === undefined)
                continue;
            const next = scrubSessionFromJson(String(row.value_json ?? ''), family);
            if (next === null)
                continue;
            if (hasUpdatedAt)
                update.run(next.text, Date.now(), target.namespace, target.key);
            else
                update.run(next.text, target.namespace, target.key);
            deleted[label] = next.dropped;
        }
        catch (error) {
            deleted[`${label}:error`] = String(error);
        }
    }
}
/**
 * Bindings nobody owns any more.
 *
 * A binding is a ghost only when bili's `sessions` table *and* DSH's own
 * session store have both lost the family: a rebuilt or half-filled index must
 * never read as "every session is gone". A `live: null` (unknown backend)
 * disables the sweep entirely.
 */
function ghostOf(id, owners) {
    if (typeof id !== 'string' || !isFamilyId(id))
        return false;
    if (owners.live === null)
        return false;
    const root = familyRootOf(id);
    return !owners.indexed.has(root) && !owners.live.has(root);
}
function dropGhosts(text, owners) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (value === null || typeof value !== 'object')
        return null;
    const idOf = (item) => {
        if (item === null || typeof item !== 'object')
            return undefined;
        const record = item;
        return record.sessionId ?? record.session ?? record.id;
    };
    let dropped = 0;
    const pruneArray = (items) => {
        for (let index = items.length - 1; index >= 0; index -= 1) {
            if (ghostOf(idOf(items[index]), owners)) {
                items.splice(index, 1);
                dropped += 1;
            }
        }
    };
    if (Array.isArray(value)) {
        pruneArray(value);
    }
    else {
        const record = value;
        for (const [key, entry] of Object.entries(record)) {
            if (ghostOf(key, owners) || ghostOf(idOf(entry), owners)) {
                delete record[key];
                dropped += 1;
                continue;
            }
            // prefix-affinity and session-order nest their records in an array under
            // `entries`; plugin-conversations keys the blob itself by session id.
            if (Array.isArray(entry))
                pruneArray(entry);
        }
    }
    return dropped === 0 ? null : { text: JSON.stringify(value), dropped };
}
/** Read-only pass: what the boot sweep would rewrite. */
export function planGhostKv(db, owners) {
    const entries = [];
    let kept = 0;
    if (!hasTable(db, 'kv_store'))
        return { entries, kept, total: 0 };
    const read = db.prepare('SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?');
    for (const target of KV_TARGETS) {
        let row;
        try {
            row = read.get(target.namespace, target.key);
        }
        catch {
            continue;
        }
        if (row === undefined)
            continue;
        const before = String(row.value_json ?? '');
        const next = dropGhosts(before, owners);
        if (next === null) {
            kept += 1;
            continue;
        }
        entries.push({ target, before, next: next.text, dropped: next.dropped });
    }
    const total = entries.reduce((sum, entry) => sum + entry.dropped, 0);
    return { entries, kept, total };
}
/**
 * Rewrite the planned blobs in one transaction, after dropping the exact rows
 * that are about to change into the batch. The name deliberately does not end
 * in `.json`: `restoreLatest` treats every `*.json` in a batch as a bili
 * snapshot and would copy this file into bili's session tree.
 */
export async function writeGhostKv(db, scan, batchDir) {
    const fsPromises = fs.promises;
    await fsPromises.mkdir(batchDir, { recursive: true });
    const backup = path.join(batchDir, 'kv-store.json.bak');
    const rows = scan.entries.map((entry) => ({
        namespace: entry.target.namespace,
        key: entry.target.key,
        value_json: entry.before,
    }));
    await fsPromises.writeFile(backup, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    const columns = tableColumns(db, 'kv_store');
    const hasUpdatedAt = columns.includes('updated_at');
    const update = hasUpdatedAt
        ? db.prepare('UPDATE kv_store SET value_json = ?, updated_at = ? WHERE namespace = ? AND key = ?')
        : db.prepare('UPDATE kv_store SET value_json = ? WHERE namespace = ? AND key = ?');
    const removed = {};
    db.exec('BEGIN IMMEDIATE');
    try {
        // Re-check inside the write lock: bili's lane rewrites these blobs from
        // memory on every request, and writing a value planned before that rewrite
        // would resurrect stale bindings (Codex, PR #8 and PR #4).
        const read = db.prepare('SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?');
        for (const entry of scan.entries) {
            const now = read.get(entry.target.namespace, entry.target.key);
            if (String(now?.value_json ?? '') !== entry.before) {
                throw new Error(`changed-during-write:${entry.target.namespace}/${entry.target.key}`);
            }
        }
        for (const entry of scan.entries) {
            if (hasUpdatedAt)
                update.run(entry.next, Date.now(), entry.target.namespace, entry.target.key);
            else
                update.run(entry.next, entry.target.namespace, entry.target.key);
            removed[entry.target.namespace] = entry.dropped;
        }
        db.exec('COMMIT');
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            /* the transaction may already be gone */
        }
        throw error;
    }
    return { backup, removed };
}
/** True when any session-keyed blob still mentions this family. */
export function kvMentionsFamily(db, family) {
    const hits = [];
    if (!hasTable(db, 'kv_store'))
        return hits;
    const read = db.prepare('SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?');
    for (const target of KV_TARGETS) {
        try {
            const row = read.get(target.namespace, target.key);
            if (row === undefined)
                continue;
            const text = String(row.value_json ?? '');
            if (text.includes(family.id) || family.children.some((child) => text.includes(child))) {
                hits.push(`${target.namespace}/${target.key}`);
            }
        }
        catch {
            /* unreadable blob is reported by the caller as a failed verify */
        }
    }
    return hits;
}
