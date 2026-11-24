import type { Family } from '../types.js';
import { type Sql } from './bili-sql.js';
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
export declare const KV_TARGETS: readonly [{
    readonly namespace: "plugin-conversations";
    readonly key: "table";
}, {
    readonly namespace: "prefix-affinity";
    readonly key: "v1";
}, {
    readonly namespace: "session-order";
    readonly key: "v1";
}];
export type KvTarget = (typeof KV_TARGETS)[number];
export type DeletedCounts = Record<string, number | string>;
/**
 * Remove every trace of one family from a session-keyed JSON blob.
 * Returns the rewritten text, or `null` when nothing matched (so a caller never
 * rewrites a row it did not change). Unparseable JSON is left exactly as it is.
 */
export declare function scrubSessionFromJson(text: string, family: Family): {
    text: string;
    dropped: number;
} | null;
/** Delete this family's entries from the three session-keyed blobs. */
export declare function purgeKvRows(db: Sql, family: Family, deleted: DeletedCounts): void;
export interface GhostOwners {
    /** Session ids bili still lists. */
    indexed: Set<string>;
    /** Session ids DSH still has, or null when the store could not be read. */
    live: Set<string> | null;
}
export interface GhostPlanEntry {
    target: KvTarget;
    before: string;
    next: string;
    dropped: number;
}
export interface GhostScan {
    entries: GhostPlanEntry[];
    kept: number;
    total: number;
}
/** Read-only pass: what the boot sweep would rewrite. */
export declare function planGhostKv(db: Sql, owners: GhostOwners): GhostScan;
/**
 * Rewrite the planned blobs in one transaction, after dropping the exact rows
 * that are about to change into the batch. The name deliberately does not end
 * in `.json`: `restoreLatest` treats every `*.json` in a batch as a bili
 * snapshot and would copy this file into bili's session tree.
 */
export declare function writeGhostKv(db: Sql, scan: GhostScan, batchDir: string): Promise<{
    backup: string;
    removed: Record<string, number>;
}>;
/** True when any session-keyed blob still mentions this family. */
export declare function kvMentionsFamily(db: Sql, family: Family): string[];
