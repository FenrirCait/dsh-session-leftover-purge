// Contract tests for the bili adapter: snapshots, index rows, refcounts, kv
// blobs, pinned checkpoints and the dry-run/report-only switches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BiliAdapter } from '../lib/adapters/bili.js';

const PARENT = 'session-11111111-2222-3333-4444-555555555555';
const CHILD = `${PARENT}|sub:abcdef012345`;
const OTHER = 'session-99999999-8888-7777-6666-555555555555';

const QUIET = { info() {}, warn() {} };

const CFG = {
  enabled: true,
  biliJson: true,
  biliIndexDb: true,
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

const DDL = `
CREATE TABLE content (hash TEXT PRIMARY KEY, byte_len INTEGER NOT NULL DEFAULT 0, refcount INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, content_hash TEXT NOT NULL);
CREATE TABLE message_media (session_id TEXT NOT NULL, seq INTEGER NOT NULL, media_hash TEXT NOT NULL);
CREATE TABLE blocks (block_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, summary_hash TEXT NOT NULL, one_hash TEXT);
CREATE TABLE refs (session_id TEXT NOT NULL, ord INTEGER NOT NULL, raw_id TEXT);
CREATE TABLE dead_refs (session_id TEXT NOT NULL, ord INTEGER NOT NULL, ref TEXT);
CREATE TABLE ccr_entries (session_id TEXT NOT NULL, ord INTEGER NOT NULL, ccr_key TEXT, content_hash TEXT);
CREATE TABLE checkpoints (cp_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, state_hash TEXT NOT NULL);
CREATE TABLE session_ext (session_id TEXT NOT NULL, key TEXT);
CREATE TABLE conversations (namespace TEXT, conversation_id TEXT, session_id TEXT);
CREATE TABLE kv_store (namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (namespace, key));
`;

function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bili-'));
  const biliRoot = path.join(root, 'bili');
  const protocol = path.join(biliRoot, 'anthropic');
  fs.mkdirSync(protocol, { recursive: true });

  const db = new DatabaseSync(path.join(biliRoot, 'index.db'));
  db.exec(DDL);
  const content = db.prepare('INSERT INTO content (hash, refcount) VALUES (?, ?)');
  content.run('hash-shared', 2);
  for (const hash of ['hash-p2', 'hash-media', 'hash-sum', 'hash-one', 'hash-ccr', 'hash-state', 'hash-pinned', 'hash-child', 'hash-other']) {
    content.run(hash, 1);
  }
  for (const id of [PARENT, CHILD, OTHER]) db.prepare('INSERT INTO sessions (session_id) VALUES (?)').run(id);
  const msg = db.prepare('INSERT INTO messages (session_id, seq, content_hash) VALUES (?, ?, ?)');
  msg.run(PARENT, 1, 'hash-shared');
  msg.run(PARENT, 2, 'hash-p2');
  msg.run(CHILD, 1, 'hash-child');
  msg.run(OTHER, 1, 'hash-shared');
  db.prepare('INSERT INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)').run(PARENT, 2, 'hash-media');
  db.prepare('INSERT INTO blocks (block_id, session_id, summary_hash, one_hash) VALUES (?, ?, ?, ?)').run('b1', PARENT, 'hash-sum', 'hash-one');
  db.prepare('INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)').run(PARENT, 0, 'k', 'hash-ccr');
  db.prepare('INSERT INTO checkpoints (cp_id, session_id, pinned, state_hash) VALUES (?, ?, ?, ?)').run('cp1', PARENT, 0, 'hash-state');
  db.prepare('INSERT INTO checkpoints (cp_id, session_id, pinned, state_hash) VALUES (?, ?, ?, ?)').run('cp2', PARENT, 1, 'hash-pinned');
  db.prepare('INSERT INTO refs (session_id, ord, raw_id) VALUES (?, ?, ?)').run(PARENT, 0, 'm1');
  db.prepare('INSERT INTO dead_refs (session_id, ord, ref) VALUES (?, ?, ?)').run(PARENT, 0, 'm0');
  db.prepare('INSERT INTO session_ext (session_id, key) VALUES (?, ?)').run(PARENT, 'tail');
  db.prepare('INSERT INTO conversations (namespace, conversation_id, session_id) VALUES (?, ?, ?)').run('proxy', PARENT, PARENT);

  const table = {};
  for (const id of [PARENT, CHILD, OTHER]) table[id] = { sessionId: id, lastSeen: 1 };
  db.prepare('INSERT INTO kv_store VALUES (?, ?, ?, ?)').run('plugin-conversations', 'table', JSON.stringify(table), 1);
  db.prepare('INSERT INTO kv_store VALUES (?, ?, ?, ?)').run(
    'prefix-affinity',
    'v1',
    JSON.stringify({ version: 1, entries: [PARENT, CHILD, OTHER].map((id) => ({ sessionId: id })) }),
    1,
  );
  db.prepare('INSERT INTO kv_store VALUES (?, ?, ?, ?)').run(
    'session-order',
    'v1',
    JSON.stringify({ version: 1, entries: [PARENT, CHILD, OTHER].map((id) => ({ id })) }),
    1,
  );
  db.close();

  for (const [name, id] of [
    ['parent.json', PARENT],
    ['parent-subagent.json', CHILD],
    ['other.json', OTHER],
  ]) {
    fs.writeFileSync(path.join(protocol, name), JSON.stringify({ id }));
  }

  const state = path.join(root, 'state');
  process.env.DSH_HOME = state;
  process.env.BILI_SESSIONS_DIR = biliRoot;

  return { root, biliRoot, protocol, state, adapter: new BiliAdapter({ root: biliRoot }) };
}

function openDb(biliRoot) {
  return new DatabaseSync(path.join(biliRoot, 'index.db'));
}

test('plan lists the family only, and switches decide report-only', async () => {
  const { adapter } = scenario();
  const plan = await adapter.plan({ id: PARENT, children: [CHILD] }, CFG);
  // two snapshots + one index-rows item
  assert.equal(plan.writes, 3);
  assert.equal(plan.items.filter((item) => item.kind === 'snapshot').length, 2);
  assert.equal(plan.items.filter((item) => item.kind === 'index-rows').length, 1);

  const reportOnly = await adapter.plan({ id: PARENT, children: [CHILD] }, { ...CFG, biliJson: false, biliIndexDb: false });
  assert.equal(reportOnly.writes, 0);
  assert.ok(reportOnly.items.every((item) => item.reportOnly === true));
});

test('apply removes the family, releases refcounts and keeps pinned/shared data', async () => {
  const { adapter, biliRoot, protocol, root } = scenario();
  const plan = await adapter.plan({ id: PARENT, children: [CHILD] }, CFG);
  const result = await adapter.apply(plan, { cfg: CFG, dryRun: false, batchDir: path.join(root, 'batch'), logger: QUIET });

  assert.equal(result.outcomes.filter((o) => o.status === 'done').length, 3); // 2 snapshots + rows
  assert.ok(fs.existsSync(result.backup));

  const db = openDb(biliRoot);
  const count = (table, where, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
  assert.equal(count('messages', 'session_id = ?', OTHER), 1);
  assert.equal(count('messages', "session_id = ? OR session_id LIKE ?", PARENT, `${PARENT}|sub:%`), 0);
  const refcount = (hash) => db.prepare('SELECT refcount FROM content WHERE hash = ?').get(hash)?.refcount;
  assert.equal(refcount('hash-shared'), 1);
  assert.equal(refcount('hash-p2'), undefined);
  assert.equal(refcount('hash-pinned'), 1);
  assert.equal(count('checkpoints', 'cp_id = ?', 'cp2'), 1);
  const kv = JSON.stringify(db.prepare('SELECT value_json FROM kv_store').all());
  assert.ok(!kv.includes(PARENT) && !kv.includes('|sub:'));
  assert.ok(kv.includes(OTHER));
  db.close();

  assert.deepEqual(fs.readdirSync(protocol), ['other.json']);
  const verify = await adapter.verify({ id: PARENT, children: [CHILD] });
  assert.equal(verify.ok, true, verify.evidence);
});

test('dry run plans but never writes', async () => {
  const { adapter, biliRoot, protocol } = scenario();
  const plan = await adapter.plan({ id: PARENT, children: [CHILD] }, { ...CFG, dryRun: true });
  const result = await adapter.apply(plan, { cfg: { ...CFG, dryRun: true }, dryRun: true, batchDir: path.join(os.tmpdir(), 'nope'), logger: QUIET });
  assert.ok(result.outcomes.every((outcome) => outcome.status === 'skipped' && outcome.reason === 'dry-run'));
  assert.equal(fs.readdirSync(protocol).length, 3);
  const db = openDb(biliRoot);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 3);
  db.close();
});

test('an id that is not a session is not accepted as a family root', async () => {
  const { adapter } = scenario();
  const plan = await adapter.plan({ id: 'not-a-session', children: [] }, CFG);
  assert.equal(plan.writes, 0);
});
