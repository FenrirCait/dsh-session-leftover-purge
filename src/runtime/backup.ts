import fs from 'node:fs';
import path from 'node:path';

import type { Logger, PluginConfig } from '../types.js';
import { biliSessionsRoot, costMeterDetailsRoot, ledgerFile, stateDir } from './paths.js';

const DB = 'index.db';
const SIDECARS = ['', '-wal', '-shm'];
const LEDGER = 'ledger.json';

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
      try {
        for (const suffix of SIDECARS) {
          const live = `${target}${suffix}`;
          if (fs.existsSync(live)) await fs.promises.rename(live, `${live}.before-restore-${tag}`);
        }
        for (const suffix of SIDECARS) {
          const source = path.join(dbDir, `${DB}${suffix}`);
          if (fs.existsSync(source)) await fs.promises.copyFile(source, `${target}${suffix}`);
        }
        database = 'applied';
      } catch (error) {
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

  await logLine(`restore batch=${batch.name} snapshots=${snapshots} db=${database} ledger=${ledger} costFiles=${costFiles}`);
  logger?.info(
    `session-leftover-purge: restore ${batch.name} → snapshots=${snapshots} db=${database} ledger=${ledger} cost-files=${costFiles}`,
  );
  return { ok: true, batch: batch.name, snapshots, database, ledger, costFiles };
}
