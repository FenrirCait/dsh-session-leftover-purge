// Fixture tests for the dsh-context and archive-projcache adapters.
// Everything runs against synthetic shards in os.tmpdir(); no test reads or
// writes the live `~/.dsh/storages/{dsh-context,session_projcache}` trees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DshContextAdapter } from '../lib/adapters/dsh-context.js';
import { ArchiveProjcacheAdapter } from '../lib/adapters/archive-projcache.js';

const PARENT = 'session-11111111-2222-3333-4444-555555555555';
const CHILD_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // subagent keyed by a bare uuid
const OTHER = 'session-99999999-8888-7777-6666-555555555555';

const FAMILY = { id: PARENT, children: [] };
const QUIET = { info() {}, warn() {} };

const CFG = {
  enabled: true,
  biliJson: true,
  biliIndexDb: true,
  costMeterLedger: true,
  costMeterFiles: true,
  costMeterReportBackups: false,
  dshContextCache: false,
  archiveProjcache: false,
  dryRun: false,
  trashRetentionDays: 0,
  trashMaxMb: 0,
  reconcileOnBoot: false,
  autoPurgeOrphans: false,
  bootDelayMs: 0,
  sweepGhostKvOnBoot: false,
  vacuumIndexDb: false,
  restoreBackupTrigger: 0,
  deleteBackupsTrigger: 0,
  backupLedgerTrigger: 0,
};

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ctx-${prefix}-`));
}

function writeDshShard(root, name, body) {
  const dir = path.join(root, 'overview-cache.v3');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

function writeProjcache(root, name, content) {
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** A dsh-context session entry shaped like the on-disk materialization object. */
function sessionEntry(id, { parentSession = undefined } = {}) {
  const origin = parentSession === undefined ? 'root' : 'subagent';
  return {
    materialization: {
      asOfSeq: 1,
      facts: {
        id,
        createdAt: 1,
        cwd: 'C:\\Users\\fenri\\work',
        ...(parentSession === undefined ? {} : { parentSession, origin: 'subagent' }),
      },
      signature: `${id}\u00001\u0000${origin}\u0000C:\\Users\\fenri\\.dsh\\sessions\\--proj--\\${id}\\session.v4.jsonl.zstd`,
      values: {},
    },
    identity: {
      path: `C:\\Users\\fenri\\.dsh\\sessions\\--proj--\\${id}\\session.v4.jsonl.zstd`,
      sizeBytes: 100,
      mtimeMs: 1,
    },
  };
}

function shardIds(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed.sessions.map((entry) => entry.materialization.facts.id);
}

test('dsh-context default is report-only: plan writes 0 and apply leaves bytes untouched', async () => {
  const root = tmpdir('reportonly');
  const shard = writeDshShard(root, 'shard-01.json', {
    format: 3,
    savedAt: 1000,
    sessions: [sessionEntry(PARENT), sessionEntry(CHILD_UUID, { parentSession: PARENT }), sessionEntry(OTHER)],
  });
  const before = fs.readFileSync(shard);

  const adapter = new DshContextAdapter({ root });
  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.equal(probe.root, root);

  const plan = await adapter.plan(FAMILY, { ...CFG, dshContextCache: false });
  assert.ok(plan.items.length > 0);
  assert.ok(plan.items.every((item) => item.reportOnly === true));
  assert.equal(plan.writes, 0);

  const result = await adapter.apply(plan, {
    cfg: { ...CFG, dshContextCache: false },
    dryRun: false,
    batchDir: path.join(root, 'batch'),
    logger: QUIET,
  });
  assert.ok(result.outcomes.every((outcome) => outcome.status === 'reported'));
  assert.ok(before.equals(fs.readFileSync(shard)), 'shard bytes changed under report-only');
});

test('dsh-context removal drops parent + child, keeps others, backs up, and is idempotent', async () => {
  const root = tmpdir('remove');
  const shard = writeDshShard(root, 'shard-01.json', {
    format: 3,
    savedAt: 1000,
    sessions: [sessionEntry(PARENT), sessionEntry(CHILD_UUID, { parentSession: PARENT }), sessionEntry(OTHER)],
  });

  const adapter = new DshContextAdapter({ root });
  const plan = await adapter.plan(FAMILY, { ...CFG, dshContextCache: true });
  assert.equal(plan.writes, 1);
  assert.equal(plan.items[0].rows, 2); // parent + subagent child

  const batchDir = path.join(root, 'batch');
  const result = await adapter.apply(plan, {
    cfg: { ...CFG, dshContextCache: true },
    dryRun: false,
    batchDir,
    logger: QUIET,
  });
  assert.equal(result.outcomes[0].status, 'done');

  // Backup of the original shard is inside batchDir/cache/.
  assert.ok(fs.existsSync(path.join(batchDir, 'cache', 'shard-01.json')));

  // Parent and child are gone; the unrelated session survives; savedAt refreshed.
  const after = JSON.parse(fs.readFileSync(shard, 'utf8'));
  assert.deepEqual(shardIds(shard), [OTHER]);
  assert.ok(after.savedAt > 1000, 'savedAt was not refreshed');

  // A second run reports nothing to write.
  const plan2 = await adapter.plan(FAMILY, { ...CFG, dshContextCache: true });
  assert.equal(plan2.items.length, 0);
  assert.equal(plan2.writes, 0);
});

test('dsh-context leaves malformed and sessions-less shards untouched', async () => {
  const root = tmpdir('malformed');
  const bad = writeDshShard(root, 'shard-01.json', '{ this is not json');
  const noSessions = writeDshShard(root, 'shard-02.json', { format: 3, savedAt: 1000 });
  const ok = writeDshShard(root, 'shard-03.json', {
    format: 3,
    savedAt: 1000,
    sessions: [sessionEntry(PARENT)],
  });
  const badBytes = fs.readFileSync(bad);
  const noSessionsBytes = fs.readFileSync(noSessions);

  const adapter = new DshContextAdapter({ root });
  const plan = await adapter.plan(FAMILY, { ...CFG, dshContextCache: true });
  // Only the well-formed shard produces an item.
  assert.equal(plan.items.length, 1);
  assert.ok(plan.notes.some((note) => note.includes('left untouched')));

  await adapter.apply(plan, {
    cfg: { ...CFG, dshContextCache: true },
    dryRun: false,
    batchDir: path.join(root, 'batch'),
    logger: QUIET,
  });

  assert.ok(badBytes.equals(fs.readFileSync(bad)), 'malformed shard was rewritten');
  assert.ok(noSessionsBytes.equals(fs.readFileSync(noSessions)), 'sessions-less shard was rewritten');
  assert.deepEqual(shardIds(ok), []);
});

test('archive-projcache with only bare-uuid files is not available and apply writes nothing', async () => {
  const root = tmpdir('proj-unknown');
  const bare = writeProjcache(root, `${CHILD_UUID}.json`, JSON.stringify({ version: 7, record: { identity: {}, rows: {} } }));

  const adapter = new ArchiveProjcacheAdapter({ root });
  const probe = await adapter.probe();
  assert.equal(probe.available, false);

  const plan = await adapter.plan(FAMILY, { ...CFG, archiveProjcache: true });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.writes, 0);

  const result = await adapter.apply(plan, {
    cfg: { ...CFG, archiveProjcache: true },
    dryRun: false,
    batchDir: path.join(root, 'batch'),
    logger: QUIET,
  });
  assert.ok(result.outcomes.every((outcome) => outcome.status !== 'done'));
  assert.ok(fs.existsSync(bare), 'unknown-format file was removed');
});

test('archive-projcache report-only leaves a session-keyed file untouched', async () => {
  const root = tmpdir('proj-reportonly');
  const keyed = writeProjcache(root, `${PARENT}.json`, JSON.stringify({ version: 7, record: {} }));
  const before = fs.readFileSync(keyed);

  const adapter = new ArchiveProjcacheAdapter({ root });
  const plan = await adapter.plan(FAMILY, { ...CFG, archiveProjcache: false });
  assert.ok(plan.items.length > 0);
  assert.ok(plan.items.every((item) => item.reportOnly === true));
  assert.equal(plan.writes, 0);

  await adapter.apply(plan, {
    cfg: { ...CFG, archiveProjcache: false },
    dryRun: false,
    batchDir: path.join(root, 'batch'),
    logger: QUIET,
  });
  assert.ok(before.equals(fs.readFileSync(keyed)), 'session-keyed file changed under report-only');
});

test('archive-projcache removal backs up then deletes the family file only', async () => {
  const root = tmpdir('proj-remove');
  const keyed = writeProjcache(root, `${PARENT}.json`, JSON.stringify({ version: 7, record: {} }));
  const other = writeProjcache(root, `${OTHER}.json`, JSON.stringify({ version: 7, record: {} }));

  const adapter = new ArchiveProjcacheAdapter({ root });
  const plan = await adapter.plan(FAMILY, { ...CFG, archiveProjcache: true });
  assert.equal(plan.writes, 1);

  const batchDir = path.join(root, 'batch');
  const result = await adapter.apply(plan, {
    cfg: { ...CFG, archiveProjcache: true },
    dryRun: false,
    batchDir,
    logger: QUIET,
  });
  assert.equal(result.outcomes[0].status, 'done');
  assert.ok(!fs.existsSync(keyed), 'family file still present');
  assert.ok(fs.existsSync(other), 'unrelated file removed');
  assert.ok(fs.existsSync(path.join(batchDir, 'projcache', `${PARENT}.json`)), 'backup missing');
});
