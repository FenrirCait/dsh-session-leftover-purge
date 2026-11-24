import fs from 'node:fs';
import path from 'node:path';

import type {
  Adapter,
  AdapterPlan,
  AdapterResult,
  ApplyOptions,
  Family,
  ItemOutcome,
  PlanItem,
  PluginConfig,
  Probe,
  SessionStore,
  VerifyResult,
} from '../types.js';
import { biliSessionsRoot } from '../runtime/paths.js';
import { findFamilySnapshots, listSnapshotFiles, moveSnapshot, remainingSnapshots, snapshotPlanItems } from './bili-snapshots.js';
import { backupIndexDb, countFamilyRows, indexDbPath, openIndex, purgeFamily, verifyFamily } from './bili-index.js';
import { planGhostKv, writeGhostKv } from './bili-kv.js';
import type { Sql } from './bili-sql.js';

export interface BiliDeps {
  root?: string;
}

function tableNames(db: Sql): string[] {
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name?: unknown }>)
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

export class BiliAdapter implements Adapter {
  readonly id = 'bili' as const;

  constructor(private readonly deps: BiliDeps = {}) {}

  private root(): string {
    return this.deps.root ?? biliSessionsRoot();
  }

  async probe(): Promise<Probe> {
    const root = this.root();
    if (!fs.existsSync(root)) {
      return { available: false, root, evidence: `bili sessions root missing: ${root}`, capabilities: [] };
    }
    const capabilities: string[] = [];
    const snapshots = listSnapshotFiles(root).length;
    if (snapshots > 0) capabilities.push(`snapshots:${snapshots}`);

    const dbFile = indexDbPath(root);
    if (fs.existsSync(dbFile)) {
      const db = await openIndex(dbFile, true);
      if (db === undefined) {
        capabilities.push('index-unreadable');
      } else {
        try {
          const tables = tableNames(db);
          if (tables.includes('sessions')) capabilities.push('indexRows');
          if (tables.includes('kv_store')) capabilities.push('kvBlobs');
        } finally {
          db.close();
        }
      }
    }
    return {
      available: true,
      root,
      evidence: `${capabilities.length > 0 ? capabilities.join(', ') : 'empty root'} at ${root}`,
      capabilities,
    };
  }

  async plan(family: Family, cfg: PluginConfig): Promise<AdapterPlan> {
    const root = this.root();
    const items: PlanItem[] = [];
    const notes: string[] = [];

    const snapshots = findFamilySnapshots(family, root);
    items.push(...snapshotPlanItems(snapshots, !cfg.biliJson));
    if (!cfg.biliJson && snapshots.length > 0) notes.push(`${snapshots.length} snapshot(s) reported only (biliJson off)`);

    const dbFile = indexDbPath(root);
    if (fs.existsSync(dbFile)) {
      const db = await openIndex(dbFile, true);
      if (db === undefined) {
        notes.push('index.db present but unreadable (node:sqlite missing?)');
      } else {
        try {
          const rows = countFamilyRows(db, family);
          if (rows > 0) {
            items.push({
              key: `index-rows:${dbFile}`,
              kind: 'index-rows',
              target: dbFile,
              rows,
              risk: 'medium',
              ...(cfg.biliIndexDb ? {} : { reportOnly: true }),
            });
            if (!cfg.biliIndexDb) notes.push(`${rows} index row(s) reported only (biliIndexDb off)`);
          }
        } finally {
          db.close();
        }
      }
    }

    return { adapter: this.id, family, items, notes, writes: items.filter((item) => item.reportOnly !== true).length };
  }

  async apply(plan: AdapterPlan, opts: ApplyOptions): Promise<AdapterResult> {
    const outcomes: ItemOutcome[] = [];
    if (opts.dryRun) {
      return { adapter: this.id, outcomes: plan.items.map((item) => ({ key: item.key, status: 'skipped' as const, reason: 'dry-run' })) };
    }

    // Snapshots first: cheap, atomic, and a failed move never risks the index.
    for (const item of plan.items) {
      if (item.kind !== 'snapshot' || item.reportOnly === true) continue;
      try {
        await moveSnapshot(item.target, plan.family.id, opts.batchDir);
        outcomes.push({ key: item.key, status: 'done' });
      } catch (error) {
        outcomes.push({ key: item.key, status: 'failed', detail: String(error) });
      }
    }

    const rowItem = plan.items.find((item) => item.kind === 'index-rows' && item.reportOnly !== true);
    if (rowItem === undefined) return { adapter: this.id, outcomes };

    const dbFile = indexDbPath(this.root());
    let backupPath: string | undefined;
    try {
      // Never delete a row when the snapshot itself failed: a purge that cannot
      // be rolled back is not worth the risk.
      const saved = await backupIndexDb(dbFile, path.join(opts.batchDir, 'index'));
      backupPath = path.join(opts.batchDir, 'index', saved.files[0] ?? 'index.db');
      const db = await openIndex(dbFile);
      if (db === undefined) throw new Error('cannot open index.db for writing');
      try {
        const deleted: Record<string, number | string> = {};
        purgeFamily(db, plan.family, deleted);
        outcomes.push({ key: rowItem.key, status: 'done', detail: JSON.stringify(deleted) });
      } finally {
        db.close();
      }
    } catch (error) {
      outcomes.push({ key: rowItem.key, status: 'failed', detail: String(error) });
    }
    return { adapter: this.id, outcomes, ...(backupPath === undefined ? {} : { backup: backupPath }) };
  }

  async verify(family: Family): Promise<VerifyResult> {
    const root = this.root();
    const dbFile = indexDbPath(root);
    let rows = 0;
    let kvHits: string[] = [];
    let readable = true;

    if (fs.existsSync(dbFile)) {
      const db = await openIndex(dbFile, true);
      if (db === undefined) {
        readable = false;
      } else {
        try {
          const result = verifyFamily(db, family);
          rows = result.rows;
          kvHits = result.kvHits;
        } finally {
          db.close();
        }
      }
    }
    const snapshots = remainingSnapshots(family, root);
    const remaining: PlanItem[] = [
      ...snapshots.map((file) => ({ key: `snapshot:${file}`, kind: 'snapshot', target: file, risk: 'low' as const })),
      ...(rows > 0 ? [{ key: 'index-rows', kind: 'index-rows', target: dbFile, rows, risk: 'medium' as const }] : []),
    ];
    const ok = readable && remaining.length === 0 && kvHits.length === 0;
    return {
      adapter: this.id,
      ok,
      remaining,
      evidence: `rows=${rows} snapshots=${snapshots.length} kv=${kvHits.length > 0 ? kvHits.join('|') : 'clean'}${
        readable ? '' : ' (index unreadable)'
      }`,
    };
  }
}

export interface SweepOptions {
  store: SessionStore;
  cfg: PluginConfig;
  batchDir: string;
  logger: { info(message: string): void; warn(message: string): void };
  root?: string;
}

/**
 * Boot sweep: drop bindings that neither bili nor DSH still owns.
 *
 * The lane keeps the whole conversation table in memory and rewrites the blobs
 * from memory on every request, so a binding removed during the purge is back
 * within seconds. The window that holds is *before the lane starts*, which is
 * why this runs once at boot.
 */
export async function sweepGhostKv(opts: SweepOptions): Promise<{
  ok: boolean;
  reason?: string;
  total?: number;
  kept?: number;
  backup?: string;
  dryRun?: boolean;
}> {
  const root = opts.root ?? biliSessionsRoot();
  const dbFile = indexDbPath(root);
  if (!fs.existsSync(dbFile)) return { ok: false, reason: 'index.db-missing' };

  const db = await openIndex(dbFile);
  if (db === undefined) return { ok: false, reason: 'sqlite-unavailable' };
  try {
    const indexed = new Set<string>();
    try {
      for (const row of db.prepare('SELECT session_id AS id FROM sessions').all() as Array<{ id?: unknown }>) {
        if (typeof row.id === 'string' && row.id.length > 0) indexed.add(row.id);
      }
    } catch {
      return { ok: false, reason: 'sessions-table-missing' };
    }
    // A fresh or half-built index must never read as "every session is gone".
    if (indexed.size === 0) return { ok: true, reason: 'no-sessions', total: 0 };

    const scan = planGhostKv(db, { indexed, live: opts.store.liveIds() });
    if (scan.total === 0) return { ok: true, total: 0, kept: scan.kept };
    if (opts.cfg.dryRun) return { ok: true, dryRun: true, total: scan.total, kept: scan.kept };

    const { backup, removed } = await writeGhostKv(db, scan, opts.batchDir);
    opts.logger.info(
      `session-leftover-purge: ghost kv sweep removed ${scan.total} binding(s) ${JSON.stringify(removed)} ` +
        `(indexed=${indexed.size}, backup=${path.basename(backup)})`,
    );
    return { ok: true, total: scan.total, kept: scan.kept, backup };
  } catch (error) {
    return { ok: false, reason: `sweep-failed:${String(error)}` };
  } finally {
    db.close();
  }
}
