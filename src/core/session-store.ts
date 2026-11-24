import fs from 'node:fs';
import path from 'node:path';

import type { SessionStore, StoreProbe } from '../types.js';
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

/**
 * Session ids under `<root>/<project>/<session>`, plus whether the scan was
 * complete. A workspace that cannot be read makes the whole list untrustworthy:
 * dropping just that workspace would make its live sessions look deleted, and a
 * default-on sweep would then remove their bindings (Codex, PR #4).
 */
function scanJsonlSessions(root: string): { ids: Set<string>; incomplete: boolean; exists: boolean } {
  const ids = new Set<string>();
  let workspaces: fs.Dirent[];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    // A missing root is "no backend here"; anything else means "cannot tell".
    return { ids, incomplete: (error as NodeJS.ErrnoException).code !== 'ENOENT', exists: false };
  }
  let incomplete = false;
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    try {
      for (const session of fs.readdirSync(path.join(root, workspace.name), { withFileTypes: true })) {
        if (session.isDirectory()) ids.add(session.name);
      }
    } catch {
      incomplete = true;
    }
  }
  return { ids, incomplete, exists: true };
}

interface Tableish {
  prepare(sql: string): { all(): unknown[] };
}

/** First table/column pair that looks like a session registry. */
function discoverSessionTable(db: Tableish): { table?: string; column?: string } {
  let tables: string[] = [];
  try {
    tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name?: unknown }>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return {};
  }
  // A table literally called `sessions` wins; otherwise the first one carrying
  // an id-shaped column, so a future rename does not silently disable the probe.
  const ordered = [
    ...tables.filter((name) => /^sessions?$/i.test(name)),
    ...tables.filter((name) => !/^sessions?$/i.test(name)),
  ];
  for (const table of ordered) {
    let columns: string[] = [];
    try {
      columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: unknown }>)
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string');
    } catch {
      continue;
    }
    const column = ID_COLUMNS.find((candidate) => columns.includes(candidate));
    if (column !== undefined) return { table, column };
  }
  return {};
}

async function readSqliteIds(file: string): Promise<Set<string> | undefined> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return undefined;
  }
  let db: import('node:sqlite').DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    const { table, column } = discoverSessionTable(db as unknown as Tableish);
    if (table === undefined || column === undefined) return undefined;
    const ids = new Set<string>();
    for (const row of db.prepare(`SELECT "${column}" AS id FROM "${table}"`).all() as Array<{ id?: unknown }>) {
      if (typeof row.id === 'string' && row.id.length > 0) ids.add(row.id);
    }
    return ids.size > 0 ? ids : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function storeOf(probe: StoreProbe, ids: Set<string>): SessionStore {
  return {
    probe: () => probe,
    liveIds: () => ids,
    has: (sessionId: string) => ids.has(sessionId),
  };
}

/**
 * `unknown` deliberately answers "alive" for every id: the only thing worse
 * than leaving a leftover behind is deleting a session that still exists.
 */
function unknownStore(root: string, evidence: string): SessionStore {
  const probe: StoreProbe = { kind: 'unknown', root, evidence };
  return { probe: () => probe, liveIds: () => null, has: () => true };
}

/**
 * Resolve the backend once and cache the id set. Every caller asks the same
 * question during one boot pass, and the answer cannot change while DSH runs.
 */
export async function loadSessionStore(root: string = dshSessionsRoot()): Promise<SessionStore> {
  const sqlitePath = path.join(root, 'sessions.sqlite');
  if (fs.existsSync(sqlitePath)) {
    const ids = await readSqliteIds(sqlitePath);
    if (ids === undefined) {
      return unknownStore(root, `sessions.sqlite present but unreadable: ${sqlitePath}`);
    }
    return storeOf({ kind: 'sqlite', root, evidence: `${ids.size} session row(s) in ${sqlitePath}` }, ids);
  }
  const scan = scanJsonlSessions(root);
  if (scan.incomplete) {
    return unknownStore(root, `session scan incomplete under ${root} (an unreadable workspace)`);
  }
  if (!scan.exists) {
    // No jsonl root and no sessions.sqlite: a fresh or foreign layout. Do not
    // claim "every session is gone" on the strength of a missing directory.
    return unknownStore(root, `no sessions.sqlite and no sessions directory at ${root}`);
  }
  // An existing, readable root is authoritative even when it is empty: that is
  // what the last deleted session leaves behind, and calling it `unknown` would
  // make the final purge of a machine skip forever.
  return storeOf({ kind: 'jsonl', root, evidence: `${scan.ids.size} session dir(s) under ${root}` }, scan.ids);
}
