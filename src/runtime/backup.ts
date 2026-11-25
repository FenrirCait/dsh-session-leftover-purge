import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import type { Logger, PluginConfig } from '../types.js';
import { archiveProjcacheRoot, biliSessionsRoot, costMeterDetailsRoot, dshContextRoot, ledgerFile, stateDir } from './paths.js';

const DB = 'index.db';
const SIDECARS = ['', '-wal', '-shm'];
const LEDGER = 'ledger.json';
/**
 * A kv restore that lands while bili's lane is running can be overwritten by the
 * lane's next request (it rewrites these blobs from memory). The rows are also
 * written here, and the boot pass re-applies them before the lane can start.
 */
const PENDING_KV = 'kv-store.restored-pending.bak';

function trashRoot(): string {
  return path.join(stateDir(), 'trash');
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function logLine(line: string): Promise<void> {
  try {
    await fs.promises.mkdir(stateDir(), { recursive: true });
    await fs.promises.appendFile(path.join(stateDir(), 'purge.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* logging must never break the caller */
  }
}

/** Recursive size of one batch directory, in bytes. */
function dirBytes(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirBytes(full);
      continue;
    }
    try {
      total += fs.statSync(full).size;
    } catch {
      /* vanished mid-walk */
    }
  }
  return total;
}

export interface Batch {
  name: string;
  dir: string;
  files: string[];
  bytes: number;
}

/** Newest first. Batch names are ISO timestamps, so name order is time order. */
export function listBatches(): Batch[] {
  const root = trashRoot();
  if (!fs.existsSync(root)) return [];
  const batches: Batch[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      /* unreadable batch → report as empty */
    }
    batches.push({ name: entry.name, dir, files, bytes: dirBytes(dir) });
  }
  return batches.sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Drop batches that are too old, then batches that make the trash too big.
 *
 * A batch holds a full copy of what was deleted — for bili that is the whole
 * conversation and, for the index, the whole database. `trashRetentionDays: 0`
 * disables the age rule but the size cap still applies; set both to 0 to keep
 * everything. Oldest goes first either way.
 */
export async function sweepTrash(
  cfg: PluginConfig,
  logger?: Logger,
): Promise<{ removed: number; expired: number; trimmed: number; bytes: number; bytesAfter: number }> {
  const result = { removed: 0, expired: 0, trimmed: 0, bytes: 0, bytesAfter: 0 };
  const root = trashRoot();
  if (!fs.existsSync(root)) return result;

  if (Number.isFinite(cfg.trashRetentionDays) && cfg.trashRetentionDays > 0) {
    const cutoff = Date.now() - cfg.trashRetentionDays * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(dir);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoff) continue;
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        result.removed += 1;
        result.expired += 1;
      } catch (error) {
        logger?.warn(`session-leftover-purge: cannot expire backup ${entry.name}: ${String(error)}`);
      }
    }
  }

  if (Number.isFinite(cfg.trashMaxMb) && cfg.trashMaxMb > 0) {
    const cap = cfg.trashMaxMb * 1024 * 1024;
    const batches = listBatches();
    let total = batches.reduce((sum, batch) => sum + batch.bytes, 0);
    result.bytes = total;
    for (let index = batches.length - 1; index >= 0 && total > cap; index -= 1) {
      const batch = batches[index];
      if (batch === undefined) break;
      try {
        await fs.promises.rm(batch.dir, { recursive: true, force: true });
        total -= batch.bytes;
        result.removed += 1;
        result.trimmed += 1;
      } catch (error) {
        logger?.warn(`session-leftover-purge: cannot trim backup ${batch.name}: ${String(error)}`);
      }
    }
    result.bytesAfter = total;
  }
  if (result.removed > 0) {
    await logLine(
      `sweep-trash removed=${result.removed} expired=${result.expired} trimmed=${result.trimmed} ` +
        `bytes=${result.bytes}->${result.bytesAfter}`,
    );
  }
  return result;
}

/** Delete every batch. Irreversible; only wired to the explicit trigger. */
export async function deleteAllBatches(logger?: Logger): Promise<{ removed: number; failed: string[] }> {
  const root = trashRoot();
  const failed: string[] = [];
  let removed = 0;
  if (!fs.existsSync(root)) return { removed, failed };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failed.push(`${entry.name}:${String(error)}`);
      logger?.warn(`session-leftover-purge: cannot delete backup ${entry.name}: ${String(error)}`);
    }
  }
  await logLine(`delete-backups removed=${removed} failed=${failed.length}`);
  return { removed, failed };
}

/** Copy every file under `from` into `toRoot`, preserving relative paths. */
async function restoreTree(from: string, toRoot: string): Promise<number> {
  if (!fs.existsSync(from)) return 0;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = path.relative(from, full);
      const target = path.join(toRoot, rel);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(full, target);
      count += 1;
    }
  };
  await walk(from);
  return count;
}

/**
 * Put the `kv_store` rows back.
 *
 * A restore is a *merge*, not a whole-blob swap: the user can keep working
 * between the restore and the next start, and replaying an old blob wholesale
 * would drop whatever the lane wrote in between (Codex, PR #11). Entries the
 * backup has and the live blob lacks are added; on a key conflict the entry with
 * the newer `lastSeen`/`updatedAt` wins. Blobs that are not JSON fall back to a
 * plain replace, which is what a restore means for them.
 *
 * Synchronous on purpose: the boot path calls it before the plugin finishes
 * loading, and that is the only reliable barrier against bili's lane starting
 * (Codex, PR #11).
 */
function mergeKvValue(currentText: string, backupText: string): string | undefined {
  let current: unknown;
  let backup: unknown;
  try {
    current = JSON.parse(currentText);
    backup = JSON.parse(backupText);
  } catch {
    return undefined; // not JSON: caller replaces it
  }
  if (current === null || typeof current !== 'object' || backup === null || typeof backup !== 'object') return undefined;

  const entryKey = (entry: unknown): string => {
    if (entry === null || typeof entry !== 'object') return '';
    const record = entry as Record<string, unknown>;
    const key = record.sessionId ?? record.id ?? record.session;
    return typeof key === 'string' ? key : '';
  };
  const entryTime = (entry: unknown): number => {
    if (entry === null || typeof entry !== 'object') return 0;
    const record = entry as Record<string, unknown>;
    const value = Number(record.lastSeen ?? record.updatedAt ?? 0);
    return Number.isFinite(value) ? value : 0;
  };

  const currentEntries = Array.isArray(current) ? current : (current as Record<string, unknown>).entries;
  const backupEntries = Array.isArray(backup) ? backup : (backup as Record<string, unknown>).entries;
  if (Array.isArray(currentEntries) && Array.isArray(backupEntries)) {
    const byKey = new Map<string, unknown>();
    for (const entry of currentEntries) {
      const key = entryKey(entry);
      if (key.length > 0) byKey.set(key, entry);
    }
    let changed = false;
    for (const entry of backupEntries) {
      const key = entryKey(entry);
      if (key.length === 0) continue;
      const live = byKey.get(key);
      if (live === undefined) {
        byKey.set(key, entry);
        changed = true;
      } else if (entryTime(entry) > entryTime(live)) {
        byKey.set(key, entry);
        changed = true;
      }
    }
    if (!changed) return currentText;
    const merged = Array.isArray(current)
      ? [...byKey.values()]
      : { ...(current as Record<string, unknown>), entries: [...byKey.values()] };
    return JSON.stringify(merged);
  }

  if (Array.isArray(current) || Array.isArray(backup)) return undefined;

  const currentMap = current as Record<string, unknown>;
  const backupMap = backup as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...currentMap };
  let changed = false;
  for (const [key, value] of Object.entries(backupMap)) {
    if (!(key in merged)) {
      merged[key] = value;
      changed = true;
      continue;
    }
    const live = merged[key];
    if (entryTime(value) > entryTime(live)) {
      merged[key] = value;
      changed = true;
    }
  }
  return changed ? JSON.stringify(merged) : currentText;
}

function restoreKv(file: string): string {
  let sqlite: typeof import('node:sqlite');
  try {
    // A synchronous require keeps the boot path fully synchronous. `node:sqlite`
    // is a builtin, so this cannot hit the network or a resolution surprise.
    sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return 'failed:sqlite-unavailable';
  }
  let rows: Array<{ namespace?: unknown; key?: unknown; value_json?: unknown }>;
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof rows;
  } catch (error) {
    return `failed:${String(error)}`;
  }
  const dbFile = path.join(biliSessionsRoot(), DB);
  if (!fs.existsSync(dbFile)) return 'skipped:index-missing';

  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbFile);
    const exec = (sql: string): void => (db as unknown as { exec(sql: string): void }).exec(sql);
    exec('PRAGMA busy_timeout = 2000');
    try {
      exec('BEGIN IMMEDIATE');
    } catch {
      // Another writer holds the database (the lane, or a purge): stage instead
      // of pretending, and let the next boot apply it.
      try {
        db.close();
      } catch {
        /* already closed */
      }
      db = undefined;
      const staged = path.join(biliSessionsRoot(), `kv-store.restored-${stamp()}.json.bak`);
      fs.copyFileSync(file, staged);
      return `staged:${path.basename(staged)}`;
    }

    // Older bili schemas have no updated_at; the purge path already tolerates
    // that variant, so the restore must too (Codex, PR #10).
    const columns = (db.prepare('PRAGMA table_info("kv_store")').all() as Array<{ name?: unknown }>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string');
    if (!columns.includes('namespace') || !columns.includes('key') || !columns.includes('value_json')) {
      exec('ROLLBACK');
      return 'skipped:kv_store-missing';
    }
    const hasUpdatedAt = columns.includes('updated_at');
    const read = db.prepare('SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?');
    const update = hasUpdatedAt
      ? db.prepare('UPDATE kv_store SET value_json = ?, updated_at = ? WHERE namespace = ? AND key = ?')
      : db.prepare('UPDATE kv_store SET value_json = ? WHERE namespace = ? AND key = ?');
    const insert = hasUpdatedAt
      ? db.prepare('INSERT INTO kv_store (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
      : db.prepare('INSERT INTO kv_store (namespace, key, value_json) VALUES (?, ?, ?)');

    let changed = false;
    for (const row of rows) {
      if (typeof row.namespace !== 'string' || typeof row.key !== 'string') continue;
      const backupText = String(row.value_json ?? '');
      const live = read.get(row.namespace, row.key) as { value_json?: unknown } | undefined;
      if (live === undefined) {
        if (hasUpdatedAt) insert.run(row.namespace, row.key, backupText, Date.now());
        else insert.run(row.namespace, row.key, backupText);
        changed = true;
        continue;
      }
      const liveText = String(live.value_json ?? '');
      const merged = mergeKvValue(liveText, backupText);
      let next: string;
      if (merged === undefined) {
        // Not JSON we understand: a restore replaces the row.
        if (liveText === backupText) continue;
        next = backupText;
      } else {
        if (merged === liveText) continue;
        next = merged;
      }
      if (hasUpdatedAt) update.run(next, Date.now(), row.namespace, row.key);
      else update.run(next, row.namespace, row.key);
      changed = true;
    }
    exec('COMMIT');

    if (changed) {
      // Remember the rows for the next boot: the lane rewrites these blobs from
      // memory, so what we just wrote can be undone by its next request.
      try {
        fs.writeFileSync(path.join(biliSessionsRoot(), PENDING_KV), JSON.stringify(rows));
      } catch {
        /* the restore itself succeeded; a missing marker only costs the retry */
      }
      return 'applied';
    }
    return 'noop';
  } catch (error) {
    try {
      (db as unknown as { exec(sql: string): void }).exec('ROLLBACK');
    } catch {
      /* the transaction may already be gone */
    }
    return `failed:${String(error)}`;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Re-apply a kv restore at boot, **synchronously**, before the plugin finishes
 * loading: after that point the host may start bili's lane at any moment, and a
 * fire-and-forget restore can be overwritten before it commits (Codex, PR #11).
 */
export function applyPendingKvRestoreSync(): string {
  const marker = path.join(biliSessionsRoot(), PENDING_KV);
  if (!fs.existsSync(marker)) return 'none';
  const result = restoreKv(marker);
  if (result === 'applied' || result === 'noop') {
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      /* nothing to clean up */
    }
    void logLine(`apply-pending-kv ${result}`);
  }
  return result;
}

/** Async wrapper for callers that already live in a promise chain. */
export async function applyPendingKvRestore(): Promise<string> {
  return applyPendingKvRestoreSync();
}

/**
 * Put renamed-aside files back. The target may be a *partial* copy left by a
 * failed `copyFile`, so it is removed first: an existing file does not mean the
 * copy succeeded (Codex, PR #10).
 */
export async function restoreAsides(moved: Array<{ live: string; aside: string }>): Promise<void> {
  for (const { live, aside } of moved) {
    if (!fs.existsSync(aside)) continue;
    try {
      await fs.promises.rm(live, { force: true });
    } catch {
      /* best effort: a partial file must not block the rename */
    }
    try {
      await fs.promises.rename(aside, live);
    } catch {
      /* leave the aside for manual recovery */
    }
  }
}

/** Snapshot destination: the protocol directory that already holds this name. */
function snapshotDestination(fileName: string): string {
  const bare = fileName.includes('__') ? fileName.slice(fileName.indexOf('__') + 2) : fileName;
  const root = biliSessionsRoot();
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  for (const entry of dirs) {
    const candidate = path.join(root, entry.name, bare);
    if (fs.existsSync(candidate)) return candidate;
  }
  const first = dirs[0];
  return first === undefined ? path.join(root, 'anthropic', bare) : path.join(root, first.name, bare);
}

async function canTakeWriteLock(file: string): Promise<boolean> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return false;
  }
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(file);
    (db as unknown as { exec(sql: string): void }).exec('PRAGMA busy_timeout = 1500');
    (db as unknown as { exec(sql: string): void }).exec('BEGIN IMMEDIATE');
    (db as unknown as { exec(sql: string): void }).exec('ROLLBACK');
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Put the newest batch back.
 *
 * The rule everywhere is the same: never overwrite a file some other process is
 * actively using. A locked database or ledger is *staged* next to the live file
 * as `*.restored-<stamp>` and the caller is told to swap it after quitting DSH.
 */
export async function restoreLatest(logger?: Logger): Promise<{
  ok: boolean;
  reason?: string;
  batch?: string;
  snapshots?: number;
  database?: string;
  ledger?: string;
  costFiles?: number;
  kv?: string;
  caches?: number;
}> {
  const batches = listBatches();
  const batch = batches[0];
  if (batch === undefined) return { ok: false, reason: 'no-backup' };

  let snapshots = 0;
  for (const file of batch.files) {
    if (!file.endsWith('.json') || file === LEDGER) continue;
    const target = snapshotDestination(file);
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(path.join(batch.dir, file), target);
      snapshots += 1;
    } catch (error) {
      logger?.warn(`session-leftover-purge: cannot restore snapshot ${file}: ${String(error)}`);
    }
  }

  let database = 'skipped';
  const dbDir = path.join(batch.dir, 'index');
  const staged = path.join(dbDir, DB);
  if (fs.existsSync(staged)) {
    const target = path.join(biliSessionsRoot(), DB);
    const tag = stamp();
    if (await canTakeWriteLock(target)) {
      const moved: Array<{ live: string; aside: string }> = [];
      try {
        for (const suffix of SIDECARS) {
          const live = `${target}${suffix}`;
          if (!fs.existsSync(live)) continue;
          const aside = `${live}.before-restore-${tag}`;
          await fs.promises.rename(live, aside);
          moved.push({ live, aside });
        }
        for (const suffix of SIDECARS) {
          const source = path.join(dbDir, `${DB}${suffix}`);
          if (fs.existsSync(source)) await fs.promises.copyFile(source, `${target}${suffix}`);
        }
        database = 'applied';
      } catch (error) {
        // A failed restore must not leave the index missing: put every aside
        // file back, removing any partial copy first (Codex, PR #8 and #10).
        await restoreAsides(moved);
        database = `failed:${String(error)}`;
      }
    } else {
      for (const suffix of SIDECARS) {
        const source = path.join(dbDir, `${DB}${suffix}`);
        if (fs.existsSync(source)) {
          await fs.promises.copyFile(source, path.join(biliSessionsRoot(), `${DB}${suffix}.restored-${tag}`));
        }
      }
      database = `staged:${tag}`;
    }
  }

  let ledger = 'skipped';
  const ledgerCopy = path.join(batch.dir, LEDGER);
  if (fs.existsSync(ledgerCopy)) {
    const target = ledgerFile();
    const tag = stamp();
    if (fs.existsSync(`${target}.lock`)) {
      await fs.promises.copyFile(ledgerCopy, `${target}.restored-${tag}`);
      ledger = `staged:${tag}`;
    } else {
      try {
        if (fs.existsSync(target)) await fs.promises.rename(target, `${target}.before-restore-${tag}`);
        await fs.promises.copyFile(ledgerCopy, target);
        ledger = 'applied';
      } catch (error) {
        // Same rule as the database: a failed copy puts the original back,
        // even when a partial target file exists.
        await restoreAsides([{ live: target, aside: `${target}.before-restore-${tag}` }]);
        ledger = `failed:${String(error)}`;
      }
    }
  }

  let costFiles = 0;
  const costDir = path.join(batch.dir, 'cost-files');
  if (fs.existsSync(costDir)) {
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const rel = path.relative(costDir, full);
        const target = path.join(costMeterDetailsRoot(), rel);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(full, target);
        costFiles += 1;
      }
    };
    await walk(costDir);
  }

  let kv = 'skipped';
  const kvCopy = path.join(batch.dir, 'kv-store.json.bak');
  if (fs.existsSync(kvCopy)) kv = restoreKv(kvCopy);

  let caches = 0;
  try {
    caches += await restoreTree(path.join(batch.dir, 'cache'), path.join(dshContextRoot(), 'overview-cache.v3'));
    // The adapter backs projcache files up by basename, but live ones sit under
    // `<root>/sessions/` when that directory exists and listSessionFiles prefers
    // it — restoring into the root would leave them invisible (Codex, PR #10).
    const projRoot = archiveProjcacheRoot();
    const projNested = path.join(projRoot, 'sessions');
    caches += await restoreTree(path.join(batch.dir, 'projcache'), fs.existsSync(projNested) ? projNested : projRoot);
  } catch (error) {
    logger?.warn(`session-leftover-purge: cannot restore cache backups: ${String(error)}`);
  }

  await logLine(
    `restore batch=${batch.name} snapshots=${snapshots} db=${database} ledger=${ledger} ` +
      `kv=${kv} caches=${caches} costFiles=${costFiles}`,
  );
  logger?.info(
    `session-leftover-purge: restore ${batch.name} → snapshots=${snapshots} db=${database} ledger=${ledger} ` +
      `kv=${kv} caches=${caches} cost-files=${costFiles}`,
  );
  return { ok: true, batch: batch.name, snapshots, database, ledger, costFiles, kv, caches };
}
