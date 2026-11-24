// Regression tests for the second round of Codex findings (PR #10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applyPendingKvRestore, restoreAsides, restoreLatest } from '../lib/runtime/backup.js';

const SESSION = 'session-11111111-2222-3333-4444-555555555555';
const QUIET = { info() {}, warn() {} };

function scenario({ withUpdatedAt = true, projNested = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-'));
  const home = path.join(root, 'home');
  const bili = path.join(root, 'bili');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bili, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.BILI_SESSIONS_DIR = bili;

  const db = new DatabaseSync(path.join(bili, 'index.db'));
  db.exec(
    withUpdatedAt
      ? 'CREATE TABLE kv_store (namespace TEXT, key TEXT, value_json TEXT, updated_at INTEGER)'
      : 'CREATE TABLE kv_store (namespace TEXT, key TEXT, value_json TEXT)',
  );
  if (withUpdatedAt) db.prepare('INSERT INTO kv_store VALUES (?, ?, ?, ?)').run('plugin-conversations', 'table', 'OLD', 1);
  else db.prepare('INSERT INTO kv_store VALUES (?, ?, ?)').run('plugin-conversations', 'table', 'OLD');
  db.close();

  const batch = path.join(home, 'storages', 'session-leftover-purge', 'trash', '2026-11-25T00-00-00-000Z');
  fs.mkdirSync(batch, { recursive: true });
  fs.writeFileSync(
    path.join(batch, 'kv-store.json.bak'),
    JSON.stringify([{ namespace: 'plugin-conversations', key: 'table', value_json: 'NEW' }]),
  );
  return { root, home, bili, batch };
}

function kvRow(bili) {
  const db = new DatabaseSync(path.join(bili, 'index.db'));
  const row = db.prepare('SELECT * FROM kv_store WHERE namespace = ?').get('plugin-conversations');
  db.close();
  return row;
}

test('a kv restore against a schema without updated_at still applies', async () => {
  const { bili } = scenario({ withUpdatedAt: false });
  const result = await restoreLatest(QUIET);
  assert.equal(result.kv, 'applied');
  assert.equal(kvRow(bili).value_json, 'NEW');
});

test('the restore leaves a marker that boot re-applies, then clears', async () => {
  const { bili } = scenario();
  await restoreLatest(QUIET);
  const marker = path.join(bili, 'kv-store.restored-pending.bak');
  assert.equal(fs.existsSync(marker), true);

  const applied = await applyPendingKvRestore();
  assert.equal(applied, 'applied');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(await applyPendingKvRestore(), 'none');
});

test('a partial target does not block the aside rollback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aside-'));
  const live = path.join(dir, 'index.db');
  const aside = `${live}.before-restore-test`;
  fs.writeFileSync(live, 'PARTIAL'); // what a failed copyFile leaves behind
  fs.writeFileSync(aside, 'ORIGINAL');

  await restoreAsides([{ live, aside }]);
  assert.equal(fs.readFileSync(live, 'utf8'), 'ORIGINAL');
  assert.equal(fs.existsSync(aside), false);
});

test('projcache backups go back under <root>/sessions when that is the live layout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-'));
  const home = path.join(root, 'home');
  const bili = path.join(root, 'bili');
  const projRoot = path.join(home, 'storages', 'session_projcache');
  fs.mkdirSync(path.join(projRoot, 'sessions'), { recursive: true });
  fs.mkdirSync(bili, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.BILI_SESSIONS_DIR = bili;

  const batch = path.join(home, 'storages', 'session-leftover-purge', 'trash', '2026-11-25T00-00-00-000Z');
  fs.mkdirSync(path.join(batch, 'projcache'), { recursive: true });
  fs.writeFileSync(path.join(batch, 'projcache', `${SESSION}.json`), '{}');

  const result = await restoreLatest(QUIET);
  assert.equal(result.caches, 1);
  assert.equal(fs.existsSync(path.join(projRoot, 'sessions', `${SESSION}.json`)), true);
  assert.equal(fs.existsSync(path.join(projRoot, `${SESSION}.json`)), false);
});
