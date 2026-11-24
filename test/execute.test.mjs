// Orchestration rules: the session store is the first gate, a dry run never
// reaches apply(), and one broken adapter cannot stop the next one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { purgeFamily } from '../lib/runtime/execute.js';
import { familyOf } from '../lib/core/family.js';
import { DEFAULTS } from '../lib/config.js';

const FAMILY = familyOf('session-11111111-2222-3333-4444-555555555555');

function storeWith(alive) {
  return {
    probe: () => ({ kind: 'jsonl', root: '/tmp/x', evidence: 'fixture' }),
    liveIds: () => new Set(alive ? [FAMILY.id] : []),
    has: (id) => alive && id === FAMILY.id,
  };
}

function fakeAdapter(id, options = {}) {
  const calls = { plan: 0, apply: 0, verify: 0 };
  const adapter = {
    id,
    calls,
    async probe() {
      return { available: options.available !== false, evidence: 'fake', capabilities: [] };
    },
    async plan(family) {
      calls.plan += 1;
      if (options.failPlan) throw new Error('plan boom');
      const items = options.writes === 0
        ? []
        : [{ key: `${id}:item`, kind: 'snapshot', target: '/tmp/item', risk: 'low', ...(options.reportOnly ? { reportOnly: true } : {}) }];
      return { adapter: id, family, items, notes: [], writes: options.writes ?? 1 };
    },
    async apply(plan) {
      calls.apply += 1;
      if (options.failApply) throw new Error('apply boom');
      return { adapter: id, outcomes: plan.items.map((item) => ({ key: item.key, status: 'done' })) };
    },
    async verify() {
      calls.verify += 1;
      return { adapter: id, ok: true, remaining: [], evidence: 'clean' };
    },
  };
  return adapter;
}

const deps = (adapters, cfg = {}) => ({
  cfg: { ...DEFAULTS, ...cfg },
  logger: { info() {}, warn() {} },
  store: storeWith(false),
  adapters,
});

test('a session the store still has is never touched', async () => {
  const adapter = fakeAdapter('bili');
  const run = await purgeFamily(FAMILY, { ...deps([adapter]), store: storeWith(true) });
  assert.equal(run.skipped, 'session-alive');
  assert.equal(adapter.calls.plan, 0);
  assert.equal(adapter.calls.apply, 0);
});

test('dry run plans every adapter and applies none', async () => {
  const adapter = fakeAdapter('bili');
  const run = await purgeFamily(FAMILY, deps([adapter], { dryRun: true }));
  assert.equal(adapter.calls.plan, 1);
  assert.equal(adapter.calls.apply, 0);
  assert.equal(adapter.calls.verify, 0);
  assert.equal(run.adapters[0].skipped, 'dry-run');
});

test('an adapter with nothing to do is skipped, and report-only items never apply', async () => {
  const idle = fakeAdapter('cost-meter', { writes: 0 });
  const reporting = fakeAdapter('dsh-context', { reportOnly: true, writes: 0 });
  const run = await purgeFamily(FAMILY, deps([idle, reporting]));
  assert.deepEqual(run.adapters.map((entry) => entry.skipped), ['nothing-to-do', 'nothing-to-do']);
  assert.equal(idle.calls.apply + reporting.calls.apply, 0);
});

test('one failing adapter does not stop the next, and failures are reported', async () => {
  const broken = fakeAdapter('bili', { failPlan: true });
  const failingApply = fakeAdapter('cost-meter', { failApply: true });
  const healthy = fakeAdapter('dsh-context');
  const run = await purgeFamily(FAMILY, deps([broken, failingApply, healthy]));
  assert.match(run.adapters[0].error, /plan boom/);
  assert.match(run.adapters[1].error, /apply boom/);
  assert.equal(healthy.calls.apply, 1);
  assert.equal(run.adapters[2].verify?.ok, true);
});

test('an unavailable adapter is recorded, not called', async () => {
  const missing = fakeAdapter('archive-projcache', { available: false });
  const run = await purgeFamily(FAMILY, deps([missing]));
  assert.equal(run.adapters[0].skipped, 'unavailable');
  assert.equal(missing.calls.plan, 0);
});
