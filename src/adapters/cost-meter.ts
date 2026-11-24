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
  VerifyResult,
} from '../types.js';
import { inFamily } from '../core/family.js';
import { costMeterDetailsRoot, costMeterRoot, ledgerFile } from '../runtime/paths.js';

const LEDGER = 'ledger.json';
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const DETAIL_DIRS = ['groups', 'streams', 'calls'] as const;

interface LedgerLike {
  days?: Record<string, { sessions?: Array<{ id?: unknown }> }>;
  [key: string]: unknown;
}

interface LedgerHit {
  day: string;
  index: number;
  id: string;
}

function readJson(file: string): unknown | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every `days[*].sessions[]` entry that belongs to this family. */
function ledgerHits(ledger: LedgerLike, family: Family): LedgerHit[] {
  const hits: LedgerHit[] = [];
  const days = ledger.days;
  if (days === undefined || days === null || typeof days !== 'object') return hits;
  for (const [day, bucket] of Object.entries(days)) {
    const sessions = bucket?.sessions;
    if (!Array.isArray(sessions)) continue;
    sessions.forEach((entry, index) => {
      const id = entry?.id;
      if (typeof id === 'string' && inFamily(id, family.id)) hits.push({ day, index, id });
    });
  }
  return hits;
}

/** Detail file belongs to the family when a structured field says so, or (for
 * files that do not parse at all) when the id appears in the first 8 KB. */
function detailFileMatches(file: string, family: Family): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return false;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!text.includes(family.id) && !family.children.some((child) => text.includes(child))) return false;

  const owns = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return inFamily(record.sessionId, family.id) || inFamily(record.session, family.id) || inFamily(record.id, family.id);
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.some(owns);
      if (owns(parsed)) return true;
      // Fall through to the jsonl scan only for multi-line files.
      if (!trimmed.includes('\n')) return false;
    } catch {
      /* jsonl */
    }
  }
  for (const line of trimmed.split('\n')) {
    const row = line.trim();
    if (!row.startsWith('{')) continue;
    try {
      if (owns(JSON.parse(row))) return true;
    } catch {
      /* malformed line */
    }
  }
  return false;
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** cost-meter keeps its own reprice snapshots beside the ledger (up to tens of MB each). */
function repriceBackups(): { files: string[]; bytes: number } {
  const root = costMeterRoot();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root).filter((name) => name.startsWith(`${LEDGER}.before-`) && name.endsWith('.json'));
  } catch {
    return { files: [], bytes: 0 };
  }
  let bytes = 0;
  for (const name of entries) {
    try {
      bytes += fs.statSync(path.join(root, name)).size;
    } catch {
      /* vanished */
    }
  }
  return { files: entries, bytes };
}

export class CostMeterAdapter implements Adapter {
  readonly id = 'cost-meter' as const;

  constructor(private readonly deps: { root?: string } = {}) {}

  private ledgerPath(): string {
    return this.deps.root === undefined ? ledgerFile() : path.join(this.deps.root, LEDGER);
  }

  async probe(): Promise<Probe> {
    const file = this.ledgerPath();
    const capabilities: string[] = [];
    if (fs.existsSync(file)) capabilities.push('ledger');
    if (fs.existsSync(costMeterDetailsRoot())) capabilities.push('details');
    const backups = repriceBackups();
    if (backups.files.length > 0) capabilities.push(`repriceBackups:${backups.files.length}`);
    return {
      available: fs.existsSync(costMeterRoot()) || fs.existsSync(file),
      root: this.deps.root ?? costMeterRoot(),
      evidence: capabilities.length > 0 ? capabilities.join(', ') : 'no ledger and no detail files',
      capabilities,
    };
  }

  async plan(family: Family, cfg: PluginConfig): Promise<AdapterPlan> {
    const items: PlanItem[] = [];
    const notes: string[] = [];

    const file = this.ledgerPath();
    if (fs.existsSync(file)) {
      const parsed = readJson(file);
      const hits = parsed !== undefined && typeof parsed === 'object' ? ledgerHits(parsed as LedgerLike, family) : [];
      if (hits.length > 0) {
        items.push({
          key: `ledger-rows:${file}`,
          kind: 'ledger-row',
          target: file,
          rows: hits.length,
          risk: 'high',
          ...(cfg.costMeterLedger ? {} : { reportOnly: true }),
        });
        if (!cfg.costMeterLedger) notes.push(`${hits.length} ledger row(s) reported only (costMeterLedger off)`);
      } else if (parsed === undefined) {
        notes.push('ledger.json unreadable or too large — left untouched');
      }
    }

    const detailsRoot = costMeterDetailsRoot();
    for (const dir of DETAIL_DIRS) {
      for (const detail of listFilesRecursive(path.join(detailsRoot, dir))) {
        if (!detailFileMatches(detail, family)) continue;
        items.push({
          key: `detail:${detail}`,
          kind: 'detail-file',
          target: detail,
          bytes: (() => {
            try {
              return fs.statSync(detail).size;
            } catch {
              return 0;
            }
          })(),
          risk: 'medium',
          ...(cfg.costMeterFiles ? {} : { reportOnly: true }),
        });
      }
    }
    if (!cfg.costMeterFiles) {
      const reported = items.filter((item) => item.kind === 'detail-file').length;
      if (reported > 0) notes.push(`${reported} detail file(s) reported only (costMeterFiles off)`);
    }

    const backups = repriceBackups();
    if (cfg.costMeterReportBackups && backups.files.length > 0) {
      notes.push(
        `${backups.files.length} cost-meter reprice backup(s) occupy ${(backups.bytes / 1024 / 1024).toFixed(0)} MB ` +
          '(cost-meter owns them; never deleted here)',
      );
    }

    return { adapter: this.id, family, items, notes, writes: items.filter((item) => item.reportOnly !== true).length };
  }

  async apply(plan: AdapterPlan, opts: ApplyOptions): Promise<AdapterResult> {
    const outcomes: ItemOutcome[] = [];
    if (opts.dryRun) {
      return { adapter: this.id, outcomes: plan.items.map((item) => ({ key: item.key, status: 'skipped' as const, reason: 'dry-run' })) };
    }

    const rowItem = plan.items.find((item) => item.kind === 'ledger-row' && item.reportOnly !== true);
    if (rowItem !== undefined) {
      const result = await this.applyLedger(plan.family, opts);
      outcomes.push(...result.outcomes);
      if (result.backup !== undefined) {
        return { adapter: this.id, outcomes: [...outcomes, ...(await this.applyDetails(plan, opts))], backup: result.backup };
      }
    }
    outcomes.push(...(await this.applyDetails(plan, opts)));
    return { adapter: this.id, outcomes };
  }

  private async applyLedger(family: Family, opts: ApplyOptions): Promise<{ outcomes: ItemOutcome[]; backup?: string }> {
    const file = this.ledgerPath();
    const lockDir = `${file}.lock`;
    if (fs.existsSync(lockDir)) return { outcomes: [{ key: `ledger-rows:${file}`, status: 'skipped', reason: 'busy:cost-meter-lock-held' }] };

    let parsed: LedgerLike;
    let before: fs.Stats;
    try {
      before = await fs.promises.stat(file);
      parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as LedgerLike;
    } catch (error) {
      return { outcomes: [{ key: `ledger-rows:${file}`, status: 'failed', detail: String(error) }] };
    }

    const hits = ledgerHits(parsed, family);
    if (hits.length === 0) return { outcomes: [{ key: `ledger-rows:${file}`, status: 'skipped', reason: 'nothing-to-remove' }] };

    // Nothing is written until the ledger is safely inside the batch.
    const batchFile = path.join(opts.batchDir, 'ledger.json');
    try {
      await fs.promises.mkdir(opts.batchDir, { recursive: true });
      await fs.promises.copyFile(file, batchFile);
    } catch (error) {
      return { outcomes: [{ key: `ledger-rows:${file}`, status: 'failed', detail: `backup-failed:${String(error)}` }] };
    }

    // cost-meter serialises with `<ledger>.lock`; we never create it, only yield.
    const after = await fs.promises.stat(file);
    if (fs.existsSync(lockDir)) return { outcomes: [{ key: `ledger-rows:${file}`, status: 'skipped', reason: 'busy:lock-appeared' }], backup: batchFile };
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      return { outcomes: [{ key: `ledger-rows:${file}`, status: 'skipped', reason: 'changed-during-read' }], backup: batchFile };
    }

    for (const [day, bucket] of Object.entries(parsed.days ?? {})) {
      const sessions = bucket?.sessions;
      if (!Array.isArray(sessions)) continue;
      for (let index = sessions.length - 1; index >= 0; index -= 1) {
        const id = sessions[index]?.id;
        if (typeof id === 'string' && inFamily(id, family.id)) sessions.splice(index, 1);
      }
      void day;
    }

    const tmp = `${file}.${process.pid}.purge-tmp`;
    try {
      await fs.promises.writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      const final = await fs.promises.stat(file);
      if (fs.existsSync(lockDir) || final.mtimeMs !== before.mtimeMs || final.size !== before.size) {
        await fs.promises.rm(tmp, { force: true });
        return { outcomes: [{ key: `ledger-rows:${file}`, status: 'skipped', reason: 'changed-before-rename' }], backup: batchFile };
      }
      await fs.promises.rename(tmp, file);
    } catch (error) {
      await fs.promises.rm(tmp, { force: true });
      return { outcomes: [{ key: `ledger-rows:${file}`, status: 'failed', detail: String(error) }], backup: batchFile };
    }
    return { outcomes: [{ key: `ledger-rows:${file}`, status: 'done', detail: `removed=${hits.length} totals kept` }], backup: batchFile };
  }

  private async applyDetails(plan: AdapterPlan, opts: ApplyOptions): Promise<ItemOutcome[]> {
    const outcomes: ItemOutcome[] = [];
    const files = plan.items.filter((item) => item.kind === 'detail-file' && item.reportOnly !== true);
    if (files.length === 0) return outcomes;

    const root = costMeterDetailsRoot();
    const backupRoot = path.join(opts.batchDir, 'cost-files');
    const copied = new Set<string>();
    for (const item of files) {
      const rel = path.relative(root, item.target);
      try {
        const target = path.join(backupRoot, rel);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(item.target, target);
        copied.add(item.key);
      } catch (error) {
        outcomes.push({ key: item.key, status: 'failed', detail: `backup:${String(error)}` });
      }
    }
    for (const item of files) {
      if (!copied.has(item.key)) continue;
      try {
        await fs.promises.unlink(item.target);
        outcomes.push({ key: item.key, status: 'done' });
      } catch (error) {
        outcomes.push({ key: item.key, status: 'failed', detail: `remove:${String(error)}` });
      }
    }
    return outcomes;
  }

  async verify(family: Family): Promise<VerifyResult> {
    const remaining: PlanItem[] = [];
    const file = this.ledgerPath();
    if (fs.existsSync(file)) {
      const parsed = readJson(file);
      if (parsed !== undefined) {
        const hits = ledgerHits(parsed as LedgerLike, family);
        if (hits.length > 0) remaining.push({ key: `ledger-rows:${file}`, kind: 'ledger-row', target: file, rows: hits.length, risk: 'high' });
      }
    }
    for (const dir of DETAIL_DIRS) {
      for (const detail of listFilesRecursive(path.join(costMeterDetailsRoot(), dir))) {
        if (detailFileMatches(detail, family)) {
          remaining.push({ key: `detail:${detail}`, kind: 'detail-file', target: detail, risk: 'medium' });
        }
      }
    }
    return {
      adapter: this.id,
      ok: remaining.length === 0,
      remaining,
      evidence: `ledger=${remaining.filter((item) => item.kind === 'ledger-row').length} details=${
        remaining.filter((item) => item.kind === 'detail-file').length
      }`,
    };
  }
}
