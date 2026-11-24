// Contract tests for the session-store probe (P0) and the family parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadSessionStore } from '../lib/core/session-store.js';
import { familyOf, inFamily, isSessionId, subagentParentOf } from '../lib/core/family.js';

const PARENT = 'session-11111111-2222-3333-4444-555555555555';
const CHILD = `${PARENT}|sub:abcdef012345`;
const OTHER = 'session-99999999-8888-7777-6666-555555555555';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-store-${prefix}-`));
}

test('jsonl backend: directory per session is the source of truth', async () => {
  const root = tmp('jsonl');
  fs.mkdirSync(path.join(root, 'workspace-a', PARENT), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace-b', OTHER), { recursive: true });

  const store = await loadSessionStore(root);
  assert.equal(store.probe().kind, 'jsonl');
  const ids = store.liveIds();
  assert.deepEqual([...ids].sort(), [PARENT, OTHER].sort());
  assert.equal(store.has(PARENT), true);
  assert.equal(store.has('session-dead'), false);
});

test('sqlite backend: sessions.sqlite is read through schema discovery', async () => {
  const root = tmp('sqlite');
  const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project TEXT)');
  db.prepare('INSERT INTO sessions (session_id, project) VALUES (?, ?)').run(PARENT, 'w');
  db.close();

  const store = await loadSessionStore(root);
  assert.equal(store.probe().kind, 'sqlite');
  assert.equal(store.has(PARENT), true);
  // The old directory probe would have called this one dead — the whole reason
  // this module exists.
  assert.equal(store.has(OTHER), false);
});

test('sqlite backend with a renamed table still resolves via column discovery', async () => {
  const root = tmp('sqlite-renamed');
  const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  db.exec('CREATE TABLE conversation_index (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO conversation_index (id) VALUES (?)').run(PARENT);
  db.close();

  const store = await loadSessionStore(root);
  assert.equal(store.probe().kind, 'sqlite');
  assert.equal(store.has(PARENT), true);
});

test('a missing session root is unknown and answers alive for everything', async () => {
  const root = path.join(tmp('unknown'), 'does-not-exist');
  const store = await loadSessionStore(root);
  assert.equal(store.probe().kind, 'unknown');
  assert.equal(store.liveIds(), null);
  assert.equal(store.has('session-anything'), true);
});

test('an existing but empty root is authoritative: nothing is alive', async () => {
  // This is what the last deleted session leaves behind. Calling it `unknown`
  // would make the final purge of a machine skip forever.
  const root = tmp('empty');
  const store = await loadSessionStore(root);
  assert.equal(store.probe().kind, 'jsonl');
  assert.deepEqual([...(store.liveIds() ?? [])], []);
  assert.equal(store.has('session-anything'), false);
});

test('a sessions.sqlite without a session registry is unknown, not empty', async () => {
  const root = tmp('sqlite-empty');
  const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  db.exec('CREATE TABLE kv (k TEXT, v TEXT)');
  db.close();

  const store = await loadSessionStore(root);
  assert.equal(store.probe().kind, 'unknown');
  assert.equal(store.has('session-anything'), true);
});

test('family parsing keeps subagent children with their parent', () => {
  assert.equal(isSessionId(PARENT), true);
  assert.equal(isSessionId('not-a-session'), false);
  assert.equal(subagentParentOf(CHILD), PARENT);
  assert.equal(subagentParentOf(PARENT), undefined);
  assert.equal(subagentParentOf('session-x|sub:zzz'), undefined); // tail must be hex
  assert.equal(inFamily(CHILD, PARENT), true);
  assert.equal(inFamily(OTHER, PARENT), false);
  assert.deepEqual(familyOf(PARENT, [CHILD, CHILD]), { id: PARENT, children: [CHILD] });
});
