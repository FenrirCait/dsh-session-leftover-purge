import { childPrefix } from '../core/family.js';
/**
 * Shared SQL helpers for the bili index.
 *
 * `substr(column, 1, n) = prefix` instead of `LIKE`: session ids may contain
 * `_`, which is a LIKE wildcard, and an escaped pattern is one typo away from a
 * `%` that matches every row in the table.
 */
export function familyClause(column) {
    return `(${column} = ? OR substr(${column}, 1, ?) = ?)`;
}
export function familyArgs(family) {
    const prefix = childPrefix(family.id);
    return [family.id, prefix.length, prefix];
}
export function tableColumns(db, table) {
    try {
        return db.prepare(`PRAGMA table_info("${table}")`).all()
            .map((row) => row.name)
            .filter((name) => typeof name === 'string');
    }
    catch {
        return [];
    }
}
export function hasTable(db, table) {
    try {
        const row = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        return row !== undefined;
    }
    catch {
        return false;
    }
}
/** Tables the purge deletes from, in the order bili itself uses. */
export const DELETE_TABLES = [
    'messages',
    'message_media',
    'refs',
    'blocks',
    'dead_refs',
    'checkpoints',
    'ccr_entries',
    'session_ext',
    'conversations',
    'sessions',
];
/** Content references a session family holds, mirroring bili's deleteSession. */
export const CONTENT_SOURCES = [
    { table: 'messages', column: 'content_hash' },
    { table: 'message_media', column: 'media_hash' },
    { table: 'blocks', column: 'summary_hash' },
    { table: 'blocks', column: 'one_hash' },
    { table: 'ccr_entries', column: 'content_hash' },
    { table: 'checkpoints', column: 'state_hash' },
];
