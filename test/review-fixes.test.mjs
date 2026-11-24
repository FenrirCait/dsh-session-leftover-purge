// Regression tests for the issues Codex raised on PR #8 and PR #4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createStoreCache } from '../lib/runtime/store-cache.js';
import { loadSessionStore } from '../lib/core/session-store.js';
import { purgeFamily as runPurge } from '../lib/runtime/execute.js';
import { openIndex, purgeFamily } from '../lib/adapters/bili-index.js';
import { planGhostKv, writeGhostKv } from '../lib/adapters/bili-kv.js';
import { restoreLatest } from '../lib/runtime/backup.js';
import { DEFAULTS } from '../lib/config.js';

const SESSION = 'session-11111111-2222-3333-4444-555555555555';
const QUIET = { info() {}, warn() {} };
const deps = (adapters = []) => ({ cfg: DEFAULTS, logger: QUIET, store: { probe: () => ({ kind: 'jsonl', root: '/x', evidence: 'x' }), liveIds: () => new Set(), has: () => false }, adapters });

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-fix-${prefix}-`));
}

test('a cached store is stale by design; the delete path must re-read', async () => {
  const root = tmp('store');
  const sessionDir = path.join(root, 'workspace', SESSION);
  fs.mkdirSync(sessionDir, { recursive: true });

  const cache = createStoreCache(() => loadSessionStore(root));
  assert.equal((await cache.cached()).has(SESSION), true);

  fs.rmSync(sessionDir, { recursive: true, force: true });

  // The boot snapshot still lists it — that is exactly why the delete handler
  // must not use it (Codex P1 on PR #8).
  assert.equal((await cache.cached()).has(SESSION), true);
  assert.equal((await cache.fresh()).has(SESSION), false);
});

test('an unreadable session root makes the whole scan unknown', async () => {
  const file = path.join(tmp('scan'), 'not-a-directory');
  fs.writeFileSync(file, 'x');
  const store = await loadSessionStore(file);
  assert.equal(store.probe().kind, 'unknown');
  assert.match(store.probe().evidence, /incomplete/);
  assert.equal(store.has(SESSION), true);
});

test('a family whose id is not a DSH session is refused before any adapter runs', async () => {
  let called = 0;
  const adapter = { id: 'bili', probe: async () => ({ available: true, evidence: '', capabilities: [] }), plan: async () => { called += 1; throw new Error('must not be called'); }, apply: async () => { throw new Error('no'); }, verify: async () => ({ adapter: 'bili', ok: true, remaining: [], evidence: '' }) };
  const run = await runPurge({ id: 'pfa-951aa7212e9a7dcb', children: [] }, deps([adapter]));
  assert.equal(run.skipped, 'bad-id');
  assert.equal(called, 0);
});

test('the ghost sweep aborts when a blob changed under it', async () => {
  const root = tmp('kv');
  const dbFile = path.join(root, 'index.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE kv_store (namespace TEXT, key TEXT, value_json TEXT, updated_at INTEGER)');
  const dead = 'session-deadbeef-0000-1111-2222-333333333333';
  db.prepare('INSERT INTO kv_store VALUES (?, ?, ?, ?)').run('plugin-conversations', 'table', JSON.stringify({ [dead]: { sessionId: dead } }), 1);
  db.prepare('INSERT INTO sessions VALUES (?)').run(SESSION);
  db.close();

  const conn = new DatabaseSync(dbFile);
  const scan = planGhostKv(conn, { indexed: new Set([SESSION]), live: new Set([SESSION]) });
  assert.equal(scan.total, 1);

  // bili's lane rewrites the blob between plan and write.
  const newer = JSON.stringify({ [SESSION]: { sessionId: SESSION }, [dead]: { sessionId: dead } });
  conn.prepare('UPDATE kv_store SET value_json = ? WHERE namespace = ? AND key = ?').run(newer, 'plugin-conversations', 'table');

  await assert.rejects(writeGhostKv(conn, scan, path.join(root, 'batch')), /changed-during-write/);
  const after = conn.prepare('SELECT value_json FROM kv_store WHERE namespace = ?').get('plugin-conversations').value_json;
  assert.equal(after, newer);
  conn.close();
});

test('purging rows enables secure_delete first', async () => {
  const root = tmp('secure');
  const dbFile = path.join(root, 'index.db');
  const db = new DatabaseSync(dbFile);
  db.close();
  const conn = await openIndex(dbFile);
  assert.ok(conn);
  purgeFamily(conn, { id: SESSION, children: [] }, {});
  const value = conn.prepare('PRAGMA secure_delete').get();
  assert.equal(Number(Object.values(value)[0]), 1);
  conn.close();
});

test('a sweep-only batch is restorable, and cache backups come back too', async () => {
  const root = tmp('restore');
  const home = path.join(root, 'home');
  const bili = path.join(root, 'bili');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bili, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.BILI_SESSIONS_DIR = bili;

  const dbFile = path.join(bili, 'index.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE kv_store (namespace TEXT, key TEXT, value_json TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO kv_store VALUES (?, ?, ?, ?)').run('plugin-conversations', 'table', 'OLD', 1);
  db.close();

  const batch = path.join(home, 'storages', 'session-leftover-purge', 'trash', '2026-11-25T00-00-00-000Z');
  fs.mkdirSync(path.join(batch, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(batch, 'projcache'), { recursive: true });
  fs.writeFileSync(
    path.join(batch, 'kv-store.json.bak'),
    JSON.stringify([{ namespace: 'plugin-conversations', key: 'table', value_json: 'NEW' }]),
  );
  fs.writeFileSync(path.join(batch, 'cache', 'shard-01.json'), '{"format":3,"sessions":[]}');
  fs.writeFileSync(path.join(batch, 'projcache', `${SESSION}.json`), '{}');

  const result = await restoreLatest(QUIET);
  assert.equal(result.ok, true);
  assert.equal(result.kv, 'applied');
  assert.equal(result.caches, 2);

  const check = new DatabaseSync(dbFile);
  assert.equal(check.prepare('SELECT value_json FROM kv_store').get().value_json, 'NEW');
  check.close();
  assert.ok(fs.existsSync(path.join(home, 'storages', 'dsh-context', 'overview-cache.v3', 'shard-01.json')));
  assert.ok(fs.existsSync(path.join(home, 'storages', 'session_projcache', `${SESSION}.json`)));
});
