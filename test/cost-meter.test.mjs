// Contract tests for the cost-meter adapter: ledger rows and detail files are
// opt-in, totals are never recomputed, and a live lock means "hands off".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CostMeterAdapter } from '../lib/adapters/cost-meter.js';

const PARENT = 'session-11111111-2222-3333-4444-555555555555';
const OTHER = 'session-99999999-8888-7777-6666-555555555555';
const QUIET = { info() {}, warn() {} };

const BASE = {
  enabled: true,
  biliJson: false,
  biliIndexDb: false,
  costMeterLedger: false,
  costMeterFiles: false,
  costMeterReportBackups: false,
  dshContextCache: false,
  archiveProjcache: false,
  dryRun: false,
  trashRetentionDays: 7,
  trashMaxMb: 2048,
  reconcileOnBoot: false,
  autoPurgeOrphans: false,
  bootDelayMs: 0,
  sweepGhostKvOnBoot: false,
  vacuumIndexDb: false,
  restoreBackupTrigger: 0,
  deleteBackupsTrigger: 0,
  backupLedgerTrigger: 0,
};

function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cm-'));
  const home = path.join(root, 'home');
  const cm = path.join(home, 'storages', 'cost-meter');
  const details = path.join(cm, 'ledger.json.billion-context');
  fs.mkdirSync(path.join(details, 'groups'), { recursive: true });
  fs.mkdirSync(path.join(details, 'calls'), { recursive: true });
  process.env.DSH_HOME = home;

  const ledger = {
    version: 1,
    days: {
      '2026-11-20': {
        date: '2026-11-20',
        calls: 7,
        cost: 1.25,
        sessions: [
          { id: PARENT, cost: 1.0, calls: 3 },
          { id: OTHER, cost: 0.25, calls: 4 },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(cm, 'ledger.json'), JSON.stringify(ledger, null, 2));
  fs.writeFileSync(path.join(details, 'groups', 'g1.json'), JSON.stringify({ sessionId: PARENT, tokens: 10 }));
  fs.writeFileSync(path.join(details, 'calls', 'c1.jsonl'), `${JSON.stringify({ sessionId: OTHER })}\n`);

  return { root, home, cm, details, adapter: new CostMeterAdapter() };
}

test('both targets are report-only until the operator turns them on', async () => {
  const { adapter } = scenario();
  const plan = await adapter.plan({ id: PARENT, children: [] }, BASE);
  assert.equal(plan.writes, 0);
  assert.equal(plan.items.length, 2); // one ledger row + one detail file
  assert.ok(plan.items.every((item) => item.reportOnly === true));
  assert.ok(plan.notes.some((note) => note.includes('costMeterLedger off')));
});

test('enabled: ledger row and detail file are removed, totals untouched, backups kept', async () => {
  const { adapter, cm, details, root } = scenario();
  const cfg = { ...BASE, costMeterLedger: true, costMeterFiles: true };
  const plan = await adapter.plan({ id: PARENT, children: [] }, cfg);
  assert.equal(plan.writes, 2);

  const batch = path.join(root, 'batch');
  const result = await adapter.apply(plan, { cfg, dryRun: false, batchDir: batch, logger: QUIET });
  assert.equal(result.outcomes.filter((outcome) => outcome.status === 'done').length, 2);
  assert.ok(fs.existsSync(path.join(batch, 'ledger.json')));
  assert.ok(fs.existsSync(path.join(batch, 'cost-files', 'groups', 'g1.json')));

  const ledger = JSON.parse(fs.readFileSync(path.join(cm, 'ledger.json'), 'utf8'));
  const day = ledger.days['2026-11-20'];
  assert.equal(day.sessions.length, 1);
  assert.equal(day.sessions[0].id, OTHER);
  // The books still say what was really spent.
  assert.equal(day.calls, 7);
  assert.equal(day.cost, 1.25);

  assert.equal(fs.existsSync(path.join(details, 'groups', 'g1.json')), false);
  assert.equal(fs.existsSync(path.join(details, 'calls', 'c1.jsonl')), true);

  const verify = await adapter.verify({ id: PARENT, children: [] });
  assert.equal(verify.ok, true, verify.evidence);
});

test('a live cost-meter lock means hands off', async () => {
  const { adapter, cm } = scenario();
  fs.mkdirSync(path.join(cm, 'ledger.json.lock'));
  const cfg = { ...BASE, costMeterLedger: true };
  const plan = await adapter.plan({ id: PARENT, children: [] }, cfg);
  const result = await adapter.apply(plan, { cfg, dryRun: false, batchDir: path.join(os.tmpdir(), 'dsh-cm-batch'), logger: QUIET });
  assert.ok(result.outcomes.some((outcome) => outcome.status === 'skipped' && outcome.reason === 'busy:cost-meter-lock-held'));
  const ledger = JSON.parse(fs.readFileSync(path.join(cm, 'ledger.json'), 'utf8'));
  assert.equal(ledger.days['2026-11-20'].sessions.length, 2);
});

test('dry run reports without writing', async () => {
  const { adapter, cm } = scenario();
  const cfg = { ...BASE, costMeterLedger: true, dryRun: true };
  const plan = await adapter.plan({ id: PARENT, children: [] }, cfg);
  const result = await adapter.apply(plan, { cfg, dryRun: true, batchDir: path.join(os.tmpdir(), 'dsh-cm-dry'), logger: QUIET });
  assert.ok(result.outcomes.every((outcome) => outcome.status === 'skipped'));
  const ledger = JSON.parse(fs.readFileSync(path.join(cm, 'ledger.json'), 'utf8'));
  assert.equal(ledger.days['2026-11-20'].sessions.length, 2);
});
