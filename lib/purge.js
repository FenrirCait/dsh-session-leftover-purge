import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  biliSessionsRoot,
  costMeterFilesRoot,
  dshSessionsRoot,
  ledgerFile,
  stateDir,
  trashDir,
} from './paths.js';
import { backupLedgerFile } from './backup.js';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const SESSION_ID_SHAPE = /^session-[0-9a-zA-Z._-]+$/;

/**
 * bili files a subagent run as its own session: `session-<parent>|sub:<hex>`.
 *
 * Nothing else ever deletes those rows. bili's own `deleteSession` is an exact
 * `WHERE session_id = ?`, and DSH emits exactly one `api-session/removed` for
 * the parent — so a deleted parent used to leave its whole subagent family
 * behind. Everything below therefore works on a *family*: the id plus every
 * `|sub:` child it owns.
 */
const SUBAGENT_SUFFIX = '|sub:';
const SUBAGENT_TAIL_SHAPE = /^[0-9a-f]{6,}$/;

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_SHAPE.test(value);
}

/** Parent id of a subagent pseudo-session, or undefined for anything else. */
export function subagentParentOf(value) {
  if (typeof value !== 'string') return undefined;
  const at = value.indexOf(SUBAGENT_SUFFIX);
  if (at < 0) return undefined;
  const parent = value.slice(0, at);
  const tail = value.slice(at + SUBAGENT_SUFFIX.length);
  if (!SESSION_ID_SHAPE.test(parent) || !SUBAGENT_TAIL_SHAPE.test(tail)) return undefined;
  return parent;
}

/** True for a session id and for the subagent pseudo-sessions it owns. */
export function isSessionFamilyId(value) {
  return isSessionId(value) || subagentParentOf(value) !== undefined;
}

/**
 * SQL matching one family in `column`.
 *
 * `substr(column, 1, n) = prefix` instead of `LIKE`: session ids may contain
 * `_`, which is a LIKE wildcard, and an escaped pattern is one SQL-injection
 * footgun away from a `%` that matches everything.
 */
function familyClause(column) {
  return `(${column} = ? OR substr(${column}, 1, ?) = ?)`;
}

function familyArgs(sessionId) {
  const prefix = `${sessionId}${SUBAGENT_SUFFIX}`;
  return [sessionId, prefix.length, prefix];
}

/** JS-side twin of `familyClause`, for the ids inside a `kv_store` blob. */
function inFamily(value, sessionId) {
  return typeof value === 'string' && (value === sessionId || subagentParentOf(value) === sessionId);
}

/**
 * `kv_store` namespaces whose JSON values are keyed by session id.
 *
 * `biliIndexDb` above deletes rows by `session_id`, which covers every table
 * that carries the id in a column. These carry it *inside a JSON blob* instead,
 * so a column-wise delete misses them and the session keeps showing up in
 * bili's panel:
 *   - `plugin-conversations` / `table` — `{ "<session-id>": { sessionId, lastSeen } }`,
 *     the list the dsh-native plugin reports its conversations from.
 *   - `prefix-affinity` / `v1` — `{ version, entries: [{ sessionId, … }] }`,
 *     per-session prefix-cache descriptors.
 *   - `session-order` / `v1` — `{ version, entries: [{ id, kinds, frags, … }] }`,
 *     the skeleton order bili replays through `applyOrderSnapshot` on start.
 *
 * Entries are removed individually, never by dropping a whole blob: the same
 * JSON also holds the ids of every session that still exists.
 */
export const SESSION_KEYED_KV = [
  { namespace: 'plugin-conversations', key: 'table' },
  { namespace: 'prefix-affinity', key: 'v1' },
  { namespace: 'session-order', key: 'v1' },
];

/** Append one line to `<state>/purge.log` (best effort, never throws). */
export async function log(line) {
  try {
    await fsp.mkdir(stateDir(), { recursive: true });
    const stamp = new Date().toISOString();
    await fsp.appendFile(path.join(stateDir(), 'purge.log'), `${stamp} ${line}\n`, 'utf8');
  } catch {
    /* logging must never break a purge */
  }
}

/** True when DSH still has an on-disk transcript dir for this session. */
function transcriptExists(sessionId) {
  const root = dshSessionsRoot();
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    try {
      if (fs.statSync(path.join(root, ws.name, sessionId)).isDirectory()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** Read the snapshot id of a bili json file, or undefined. */
function readSnapshotId(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    const id = parsed?.id ?? parsed?.payload?.id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    // Truncated/corrupt snapshot: fall back to the leading id field only.
    const match = /"id"\s*:\s*"(session-[0-9a-zA-Z._-]+)"/.exec(text.slice(0, 8192));
    return match ? match[1] : undefined;
  }
}

/** Every `<root>/<protocol>/*.json` snapshot file. */
function listSnapshotFiles(root) {
  const out = [];
  let protocols;
  try {
    protocols = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of protocols) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      out.push(path.join(dir, file.name));
    }
  }
  return out;
}

async function moveToTrash(file, sessionId, batch) {
  const dir = batch ?? trashDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${sessionId}__${path.basename(file)}`);
  try {
    await fsp.rename(file, target);
  } catch {
    await fsp.copyFile(file, target);
    await fsp.unlink(file);
  }
  return target;
}

/**
 * Copy the SQLite index (plus its WAL sidecars) into the purge batch before any
 * row is deleted. The three files belong together: replaying a WAL against a
 * different main file corrupts it, so they are always copied as a set.
 * Returns the copied basenames, or throws when the copy itself fails.
 */
async function backupIndexDbFiles(dbFile, batch) {
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbFile}${suffix}`;
    if (!fs.existsSync(source)) continue;
    await fsp.mkdir(batch, { recursive: true });
    const target = path.join(batch, `index.db${suffix}`);
    await fsp.copyFile(source, target);
    copied.push(path.basename(target));
  }
  return copied;
}

/**
 * Delete the bili snapshots belonging to `sessionId`.
 * Returns `{ scanned, matched, moved[], skipped }`.
 */
export async function purgeBiliJson(sessionId, cfg, logger, batch) {
  const root = biliSessionsRoot();
  const result = { root, scanned: 0, matched: [], moved: [], skipped: [] };
  if (!fs.existsSync(root)) {
    result.skipped.push('bili-sessions-root-missing');
    return result;
  }
  for (const file of listSnapshotFiles(root)) {
    result.scanned += 1;
    const id = readSnapshotId(file);
    // A subagent snapshot belongs to its parent's family: purging the parent
    // has to take it, or the panel keeps listing a conversation that is gone.
    if (id !== sessionId && subagentParentOf(id) !== sessionId) continue;
    result.matched.push(file);
    if (cfg.dryRun) continue;
    try {
      const target = await moveToTrash(file, sessionId, batch);
      result.moved.push({ from: file, to: target });
    } catch (error) {
      result.skipped.push(`move-failed:${path.basename(file)}:${String(error)}`);
      logger?.warn?.(`session-leftover-purge: cannot move ${path.basename(file)}: ${String(error)}`);
    }
  }
  return result;
}

/**
 * Remove every trace of `sessionId` from a JSON blob that is keyed by session id.
 *
 * Handles the three shapes bili actually writes — both of these blobs are
 * sometimes an object map (`{id: value}`) and sometimes an array of records
 * carrying `sessionId` — and returns the rewritten text, or `null` when the
 * blob does not parse or mentions nothing for this session (so the caller
 * never rewrites a row it did not change).
 */
function scrubSessionFromJson(text, sessionId) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON we understand. Leaving it alone is the whole rule here: an
    // unparseable blob is more likely to be a format this patch predates than
    // something safe to rewrite by substring.
    return null;
  }
  const owns = (value) =>
    value !== null &&
    typeof value === 'object' &&
    (inFamily(value.sessionId, sessionId) || inFamily(value.session, sessionId) || inFamily(value.id, sessionId));
  let changed = false;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        if (owns(node[i])) {
          node.splice(i, 1);
          changed = true;
        } else {
          walk(node[i]);
        }
      }
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (inFamily(key, sessionId) || owns(node[key])) {
        delete node[key];
        changed = true;
      } else {
        walk(node[key]);
      }
    }
  };
  walk(parsed);
  return changed ? JSON.stringify(parsed) : null;
}

/**
 * Delete this session's entries from the session-keyed `kv_store` blobs.
 *
 * Same transaction as the row delete above, so a rollback puts everything back
 * together. A missing piece of the schema is not an error — bili versions differ
 * in which namespaces they keep — so every statement is best effort and its
 * outcome is reported rather than thrown.
 */
function purgeBiliKvStore(db, sessionId, deleted) {
  let table = false;
  try {
    table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='kv_store'`).get() !== undefined;
  } catch {
    table = false;
  }
  if (!table) return;

  const columns = db
    .prepare(`PRAGMA table_info("kv_store")`)
    .all()
    .map((column) => column.name);
  if (!columns.includes('namespace') || !columns.includes('key') || !columns.includes('value_json')) return;

  for (const target of SESSION_KEYED_KV) {
    const label = `kv_store:${target.namespace}`;
    try {
      const row = db
        .prepare(`SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?`)
        .get(target.namespace, target.key);
      if (!row) continue;
      const next = scrubSessionFromJson(String(row.value_json ?? ''), sessionId);
      if (next === null) continue;
      if (columns.includes('updated_at')) {
        db.prepare(`UPDATE kv_store SET value_json = ?, updated_at = ? WHERE namespace = ? AND key = ?`).run(
          next,
          Date.now(),
          target.namespace,
          target.key,
        );
      } else {
        db.prepare(`UPDATE kv_store SET value_json = ? WHERE namespace = ? AND key = ?`).run(
          next,
          target.namespace,
          target.key,
        );
      }
      deleted[label] = 1;
    } catch (error) {
      deleted[`${label}:error`] = String(error);
    }
  }
}

/**
 * Where bili keeps a session's content references.
 *
 * Mirrors `deleteSession` in billion-context's own storage layer
 * (`dist/index.js`): every message blob, every media blob, both block
 * hashes, every CCR blob, and the state hash of each non-pinned checkpoint.
 * Pinned checkpoints are left out on purpose — bili keeps their blobs alive
 * as a GC anchor, so releasing them here would break its invariant.
 */
const SESSION_CONTENT_SOURCES = [
  { table: 'messages', column: 'content_hash' },
  { table: 'message_media', column: 'media_hash' },
  { table: 'blocks', column: 'summary_hash' },
  { table: 'blocks', column: 'one_hash' },
  { table: 'ccr_entries', column: 'content_hash' },
  { table: 'checkpoints', column: 'state_hash' },
];

/**
 * Collect one entry per content reference the session still holds.
 * Duplicates are kept: `content.refcount` counts references, not hashes,
 * so a hash referenced twice has to be released twice.
 */
function collectSessionContentHashes(db, sessionId, deleted) {
  const hashes = [];
  for (const source of SESSION_CONTENT_SOURCES) {
    try {
      const info = db.prepare(`PRAGMA table_info("${source.table}")`).all();
      if (!info.some((column) => column.name === 'session_id')) continue;
      if (!info.some((column) => column.name === source.column)) continue;
      const pinnedAware = source.table === 'checkpoints' && info.some((column) => column.name === 'pinned');
      const where = pinnedAware ? `${familyClause('session_id')} AND pinned = 0` : familyClause('session_id');
      const rows = db
        .prepare(`SELECT "${source.column}" AS hash FROM "${source.table}" WHERE ${where}`)
        .all(...familyArgs(sessionId));
      for (const row of rows) {
        if (typeof row.hash === 'string' && row.hash.length > 0) hashes.push(row.hash);
      }
    } catch (error) {
      deleted[`${source.table}.${source.column}:error`] = String(error);
    }
  }
  return hashes;
}

/**
 * Drop one refcount per collected hash. Without this the blobs stay pinned at
 * `refcount > 0` for ever and the orphan sweep below can never collect them —
 * that is exactly how the live database accumulated its leaked rows.
 */
function releaseSessionContent(db, hashes, deleted) {
  let released = 0;
  try {
    const stmt = db.prepare('UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0');
    for (const hash of hashes) {
      if (Number(stmt.run(hash).changes) > 0) released += 1;
    }
  } catch (error) {
    deleted['content:release-error'] = String(error);
    return released;
  }
  if (released > 0) deleted['content:released'] = released;
  return released;
}

/**
 * Opt-in: delete the rows for `sessionId` from bili's unified SQLite index.
 * Runs against another process's database, so this is deliberately defensive:
 * short transaction, busy timeout, orphan content sweep, no VACUUM.
 */
export async function purgeBiliIndexDb(sessionId, cfg, logger, batch) {
  const dbFile = path.join(biliSessionsRoot(), 'index.db');
  if (!fs.existsSync(dbFile)) return { ok: false, reason: 'index.db-missing' };
  if (cfg.dryRun) return { ok: false, reason: 'dry-run' };
  // Snapshot first, and never delete a row when the snapshot itself failed:
  // a purge that cannot be rolled back is not worth the risk.
  let backup;
  try {
    backup = await backupIndexDbFiles(dbFile, batch ?? trashDir());
  } catch (error) {
    return { ok: false, reason: `backup-failed:${String(error)}` };
  }
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    return { ok: false, reason: `node:sqlite-unavailable:${String(error)}` };
  }
  const { DatabaseSync } = sqlite;
  let db;
  try {
    db = new DatabaseSync(dbFile);
  } catch (error) {
    return { ok: false, reason: `open-failed:${String(error)}` };
  }
  try {
    db.exec('PRAGMA busy_timeout = 4000');
    db.exec('PRAGMA secure_delete = ON');
    const deleted = {};
    db.exec('BEGIN IMMEDIATE');
    try {
      const contentHashes = collectSessionContentHashes(db, sessionId, deleted);
      for (const table of [
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
      ]) {
        try {
          const info = db.prepare(`PRAGMA table_info("${table}")`).all();
          if (!info.some((column) => column.name === 'session_id')) continue;
          // Pinned checkpoints are a deliberate GC anchor in bili; deleting
          // them would strand the blobs their state_hash still pins.
          const where =
            table === 'checkpoints' && info.some((column) => column.name === 'pinned')
              ? `${familyClause('session_id')} AND pinned = 0`
              : familyClause('session_id');
          const run = db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...familyArgs(sessionId));
          if (Number(run.changes) > 0) deleted[table] = Number(run.changes);
        } catch (error) {
          deleted[`${table}:error`] = String(error);
        }
      }
      try {
        // Release after the rows are gone and before the orphan sweep, so the
        // blobs this session owned drop to zero refs and get collected below.
        releaseSessionContent(db, contentHashes, deleted);
      } catch (error) {
        deleted['content:release-error'] = String(error);
      }
      try {
        // Same transaction as the row deletes, so a rollback restores both.
        purgeBiliKvStore(db, sessionId, deleted);
      } catch (error) {
        deleted['kv_store:error'] = String(error);
      }
      try {
        // `refcount` is the table's own authority on sharing; the NOT IN list
        // covers every remaining referrer — media blobs and checkpoint state
        // hashes included, or a released blob that another session still
        // points at would be deleted underneath it.
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
          .run();
        if (Number(orphan.changes) > 0) deleted.content = Number(orphan.changes);
      } catch (error) {
        deleted['content:error'] = String(error);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      return { ok: false, reason: `tx-failed:${String(error)}`, backup };
    }
    return { ok: true, deleted, backup };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Opt-in: drop the session row from dsh-cost-meter's ledger.
 * The file is rewritten atomically (tmp + rename) and skipped on any surprise.
 */
/**
 * Opt-in: drop this session's detail row from the cost-meter ledger.
 *
 * Everything here is shaped by one rule — never misstate money.
 *
 *  - Only `days[*].sessions[]` is touched. `calls / cost / costCny / input / …`
 *    are the record of what was actually spent and stay exactly as they are.
 *    cost-meter calls the leftover "anonymous usage" and preserves it on purpose
 *    ("Preserve that remainder and its money instead of inventing attribution",
 *    ledger-totals.js:37). Recomputing the totals from the retained rows would
 *    make today's figure drop below what was really paid — that is the failure
 *    mode this function refuses to introduce.
 *  - The ledger is copied into the batch *before* a single byte changes, so the
 *    edit is reversible through `restoreBackupTrigger`.
 *  - cost-meter serialises its writes with a `${ledger}.lock` directory. We never
 *    create it (a half-implemented second owner is worse than none); we only
 *    stand back while it exists, and re-check it plus mtime/size right before
 *    renaming, so a concurrent write is never clobbered.
 */
export async function purgeCostMeterLedger(sessionId, cfg, logger, batch) {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return { ok: false, reason: 'ledger-missing' };
  if (cfg.dryRun) return { ok: false, reason: 'dry-run' };

  const lockDir = `${file}.lock`;
  if (fs.existsSync(lockDir)) return { ok: false, reason: 'busy:cost-meter-lock-held' };

  let parsed;
  let before;
  try {
    before = await fsp.stat(file);
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `read-failed:${String(error)}` };
  }

  let removed = 0;
  const days = parsed?.days;
  if (days && typeof days === 'object') {
    for (const bucket of Object.values(days)) {
      const sessions = bucket?.sessions;
      if (!Array.isArray(sessions)) continue;
      for (let i = sessions.length - 1; i >= 0; i -= 1) {
        if (sessions[i]?.id === sessionId) {
          sessions.splice(i, 1);
          removed += 1;
        }
      }
    }
  }
  if (removed === 0) return { ok: true, removed: 0, aggregates: 'kept' };

  // Nothing is written until the current ledger is safely inside the batch.
  let backupName;
  try {
    backupName = await backupLedgerFile(batch);
  } catch (error) {
    // Same rule as index.db: a backup that did not land means no edit at all.
    return { ok: false, reason: `backup-failed:${String(error)}`, removed: 0 };
  }

  const after = await fsp.stat(file);
  if (fs.existsSync(lockDir)) return { ok: false, reason: 'busy:lock-appeared', backup: backupName };
  if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
    return { ok: false, reason: 'changed-during-read', backup: backupName };
  }

  const tmp = `${file}.${process.pid}.purge-tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    // Last look before the swap. This is the final moment a concurrent cost-meter
    // write can still be noticed; the window itself cannot be closed, because
    // rename(2) has no compare-and-swap form and inventing a second lock owner is
    // riskier than this check. The mandatory batch backup is what makes the rare
    // lost race recoverable.
    const final = await fsp.stat(file);
    if (fs.existsSync(lockDir) || final.mtimeMs !== before.mtimeMs || final.size !== before.size) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* nothing to clean up */
      }
      return { ok: false, reason: 'changed-before-rename', backup: backupName };
    }
    await fsp.rename(tmp, file);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* the temp file may already be gone */
    }
    return { ok: false, reason: `write-failed:${String(error)}`, backup: backupName };
  }

  logger?.info?.(
    `session-leftover-purge: ledger rows removed=${removed}, daily totals kept as-is, backup=${backupName}`,
  );
  return { ok: true, removed, backup: backupName, aggregates: 'kept' };
}

/** Depth-first file list. Missing or unreadable directories yield nothing. */
async function listFilesRecursive(root) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Opt-in: remove this session's raw receipts under
 * `storages/cost-meter/ledger.json.billion-context/{groups,streams,calls}/`.
 *
 * These files sit behind the ledger's per-turn detail view. Deleting them leaves
 * every aggregate in `ledger.json` untouched — but it does destroy the record of
 * which turn spent what, which is evidence rather than metadata. Off by default
 * for exactly that reason.
 *
 * Order matters: copy into the batch first, and never unlink a file the copy
 * step did not confirm. A half-copied batch must not turn into a half-deleted
 * ledger.
 */
export async function purgeCostMeterFiles(sessionId, cfg, logger, batch) {
  const root = costMeterFilesRoot();
  if (!fs.existsSync(root)) return { ok: false, reason: 'cost-files-root-missing' };
  if (cfg.dryRun) return { ok: false, reason: 'dry-run' };

  const matched = [];
  for (const dir of ['groups', 'streams', 'calls']) {
    for (const file of await listFilesRecursive(path.join(root, dir))) {
      if (await fileMentionsSession(file, sessionId)) matched.push(file);
    }
  }
  if (matched.length === 0) return { ok: true, matched: 0, removed: 0, backup: 0 };

  const backupRoot = path.join(batch ?? trashDir(), 'cost-files');
  const copied = new Set();
  const failed = [];
  for (const file of matched) {
    const rel = path.relative(root, file);
    try {
      const target = path.join(backupRoot, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(file, target);
      copied.add(rel);
    } catch (error) {
      failed.push(`backup:${rel}:${String(error)}`);
    }
  }

  let removed = 0;
  for (const file of matched) {
    const rel = path.relative(root, file);
    if (!copied.has(rel)) continue;
    try {
      await fsp.unlink(file);
      removed += 1;
    } catch (error) {
      failed.push(`remove:${rel}:${String(error)}`);
    }
  }

  if (failed.length > 0) {
    logger?.warn?.(`session-leftover-purge: cost-meter files partly failed: ${failed.join('; ')}`);
  }
  await log(`cost-files ${sessionId} matched=${matched.length} removed=${removed}`);
  return {
    ok: failed.length === 0,
    matched: matched.length,
    removed,
    backup: copied.size,
    ...(failed.length > 0 ? { failed } : {}),
  };
}

/**
 * True when this cost-meter detail file belongs to `sessionId`.
 *
 * The layout is not uniform — one JSON object per file under `groups/` and
 * `streams/`, one record per line under `calls/` — so the check parses first and
 * only trusts a structured `sessionId` field. A plain substring hit is accepted
 * solely for files that do not parse at all, because a filename-adjacent string
 * inside someone else's record must never be enough to delete it.
 */
async function fileMentionsSession(file, sessionId) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  // Same cap as the snapshot reader: a runaway file must not be read into memory.
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return false;
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return false;
  }
  if (!text.includes(sessionId)) return false;

  const owns = (value) =>
    value !== null &&
    typeof value === 'object' &&
    (value.sessionId === sessionId || value.session === sessionId || value.id === sessionId);

  const trimmed = text.trim();
  let parsedAny = false;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      parsedAny = true;
      if (Array.isArray(parsed)) return parsed.some(owns);
      return owns(parsed);
    } catch {
      /* multi-line jsonl */
    }
  }
  for (const line of trimmed.split('\n')) {
    const row = line.trim();
    if (!row.startsWith('{')) continue;
    try {
      parsedAny = true;
      if (owns(JSON.parse(row))) return true;
    } catch {
      /* malformed line */
    }
  }
  // Nothing parsed: fall back to the substring that already matched above.
  return !parsedAny;
}

/**
 * Opt-in: physically reclaim the space that deleted rows leave behind.
 *
 * `DELETE` only marks pages free; the old bytes stay inside `index.db` and the
 * WAL until something rewrites the file, which is why a plain grep for a removed
 * session id still hits the database. `VACUUM` performs that rewrite and
 * `wal_checkpoint(TRUNCATE)` empties the journalled copy.
 *
 * This takes an EXCLUSIVE lock on another process's database, so it is only ever
 * called once per boot and gives up quietly when the lock is busy. A failed
 * VACUUM is harmless — SQLite rolls it back and the database is left as it was.
 */
export async function vacuumIndexDb(logger) {
  const dbFile = path.join(biliSessionsRoot(), 'index.db');
  if (!fs.existsSync(dbFile)) return { ok: false, reason: 'index.db-missing' };
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    return { ok: false, reason: `node:sqlite-unavailable:${String(error)}` };
  }
  const { DatabaseSync } = sqlite;
  let db;
  try {
    db = new DatabaseSync(dbFile);
  } catch (error) {
    return { ok: false, reason: `open-failed:${String(error)}` };
  }
  const bytesBefore = fs.statSync(dbFile).size;
  try {
    db.exec('PRAGMA busy_timeout = 4000');
    // Check before touching anything: VACUUM on an already-damaged database can
    // turn a readable file into a broken one, and the point of this pass is to
    // leave the proxy's store healthier, not to gamble with it.
    const pre = db.prepare('PRAGMA integrity_check').get();
    const preVerdict = pre ? Object.values(pre)[0] : undefined;
    if (preVerdict !== 'ok') {
      return { ok: false, reason: `integrity-before:${String(preVerdict)}`, bytesBefore };
    }
    db.exec('VACUUM');
    const post = db.prepare('PRAGMA integrity_check').get();
    const postVerdict = post ? Object.values(post)[0] : undefined;
    if (postVerdict !== 'ok') {
      logger?.warn?.(
        `session-leftover-purge: integrity_check failed after VACUUM: ${String(postVerdict)}`,
      );
      return { ok: false, reason: `integrity-after:${String(postVerdict)}`, bytesBefore };
    }
    let checkpoint = 'ok';
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      checkpoint = String(error);
    }
    return { ok: true, checkpoint, bytesBefore, bytesAfter: fs.statSync(dbFile).size };
  } catch (error) {
    logger?.warn?.(`session-leftover-purge: VACUUM skipped (${String(error)})`);
    return { ok: false, reason: `vacuum-failed:${String(error)}`, bytesBefore };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Clean every configured copy of a deleted session.
 * Never throws: a purge failure must not affect DSH's own delete flow.
 */
export async function purgeSession(sessionId, cfg, logger) {
  // A subagent id is never a unit of work on its own: purging it alone leaves
  // the rest of the family behind, so it resolves to the parent first.
  const familyId = subagentParentOf(sessionId) ?? sessionId;
  if (!isSessionId(familyId)) {
    logger?.warn?.(`session-leftover-purge: refusing suspicious id ${JSON.stringify(sessionId)}`);
    return { skipped: 'bad-id' };
  }
  if (familyId !== sessionId) {
    await log(`normalize ${sessionId} → family ${familyId}`);
    sessionId = familyId;
  }
  if (transcriptExists(sessionId)) {
    await log(`skip ${sessionId}: transcript still on disk`);
    logger?.warn?.(
      `session-leftover-purge: ${sessionId} still has a transcript dir, skipped (nothing deleted)`,
    );
    return { skipped: 'transcript-present' };
  }

  const report = { sessionId };
  // One purge = one batch directory, so a restore can roll the JSON snapshots
  // and the database snapshot back together.
  const batch = trashDir();
  if (cfg.biliJson) {
    try {
      report.biliJson = await purgeBiliJson(sessionId, cfg, logger, batch);
    } catch (error) {
      report.biliJson = { error: String(error) };
      logger?.warn?.(`session-leftover-purge: bili json purge failed: ${String(error)}`);
    }
  }
  if (cfg.biliIndexDb) {
    try {
      report.biliIndexDb = await purgeBiliIndexDb(sessionId, cfg, logger, batch);
    } catch (error) {
      report.biliIndexDb = { error: String(error) };
    }
  }
  if (cfg.costMeterLedger) {
    try {
      report.costMeterLedger = await purgeCostMeterLedger(sessionId, cfg, logger, batch);
    } catch (error) {
      report.costMeterLedger = { error: String(error) };
    }
  }
  if (cfg.costMeterFiles) {
    try {
      report.costMeterFiles = await purgeCostMeterFiles(sessionId, cfg, logger, batch);
    } catch (error) {
      report.costMeterFiles = { error: String(error) };
    }
  }

  const moved = report.biliJson?.moved?.length ?? 0;
  const indexDb = report.biliIndexDb;
  const kvTouched = Object.keys(indexDb?.deleted ?? {}).filter((key) => key.startsWith('kv_store:'));
  await log(`purge ${sessionId} moved=${moved} ${JSON.stringify(report)}`);
  logger?.info?.(
    `session-leftover-purge: ${sessionId} → bili snapshots moved to trash: ${moved}` +
      (indexDb ? `, index.db: ${indexDb.ok ? 'cleaned' : indexDb.reason}` : '') +
      (kvTouched.length > 0 ? `, kv_store: ${kvTouched.join(',')}` : ''),
  );
  return report;
}

/**
 * Every session id that still owns a transcript directory, collected in one
 * pass. `transcriptExists` answers that question for a single id; the boot
 * sweep has to ask it for a hundred at once, and one directory listing beats a
 * hundred stats.
 */
export function liveDshSessionIds() {
  const root = dshSessionsRoot();
  const live = new Set();
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return live;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, workspace.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.isDirectory()) live.add(entry.name);
  }
  return live;
}

/**
 * Read-only pass: bili snapshots whose session family no longer exists in DSH.
 * One entry per family, carrying every file that belongs to it, so a caller can
 * purge the family in one go instead of meeting `bad-id` on each `|sub:` child.
 */
export function findOrphanSnapshots() {
  const root = biliSessionsRoot();
  if (!fs.existsSync(root)) return { root, scanned: 0, orphans: [] };
  const files = listSnapshotFiles(root);
  const live = liveDshSessionIds();
  const byFamily = new Map();
  for (const file of files) {
    const id = readSnapshotId(file);
    if (id === undefined) continue;
    const family = subagentParentOf(id) ?? id;
    if (live.has(family)) continue;
    const entry = byFamily.get(family) ?? { id: family, files: [] };
    entry.files.push(file);
    byFamily.set(family, entry);
  }
  return { root, scanned: files.length, orphans: [...byFamily.values()] };
}

/**
 * Remove every `kv_store` binding whose session family the index no longer has.
 *
 * The lane keeps the whole conversation table in memory and rewrites the blob
 * from memory on every request, so a purge that lands while the lane is up is
 * overwritten within seconds: the `sessions` row is gone for good, but the
 * binding survives and is hydrated straight back on the next start. The only
 * moment the file can be corrected is while no lane owns it — at boot, before
 * the first request spawns one. The lane then hydrates an already-clean table
 * and the ghost never comes back.
 *
 * Guard rails, because this rewrites another program's database:
 *   - only ids shaped like a DSH session id (or one of its `|sub:` children) are
 *     candidates, so unrelated keys that happen to live in the same blob — the
 *     uuid-shaped and `pfa-…` sessions bili keeps for other protocols — are
 *     never touched;
 *   - a binding is a ghost only when bili's `sessions` table *and* DSH's own
 *     transcript tree have both lost the family: a rebuilt or half-filled index
 *     must never read as "every session is gone";
 *   - an empty `sessions` table means "fresh or unreadable store", not "every
 *     session is gone", so the sweep does nothing;
 *   - nothing is written until the rows about to change are copied into the
 *     trash batch, and `dryRun` writes nothing at all;
 *   - the write happens in one transaction with a short busy timeout, and a
 *     malformed blob is left exactly as it was.
 */
function dropGhostBindings(text, owners) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const ghost = (id) => {
    if (!isSessionFamilyId(id)) return false;
    const family = subagentParentOf(id) ?? id;
    return !owners.indexed.has(family) && !owners.live.has(family);
  };
  const idOf = (item) =>
    item !== null && typeof item === 'object' ? (item.sessionId ?? item.session ?? item.id) : undefined;
  let dropped = 0;
  const pruneArray = (items) => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (ghost(idOf(items[index]))) {
        items.splice(index, 1);
        dropped += 1;
      }
    }
  };
  if (Array.isArray(value)) {
    pruneArray(value);
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (ghost(key) || ghost(idOf(entry))) {
        delete value[key];
        dropped += 1;
        continue;
      }
      // prefix-affinity and session-order nest their per-session records in an
      // array under `entries`, while plugin-conversations keys the blob itself
      // by session id.
      if (Array.isArray(entry)) pruneArray(entry);
    }
  }
  return dropped === 0 ? null : { text: JSON.stringify(value), dropped };
}

/**
 * Rewrite the session-keyed blobs, dropping every binding nobody owns any more.
 *
 * `cfg` is required for `dryRun`: the caller runs this on every boot, and a
 * "log only" mode that rewrites another process's database is not a dry run.
 */
export async function sweepGhostKv(cfg, logger) {
  const dbFile = path.join(biliSessionsRoot(), 'index.db');
  if (!fs.existsSync(dbFile)) return { ok: false, reason: 'index.db-missing' };
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    return { ok: false, reason: `node:sqlite-unavailable:${String(error)}` };
  }
  const { DatabaseSync } = sqlite;
  let db;
  try {
    db = new DatabaseSync(dbFile);
  } catch (error) {
    return { ok: false, reason: `open-failed:${String(error)}` };
  }
  try {
    db.exec('PRAGMA busy_timeout = 4000');
    const columns = db
      .prepare(`PRAGMA table_info("kv_store")`)
      .all()
      .map((column) => column.name);
    if (!columns.includes('namespace') || !columns.includes('key') || !columns.includes('value_json')) {
      return { ok: false, reason: 'kv_store-missing' };
    }
    const indexed = new Set(
      db
        .prepare('SELECT session_id FROM sessions')
        .all()
        .map((row) => String(row.session_id)),
    );
    if (indexed.size === 0) return { ok: true, reason: 'no-sessions', removed: {}, kept: 0 };
    const owners = { indexed, live: liveDshSessionIds() };

    // Plan first, write later, so dry-run and the real pass read exactly the same.
    const plan = [];
    let kept = 0;
    for (const target of SESSION_KEYED_KV) {
      const row = db
        .prepare(`SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?`)
        .get(target.namespace, target.key);
      if (!row) continue;
      const before = String(row.value_json ?? '');
      const next = dropGhostBindings(before, owners);
      if (next === null) {
        kept += 1;
        continue;
      }
      plan.push({ target, before, next: next.text, dropped: next.dropped });
    }
    const total = plan.reduce((sum, item) => sum + item.dropped, 0);

    if (cfg?.dryRun) {
      if (total > 0) {
        const perNamespace = Object.fromEntries(plan.map((item) => [item.target.namespace, item.dropped]));
        await log(`sweep-ghost-kv dry-run would-remove=${total} ${JSON.stringify(perNamespace)}`);
        logger?.info?.(
          `session-leftover-purge: dry run — ${total} ghost kv binding(s) would be removed ` +
            `(sessions=${indexed.size}, transcripts=${owners.live.size})`,
        );
      }
      return { ok: true, dryRun: true, wouldRemove: total, kept };
    }

    if (plan.length === 0) return { ok: true, removed: {}, kept, sessions: indexed.size };

    // The rewrite is not reversible from inside the database, so the exact rows
    // land in the trash batch first — the same rule the purge path follows.
    // The name deliberately does not end in `.json`: `restoreLatest` treats every
    // `*.json` in a batch as a bili snapshot and would copy this file into
    // bili's session tree.
    const batch = trashDir();
    const backup = path.join(batch, 'kv-store.json.bak');
    try {
      await fsp.mkdir(batch, { recursive: true });
      const rows = plan.map((item) => ({
        namespace: item.target.namespace,
        key: item.target.key,
        value_json: item.before,
      }));
      await fsp.writeFile(backup, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    } catch (error) {
      return { ok: false, reason: `backup-failed:${String(error)}` };
    }

    // A lane that wrote between the read and the swap would be clobbered; this
    // is the cheapest honest guard available without inventing a second lock.
    for (const item of plan) {
      const now = db
        .prepare(`SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?`)
        .get(item.target.namespace, item.target.key);
      if (String(now?.value_json ?? '') !== item.before) {
        return { ok: false, reason: 'changed-during-read', backup };
      }
    }

    const removed = {};
    const write = columns.includes('updated_at')
      ? db.prepare('UPDATE kv_store SET value_json = ?, updated_at = ? WHERE namespace = ? AND key = ?')
      : db.prepare('UPDATE kv_store SET value_json = ? WHERE namespace = ? AND key = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of plan) {
        if (columns.includes('updated_at')) {
          write.run(item.next, Date.now(), item.target.namespace, item.target.key);
        } else {
          write.run(item.next, item.target.namespace, item.target.key);
        }
        removed[item.target.namespace] = item.dropped;
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be gone */
      }
      return { ok: false, reason: `sweep-failed:${String(error)}`, backup };
    }

    // Only speak up when something was actually dropped: a line per boot for
    // "nothing to do" is noise in a log that is read while debugging.
    await log(
      `sweep-ghost-kv removed=${total} ${JSON.stringify(removed)} ` +
        `kept-sessions=${indexed.size} backup=${path.basename(backup)}`,
    );
    logger?.info?.(
      `session-leftover-purge: ghost kv sweep removed ${total} binding(s) ${JSON.stringify(removed)} ` +
        `(sessions=${indexed.size}, transcripts=${owners.live.size})`,
    );
    return { ok: true, removed, kept, sessions: indexed.size, backup };
  } catch (error) {
    return { ok: false, reason: `sweep-failed:${String(error)}` };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
