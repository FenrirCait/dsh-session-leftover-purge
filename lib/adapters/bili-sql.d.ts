import type { DatabaseSync } from 'node:sqlite';
import type { Family } from '../types.js';
/**
 * Shared SQL helpers for the bili index.
 *
 * `substr(column, 1, n) = prefix` instead of `LIKE`: session ids may contain
 * `_`, which is a LIKE wildcard, and an escaped pattern is one typo away from a
 * `%` that matches every row in the table.
 */
export declare function familyClause(column: string): string;
export declare function familyArgs(family: Family): [string, number, string];
export type Sql = DatabaseSync;
export interface ColumnInfo {
    name: string;
}
export declare function tableColumns(db: Sql, table: string): string[];
export declare function hasTable(db: Sql, table: string): boolean;
/** Tables the purge deletes from, in the order bili itself uses. */
export declare const DELETE_TABLES: readonly ["messages", "message_media", "refs", "blocks", "dead_refs", "checkpoints", "ccr_entries", "session_ext", "conversations", "sessions"];
/** Content references a session family holds, mirroring bili's deleteSession. */
export declare const CONTENT_SOURCES: readonly [{
    readonly table: "messages";
    readonly column: "content_hash";
}, {
    readonly table: "message_media";
    readonly column: "media_hash";
}, {
    readonly table: "blocks";
    readonly column: "summary_hash";
}, {
    readonly table: "blocks";
    readonly column: "one_hash";
}, {
    readonly table: "ccr_entries";
    readonly column: "content_hash";
}, {
    readonly table: "checkpoints";
    readonly column: "state_hash";
}];
