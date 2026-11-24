import type {
  Adapter,
  AdapterPlan,
  AdapterResult,
  Family,
  Logger,
  PluginConfig,
  SessionStore,
  VerifyResult,
} from '../types.js';
import { familyRootOf } from '../core/family.js';
import { listSnapshotFiles, readSnapshotId } from '../adapters/bili-snapshots.js';
import { trashDir } from './paths.js';

export interface AdapterRun {
  adapter: string;
  probed: boolean;
  plan?: AdapterPlan;
  result?: AdapterResult;
  verify?: VerifyResult;
  skipped?: string;
  error?: string;
}

export interface FamilyRun {
  family: Family;
  skipped?: string;
  batchDir?: string;
  adapters: AdapterRun[];
}

export interface PurgeDeps {
  cfg: PluginConfig;
  logger: Logger;
  store: SessionStore;
  adapters: Adapter[];
}

/**
 * Run every adapter for one family: probe → plan → apply → verify.
 *
 * Ordering rules that matter:
 *  - a family the session store still has is never touched (the store answers
 *    "alive" when it cannot read the backend at all, so a broken probe fails
 *    closed);
 *  - `plan()` is read-only, so `dryRun` needs no special adapter code;
 *  - one adapter failing never stops the next one: a broken cost-meter must not
 *    keep bili's leftovers alive.
 */
export async function purgeFamily(family: Family, deps: PurgeDeps): Promise<FamilyRun> {
  if (deps.store.has(family.id)) return { family, skipped: 'session-alive', adapters: [] };

  const batchDir = trashDir();
  const runs: AdapterRun[] = [];

  for (const adapter of deps.adapters) {
    let available = false;
    try {
      available = (await adapter.probe()).available;
    } catch (error) {
      runs.push({ adapter: adapter.id, probed: false, error: `probe:${String(error)}` });
      continue;
    }
    if (!available) {
      runs.push({ adapter: adapter.id, probed: false, skipped: 'unavailable' });
      continue;
    }

    let plan: AdapterPlan;
    try {
      plan = await adapter.plan(family, deps.cfg);
    } catch (error) {
      runs.push({ adapter: adapter.id, probed: true, error: `plan:${String(error)}` });
      continue;
    }
    if (plan.writes === 0) {
      runs.push({ adapter: adapter.id, probed: true, plan, skipped: 'nothing-to-do' });
      continue;
    }
    if (deps.cfg.dryRun) {
      runs.push({ adapter: adapter.id, probed: true, plan, skipped: 'dry-run' });
      continue;
    }

    try {
      const result = await adapter.apply(plan, { cfg: deps.cfg, dryRun: false, batchDir, logger: deps.logger });
      runs.push({ adapter: adapter.id, probed: true, plan, result });
    } catch (error) {
      runs.push({ adapter: adapter.id, probed: true, plan, error: `apply:${String(error)}` });
    }
  }

  if (!deps.cfg.dryRun) {
    for (const run of runs) {
      if (run.result === undefined) continue;
      const adapter = deps.adapters.find((candidate) => candidate.id === run.adapter);
      if (adapter === undefined) continue;
      try {
        run.verify = await adapter.verify(family);
      } catch (error) {
        run.error = `verify:${String(error)}`;
      }
    }
  }

  return { family, batchDir, adapters: runs };
}

export interface OrphanFamily {
  id: string;
  files: string[];
}

export interface ReconcileResult {
  scanned: number;
  orphans: OrphanFamily[];
}

/**
 * Read-only pass: bili snapshots whose session family DSH no longer has.
 *
 * Grouped by family root, because a subagent snapshot (`session-x|sub:y`) is
 * not its own orphan — purging it alone would leave the parent's data behind
 * and the plugin used to report one line per child.
 */
export function findOrphanFamilies(store: SessionStore, root?: string): ReconcileResult {
  const byFamily = new Map<string, string[]>();
  const files = listSnapshotFiles(root);
  for (const file of files) {
    const id = readSnapshotId(file);
    if (id === undefined) continue;
    const family = familyRootOf(id);
    if (store.has(family)) continue;
    const list = byFamily.get(family) ?? [];
    list.push(file);
    byFamily.set(family, list);
  }
  return {
    scanned: files.length,
    orphans: [...byFamily.entries()].map(([id, list]) => ({ id, files: list.sort() })),
  };
}
