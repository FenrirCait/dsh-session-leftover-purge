// Fixture tests for the purge paths. Everything runs against a throwaway
// `index.db` built from bili's own DDL, inside a temp directory: no test ever
// reads or writes the live `~/.local/share/billion-context/sessions/index.db`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  findOrphanSnapshots,
  purgeBiliIndexDb,
  purgeSession,
  sweepGhostKv,
} from '../lib/purge.js';
import { sweepTrash } from '../lib/backup.js';

const UNKNOWN = 'session-00000000-0000-0000-0000-000000000000';

const PARENT = 'session-11111111-2222-3333-4444-555555555555';
const CHILD = `${PARENT}|sub:abcdef012345`;
const OTHER = 'session-99999999-8888-7777-6666-555555555555';

const QUIET = { info() {}, warn() {} };
const CFG = { biliJson: true, biliIndexDb: true, dryRun: false };

/** Columns are the ones the plugin actually reads; extra bili columns are not needed. */
const DDL = `
CREATE TABLE content (hash TEXT PRIMARY KEY, byte_len INTEGER NOT NULL DEFAULT 0, refcount INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_id TEXT, content_hash TEXT NOT NULL);
CREATE TABLE message_media (session_id TEXT NOT NULL, seq INTEGER NOT NULL, media_hash TEXT NOT NULL);
CREATE TABLE blocks (block_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, summary_hash TEXT NOT NULL, one_hash TEXT);
CREATE TABLE refs (session_id TEXT NOT NULL, ord INTEGER NOT NULL, raw_id TEXT);
CREATE TABLE dead_refs (session_id TEXT NOT NULL, ord INTEGER NOT NULL, ref TEXT);
CREATE TABLE ccr_entries (session_id TEXT NOT NULL, ord INTEGER NOT NULL, ccr_key TEXT, content_hash TEXT);
CREATE TABLE checkpoints (cp_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, state_hash TEXT NOT NULL);
CREATE TABLE session_ext (session_id TEXT NOT NULL, key TEXT);
CREATE TABLE conversations (namespace TEXT, conversation_id TEXT, session_id TEXT);
CREATE TABLE kv_store (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);
`;

function makeScenario({ liveTranscripts = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-'));
  const biliRoot = path.join(root, 'bili', 'sessions');
  const home = path.join(root, 'home');
  const protocolDir = path.join(biliRoot, 'anthropic');
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const id of liveTranscripts) {
    fs.mkdirSync(path.join(home, 'sessions', 'workspace', id), { recursive: true });
  }
  process.env.BILI_SESSIONS_DIR = biliRoot;
  process.env.DSH_HOME = home;

  const db = new DatabaseSync(path.join(biliRoot, 'index.db'));
  db.exec(DDL);
  const content = db.prepare('INSERT INTO content (hash, refcount) VALUES (?, ?)');
  // Shared blob: one reference from the parent, one from another session.
  content.run('hash-shared', 2);
  for (const hash of ['hash-parent-2', 'hash-media', 'hash-summary', 'hash-one', 'hash-ccr', 'hash-state', 'hash-pinned', 'hash-child', 'hash-other']) {
    content.run(hash, 1);
  }

  const sessions = db.prepare('INSERT INTO sessions (session_id, status) VALUES (?, ?)');
  for (const id of [PARENT, CHILD, OTHER]) sessions.run(id, 'active');

  const message = db.prepare('INSERT INTO messages (session_id, seq, msg_id, content_hash) VALUES (?, ?, ?, ?)');
  message.run(PARENT, 1, 'm1', 'hash-shared');
  message.run(PARENT, 2, 'm2', 'hash-parent-2');
  message.run(CHILD, 1, 'm1', 'hash-child');
  message.run(OTHER, 1, 'm1', 'hash-shared');

  db.prepare('INSERT INTO message_media (session_id, seq, media_hash) VALUES (?, ?, ?)').run(PARENT, 2, 'hash-media');

  const block = db.prepare('INSERT INTO blocks (block_id, session_id, summary_hash, one_hash) VALUES (?, ?, ?, ?)');
  block.run('b-parent', PARENT, 'hash-summary', 'hash-one');
  block.run('b-other', OTHER, 'hash-other', null);

  db.prepare('INSERT INTO ccr_entries (session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)').run(PARENT, 0, 'k', 'hash-ccr');
  const checkpoint = db.prepare('INSERT INTO checkpoints (cp_id, session_id, pinned, state_hash) VALUES (?, ?, ?, ?)');
  checkpoint.run('cp-live', PARENT, 0, 'hash-state');
  checkpoint.run('cp-pinned', PARENT, 1, 'hash-pinned');

  db.prepare('INSERT INTO refs (session_id, ord, raw_id) VALUES (?, ?, ?)').run(PARENT, 0, 'm1');
  db.prepare('INSERT INTO dead_refs (session_id, ord, ref) VALUES (?, ?, ?)').run(PARENT, 0, 'm0');
  db.prepare('INSERT INTO session_ext (session_id, key) VALUES (?, ?)').run(PARENT, 'tail');
  const conv = db.prepare('INSERT INTO conversations (namespace, conversation_id, session_id) VALUES (?, ?, ?)');
  for (const id of [PARENT, CHILD, OTHER]) conv.run('proxy', id, id);

  const kv = db.prepare('INSERT INTO kv_store (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)');
  const table = {};
  for (const id of [PARENT, CHILD, OTHER]) table[id] = { sessionId: id, lastSeen: 1 };
  kv.run('plugin-conversations', 'table', JSON.stringify(table), 1);
  kv.run(
    'prefix-affinity',
    'v1',
    JSON.stringify({ version: 1, entries: [PARENT, CHILD, OTHER].map((id) => ({ sessionId: id, depth: 1 })) }),
    1,
  );
  kv.run(
    'session-order',
    'v1',
    JSON.stringify({ version: 1, entries: [PARENT, CHILD, OTHER].map((id) => ({ id, kinds: [], frags: [] })) }),
    1,
  );
  db.close();

  // `|` is not a legal filename character on Windows, and bili names the file
  // after the session it belongs to anyway — the id *inside* the JSON is what
  // the plugin reads.
  for (const [name, id] of [
    ['parent.json', PARENT],
    ['parent-subagent.json', CHILD],
    ['other.json', OTHER],
  ]) {
    fs.writeFileSync(path.join(protocolDir, name), JSON.stringify({ id }));
  }

  return { root, biliRoot, home, protocolDir };
}

function readDb(biliRoot) {
  const db = new DatabaseSync(path.join(biliRoot, 'index.db'));
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  return {
    count: (table, where = '1=1', ...args) => Number(one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args).n),
    refcount: (hash) => {
      const row = one('SELECT refcount FROM content WHERE hash = ?', hash);
      return row === undefined ? undefined : Number(row.refcount);
    },
    sessions: () => all('SELECT session_id FROM sessions').map((row) => row.session_id).sort(),
    checkpoints: () => all('SELECT cp_id FROM checkpoints').map((row) => row.cp_id).sort(),
    kv: (namespace) => JSON.parse(one('SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?', namespace, namespace === 'plugin-conversations' ? 'table' : 'v1').value_json),
    kvUpdatedAt: (namespace) => Number(one('SELECT updated_at FROM kv_store WHERE namespace = ?', namespace).updated_at),
    close: () => db.close(),
  };
}

function snapshotFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

function trashBatches(home) {
  const dir = path.join(home, 'storages', 'session-leftover-purge', 'trash');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test('purgeSession removes the whole family and releases content refcounts', async () => {
  const { biliRoot, home, protocolDir } = makeScenario();
  const report = await purgeSession(PARENT, CFG, QUIET);
  assert.equal(report.biliIndexDb.ok, true);
  // One compact snapshot, not the three-file byte copy.
  assert.equal(report.biliIndexDb.backup.mode, 'vacuum-into');
  assert.deepEqual(report.biliIndexDb.backup.files, ['index.db']);

  const db = readDb(biliRoot);
  assert.equal(db.count('messages', 'session_id = ? OR session_id LIKE ?', PARENT, `${PARENT}|sub:%`), 0);
  assert.equal(db.count('message_media'), 0);
  assert.equal(db.count('refs'), 0);
  assert.equal(db.count('blocks', 'session_id = ?', PARENT), 0);
  assert.equal(db.count('conversations', 'session_id = ? OR session_id LIKE ?', PARENT, `${PARENT}|sub:%`), 0);
  assert.equal(db.count('sessions', 'session_id = ? OR session_id LIKE ?', PARENT, `${PARENT}|sub:%`), 0);
  // The other session is untouched.
  assert.equal(db.count('messages', 'session_id = ?', OTHER), 1);

  // Shared blob loses exactly one reference; orphans are collected; pinned state stays.
  assert.equal(db.refcount('hash-shared'), 1);
  assert.equal(db.refcount('hash-other'), 1);
  assert.equal(db.refcount('hash-parent-2'), undefined);
  assert.equal(db.refcount('hash-media'), undefined);
  assert.equal(db.refcount('hash-summary'), undefined);
  assert.equal(db.refcount('hash-one'), undefined);
  assert.equal(db.refcount('hash-ccr'), undefined);
  assert.equal(db.refcount('hash-state'), undefined);
  assert.equal(db.refcount('hash-child'), undefined);
  assert.equal(db.refcount('hash-pinned'), 1);
  assert.deepEqual(db.checkpoints(), ['cp-pinned']);

  // Every session-keyed blob lost the parent *and* its subagent child.
  for (const namespace of ['plugin-conversations', 'prefix-affinity', 'session-order']) {
    const blob = db.kv(namespace);
    const text = JSON.stringify(blob);
    assert.ok(!text.includes(PARENT), `${namespace} still mentions the parent`);
    assert.ok(!text.includes('|sub:'), `${namespace} still mentions the subagent child`);
    assert.ok(text.includes(OTHER), `${namespace} lost the unrelated session`);
  }
  db.close();

  // The subagent snapshot is part of the family and moves to trash with it.
  assert.deepEqual(snapshotFiles(protocolDir), ['other.json']);
  const batches = trashBatches(home);
  assert.equal(batches.length, 1);
});

test('dry run changes nothing at all', async () => {
  const { biliRoot, protocolDir } = makeScenario();
  const before = readDb(biliRoot);
  const baseline = {
    messages: before.count('messages'),
    sessions: before.count('sessions'),
    refShared: before.refcount('hash-shared'),
    kvUpdatedAt: before.kvUpdatedAt('plugin-conversations'),
    kvText: JSON.stringify(before.kv('plugin-conversations')),
  };
  before.close();

  const report = await purgeSession(PARENT, { ...CFG, dryRun: true }, QUIET);
  assert.equal(report.biliIndexDb.reason, 'dry-run');

  const after = readDb(biliRoot);
  assert.equal(after.count('messages'), baseline.messages);
  assert.equal(after.count('sessions'), baseline.sessions);
  assert.equal(after.refcount('hash-shared'), baseline.refShared);
  assert.equal(after.kvUpdatedAt('plugin-conversations'), baseline.kvUpdatedAt);
  assert.equal(JSON.stringify(after.kv('plugin-conversations')), baseline.kvText);
  after.close();
  assert.deepEqual(snapshotFiles(protocolDir), ['other.json', 'parent-subagent.json', 'parent.json']);
});

test('boot sweep drops ghosts of a family nobody owns and keeps live sessions', async () => {
  const { biliRoot, home } = makeScenario();
  // Simulate a purge that removed the rows but left the blobs behind.
  const raw = new DatabaseSync(path.join(biliRoot, 'index.db'));
  raw.prepare('DELETE FROM sessions WHERE session_id IN (?, ?)').run(PARENT, CHILD);
  raw.close();

  const result = await sweepGhostKv({ dryRun: false }, QUIET);
  assert.equal(result.ok, true);
  assert.equal(result.removed['plugin-conversations'], 2);
  assert.equal(result.removed['session-order'], 2);

  const db = readDb(biliRoot);
  for (const namespace of ['plugin-conversations', 'prefix-affinity', 'session-order']) {
    const text = JSON.stringify(db.kv(namespace));
    assert.ok(!text.includes(PARENT), `${namespace} still mentions the ghost`);
    assert.ok(!text.includes('|sub:'), `${namespace} still mentions the ghost child`);
    assert.ok(text.includes(OTHER), `${namespace} lost a live session`);
  }
  db.close();
  // The rows that were rewritten are backed up before the swap.
  const batches = trashBatches(home);
  assert.equal(batches.length, 1);
  assert.ok(fs.existsSync(path.join(home, 'storages', 'session-leftover-purge', 'trash', batches[0], 'kv-store.json.bak')));
});

test('boot sweep honours dryRun', async () => {
  const { biliRoot } = makeScenario();
  const raw = new DatabaseSync(path.join(biliRoot, 'index.db'));
  raw.prepare('DELETE FROM sessions WHERE session_id = ?').run(PARENT);
  raw.close();

  const result = await sweepGhostKv({ dryRun: true }, QUIET);
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldRemove, 6);

  const db = readDb(biliRoot);
  assert.ok(JSON.stringify(db.kv('session-order')).includes(PARENT));
  assert.ok(JSON.stringify(db.kv('prefix-affinity')).includes('|sub:'));
  db.close();
});

test('boot sweep keeps a family whose DSH transcript still exists', async () => {
  const { biliRoot } = makeScenario({ liveTranscripts: [PARENT] });
  const raw = new DatabaseSync(path.join(biliRoot, 'index.db'));
  raw.prepare('DELETE FROM sessions WHERE session_id = ?').run(PARENT);
  raw.close();

  const result = await sweepGhostKv({ dryRun: false }, QUIET);
  assert.equal(result.ok, true);
  const db = readDb(biliRoot);
  assert.ok(JSON.stringify(db.kv('plugin-conversations')).includes(PARENT));
  db.close();
});

test('reconcile groups a family under its parent', () => {
  const { biliRoot } = makeScenario({ liveTranscripts: [OTHER] });
  const report = findOrphanSnapshots();
  assert.equal(report.scanned, 3);
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0].id, PARENT);
  assert.equal(report.orphans[0].files.length, 2);
  assert.ok(report.orphans[0].files.every((file) => path.dirname(file) === path.join(biliRoot, 'anthropic')));
});

test('purgeBiliIndexDb refuses to act when the database has no rows', async () => {
  const { biliRoot } = makeScenario();
  const raw = new DatabaseSync(path.join(biliRoot, 'index.db'));
  raw.prepare('DELETE FROM sessions').run();
  raw.close();
  const result = await sweepGhostKv({ dryRun: false }, QUIET);
  assert.equal(result.reason, 'no-sessions');
});

test('a session with no index rows skips the snapshot entirely', async () => {
  const { biliRoot, home } = makeScenario();
  const batch = path.join(home, 'batch-none');
  const result = await purgeBiliIndexDb(UNKNOWN, { dryRun: false, biliIndexDb: true }, QUIET, batch);
  assert.equal(result.reason, 'no-rows');
  // No 300 MB copy to delete zero rows, and nothing was touched.
  assert.equal(fs.existsSync(batch), false);
  const db = readDb(biliRoot);
  assert.equal(db.count('sessions'), 3);
  db.close();
});

test('the trash cap deletes the oldest batches first', async () => {
  const { home } = makeScenario();
  const trash = path.join(home, 'storages', 'session-leftover-purge', 'trash');
  const write = (name, bytes) => {
    fs.mkdirSync(path.join(trash, name), { recursive: true });
    fs.writeFileSync(path.join(trash, name, 'index.db'), Buffer.alloc(bytes));
  };
  write('2020-01-01T00-00-00-000Z', 600 * 1024);
  write('2020-01-02T00-00-00-000Z', 600 * 1024);
  write('2020-01-03T00-00-00-000Z', 600 * 1024);

  const swept = await sweepTrash({ trashRetentionDays: 0, trashMaxMb: 1 }, QUIET);
  assert.equal(swept.trimmed, 2);
  assert.equal(swept.bytesAfter <= 1024 * 1024, true);
  assert.deepEqual(fs.readdirSync(trash), ['2020-01-03T00-00-00-000Z']);
});

test('age retention is skipped when set to 0 but the cap still applies', async () => {
  const { home } = makeScenario();
  const trash = path.join(home, 'storages', 'session-leftover-purge', 'trash');
  fs.mkdirSync(path.join(trash, 'old'), { recursive: true });
  fs.writeFileSync(path.join(trash, 'old', 'index.db'), Buffer.alloc(2048));
  const swept = await sweepTrash({ trashRetentionDays: 0, trashMaxMb: 0 }, QUIET);
  assert.equal(swept.removed, 0);
  assert.equal(swept.ageSkipped, true);
  assert.equal(swept.sizeSkipped, true);
});

test('an id that is not a session id is refused', async () => {
  const { biliRoot } = makeScenario();
  assert.deepEqual(await purgeSession('../../etc/passwd', CFG, QUIET), { skipped: 'bad-id' });
  assert.deepEqual(await purgeSession(CHILD, { ...CFG, biliIndexDb: false, biliJson: false }, QUIET), { sessionId: PARENT });
  const db = readDb(biliRoot);
  assert.equal(db.count('sessions'), 3);
  db.close();
});

test('the state directory can be pointed somewhere disposable', async () => {
  const { home } = makeScenario();
  const custom = path.join(home, 'state-override');
  process.env.SESSION_LEFTOVER_PURGE_DIR = custom;
  try {
    const paths = await import('../lib/paths.js');
    assert.equal(paths.stateDir(), custom);
    await purgeSession(PARENT, CFG, QUIET);
    assert.equal(fs.existsSync(path.join(custom, 'trash')), true);
    // Nothing landed in the profile-derived location for this run.
    assert.equal(fs.existsSync(path.join(home, 'storages', 'session-leftover-purge', 'trash')), false);
  } finally {
    delete process.env.SESSION_LEFTOVER_PURGE_DIR;
  }
});
