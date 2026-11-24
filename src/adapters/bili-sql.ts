import type { DatabaseSync } from 'node:sqlite';

import type { Family } from '../types.js';
import { childPrefix } from '../core/family.js';

/**
 * Shared SQL helpers for the bili index.
 *
 * `substr(column, 1, n) = prefix` instead of `LIKE`: session ids may contain
 * `_`, which is a LIKE wildcard, and an escaped pattern is one typo away from a
 * `%` that matches every row in the table.
 */
export function familyClause(column: string): string {
  return `(${column} = ? OR substr(${column}, 1, ?) = ?)`;
}

export function familyArgs(family: Family): [string, number, string] {
  const prefix = childPrefix(family.id);
  return [family.id, prefix.length, prefix];
}

export type Sql = DatabaseSync;

export interface ColumnInfo {
  name: string;
}

export function tableColumns(db: Sql, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: unknown }>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

export function hasTable(db: Sql, table: string): boolean {
  try {
    const row = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return row !== undefined;
  } catch {
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
] as const;

/** Content references a session family holds, mirroring bili's deleteSession. */
export const CONTENT_SOURCES = [
  { table: 'messages', column: 'content_hash' },
  { table: 'message_media', column: 'media_hash' },
  { table: 'blocks', column: 'summary_hash' },
  { table: 'blocks', column: 'one_hash' },
  { table: 'ccr_entries', column: 'content_hash' },
  { table: 'checkpoints', column: 'state_hash' },
] as const;
