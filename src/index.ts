import fs from 'node:fs';
import path from 'node:path';

import { Config } from './schema.js';
import { DEFAULTS, configPath, loadConfig, readLiveConfig } from './config.js';
import { BiliAdapter, sweepGhostKv } from './adapters/bili.js';
import { CostMeterAdapter } from './adapters/cost-meter.js';
import { DshContextAdapter } from './adapters/dsh-context.js';
import { ArchiveProjcacheAdapter } from './adapters/archive-projcache.js';
import { vacuumIndex } from './adapters/bili-index.js';
import { listSnapshotFiles, readSnapshotId } from './adapters/bili-snapshots.js';
import { familyOf, isSessionId, subagentParentOf } from './core/family.js';
import { createStoreCache } from './runtime/store-cache.js';
import { findOrphanFamilies, purgeFamily } from './runtime/execute.js';
import type { FamilyRun } from './runtime/execute.js';
import { applyPendingKvRestoreSync, deleteAllBatches, logLine, restoreLatest, sweepTrash } from './runtime/backup.js';
import { biliSessionsRoot, dshSessionsRoot, ledgerFile, stateDir, trashDir } from './runtime/paths.js';
import type { Adapter, Logger, PluginConfig, SessionStore } from './types.js';

export const name = 'dsh-session-leftover-purge';

/** Package version, read once so the ready line names what is actually running. */
const VERSION = (() => {
  try {
    return String((JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

/**
 * No service is injected on purpose: this plugin only listens on the public
 * `api-session/removed` event, so it can never interfere with session creation,
 * deletion or the workspace registry.
 */
export const inject: string[] = [];

/** Retry budget for the "session store still has it" race: 1 try + 2 retries. */
const ALIVE_RETRY_TIMES = 3;
const ALIVE_RETRY_MS = 1500;
const TRIGGER_STATE_FILE = 'triggers.json';

interface HostLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

/** Structural view of the Cordis context; `src/index.ts` is the only file that knows about it. */
interface HostContext {
  logger?: HostLogger;
  on?(event: string, handler: (payload?: unknown) => void): (() => void) | void;
  inject?(deps: string[], callback: (ctx: HostContext) => void): void;
}

interface TriggerState {
  restore: number;
  delete: number;
  ledger: number;
}

function triggerStatePath(): string {
  return path.join(stateDir(), TRIGGER_STATE_FILE);
}

function readTriggerState(): TriggerState {
  try {
    const parsed = JSON.parse(fs.readFileSync(triggerStatePath(), 'utf8')) as Partial<TriggerState>;
    return { restore: Number(parsed.restore ?? 0) || 0, delete: Number(parsed.delete ?? 0) || 0, ledger: Number(parsed.ledger ?? 0) || 0 };
  } catch {
    return { restore: 0, delete: 0, ledger: 0 };
  }
}

async function writeTriggerState(state: TriggerState): Promise<void> {
  await fs.promises.mkdir(stateDir(), { recursive: true });
  await fs.promises.writeFile(triggerStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function apply(ctx: HostContext, config?: unknown): () => void {
  const logger: Logger = {
    info: (message: string) => ctx.logger?.info?.(message),
    warn: (message: string) => ctx.logger?.warn?.(message),
  };
  const disk = loadConfig(logger);
  const cfgNow = readLiveConfig(config, disk);
  const live = (): PluginConfig => readLiveConfig(config, disk);

  const inFlight = new Set<string>();
  let disposed = false;
  // The boot pass may cache; the delete path must not (see attempt()).
  const storeCache = createStoreCache();
  const store = (): Promise<SessionStore> => storeCache.cached();
  // Order is deliberate: bili owns the only irreversible work (rows and blobs),
  // so it goes first while the batch dir is still empty; the caches at the end
  // are cheap, idempotent and report-only by default.
  const adapters = (): Adapter[] => [
    new BiliAdapter(),
    new CostMeterAdapter(),
    new DshContextAdapter(),
    new ArchiveProjcacheAdapter(),
  ];

  // `node:sqlite` carries the whole index half of this plugin. On an older Node
  // the import fails and every caller degrades to "skipped", which looks exactly
  // like "nothing left to clean". Say it once, out loud.
  void import('node:sqlite').catch((error: unknown) => {
    logger.warn(
      `session-leftover-purge: node:sqlite is unavailable on Node ${process.versions.node} — ` +
        `bili index cleanup and the boot sweep stay off (needs Node >= 22.13, or >= 23.4): ${String(error)}`,
    );
    void logLine(`node:sqlite-unavailable node=${process.versions.node}`);
  });

  // ---- actions expressed as number bumps ---------------------------------
  let triggerBusy = false;
  const runTriggers = async (): Promise<void> => {
    const state = readTriggerState();
    const cfg = live();
    let changed = false;

    const restoreAt = Number(cfg.restoreBackupTrigger);
    if (Number.isFinite(restoreAt) && restoreAt > state.restore) {
      state.restore = restoreAt;
      changed = true;
      const result = await restoreLatest(logger);
      logger.info(`session-leftover-purge: restore backup → ${JSON.stringify(result)}`);
    }
    const deleteAt = Number(cfg.deleteBackupsTrigger);
    if (Number.isFinite(deleteAt) && deleteAt > state.delete) {
      state.delete = deleteAt;
      changed = true;
      const result = await deleteAllBatches(logger);
      logger.info(`session-leftover-purge: delete backups → ${JSON.stringify(result)}`);
    }
    const ledgerAt = Number(cfg.backupLedgerTrigger);
    if (Number.isFinite(ledgerAt) && ledgerAt > state.ledger) {
      state.ledger = ledgerAt;
      changed = true;
      // A ledger snapshot is the same backup the purge path writes: copy the
      // file into a fresh batch and say where it went.
      const source = ledgerFile();
      try {
        const batch = trashDir();
        await fs.promises.mkdir(batch, { recursive: true });
        await fs.promises.copyFile(source, path.join(batch, 'ledger.json'));
        logger.info(`session-leftover-purge: ledger snapshot → ${path.basename(batch)}`);
      } catch (error) {
        logger.warn(`session-leftover-purge: ledger snapshot failed: ${String(error)}`);
      }
    }
    if (changed) {
      try {
        await writeTriggerState(state);
      } catch (error) {
        logger.warn(`session-leftover-purge: cannot persist trigger state: ${String(error)}`);
      }
    }
  };

  const checkTriggers = (): void => {
    if (triggerBusy) return;
    triggerBusy = true;
    void runTriggers()
      .catch((error: unknown) => logger.warn(`session-leftover-purge: trigger handling failed: ${String(error)}`))
      .finally(() => {
        triggerBusy = false;
      });
  };
  checkTriggers();
  try {
    ctx.inject?.(['settings'], (sctx) => {
      sctx.on?.('settings/document-updated', (payload?: unknown) => {
        const id = String(payload);
        if (id === name || id === 'session-leftover-purge') checkTriggers();
      });
    });
  } catch (error) {
    logger.warn(`session-leftover-purge: cannot watch settings changes: ${String(error)}`);
  }

  if (cfgNow.enabled === false) {
    logger.info('session-leftover-purge: disabled in plugin settings (no listener registered)');
    return () => {};
  }

  // ---- family purge on the archive-manager delete event -------------------
  const childrenOf = (root: string): string[] => {
    const prefix = `${root}|sub:`;
    const found: string[] = [];
    for (const file of listSnapshotFiles(biliSessionsRoot())) {
      const id = readSnapshotId(file);
      if (typeof id === 'string' && id.startsWith(prefix)) found.push(id);
    }
    return [...new Set(found)];
  };

  const summarize = (run: FamilyRun): unknown => ({
    skipped: run.skipped ?? null,
    adapters: run.adapters.map((entry) => ({
      adapter: entry.adapter,
      skipped: entry.skipped ?? null,
      error: entry.error ?? null,
      outcomes: entry.result?.outcomes.filter((outcome) => outcome.status !== 'done').length ?? 0,
      done: entry.result?.outcomes.filter((outcome) => outcome.status === 'done').length ?? 0,
      verify: entry.verify?.ok ?? null,
    })),
  });

  const attempt = async (sessionId: string, round: number): Promise<void> => {
    try {
      // Never the cached snapshot here: the session being deleted is exactly the
      // one the boot snapshot still lists, so a cached answer makes every retry
      // conclude "alive" and skip the cleanup (Codex P1, PR #8).
      const current = await storeCache.fresh();
      if (current.has(sessionId)) {
        // A delete can emit while the store still lists the session; retry a
        // couple of times before believing the session is gone.
        if (round < ALIVE_RETRY_TIMES && !disposed) {
          await new Promise((resolve) => setTimeout(resolve, ALIVE_RETRY_MS));
          if (!disposed) return attempt(sessionId, round + 1);
        }
        await logLine(`skip ${sessionId}: session still in the store`);
        logger.warn(`session-leftover-purge: ${sessionId} is still in the session store, skipped (nothing deleted)`);
        return;
      }
      const run = await purgeFamily(familyOf(sessionId, childrenOf(sessionId)), {
        cfg: live(),
        logger,
        store: current,
        adapters: adapters(),
      });
      await logLine(`purge ${sessionId} ${JSON.stringify(summarize(run))}`);
      logger.info(`session-leftover-purge: purge ${sessionId} ${JSON.stringify(summarize(run))}`);
    } catch (error) {
      logger.warn(`session-leftover-purge: purge failed for ${sessionId}: ${String(error)}`);
    } finally {
      inFlight.delete(sessionId);
    }
  };

  const runPurge = (payload?: unknown): void => {
    if (disposed || typeof payload !== 'string') return;
    const sessionId = subagentParentOf(payload) ?? payload;
    if (!isSessionId(sessionId)) {
      logger.warn(`session-leftover-purge: refusing suspicious id ${JSON.stringify(payload)}`);
      return;
    }
    if (inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    void attempt(sessionId, 0);
  };

  let offRemoved = (): void => {};
  try {
    offRemoved = (ctx.on?.('api-session/removed', runPurge) as (() => void) | void) ?? (() => {});
  } catch (error) {
    logger.warn(`session-leftover-purge: cannot subscribe to api-session/removed: ${String(error)}`);
  }

  // ---- boot pass ---------------------------------------------------------
  const writeOrphansReport = async (report: Record<string, unknown>): Promise<void> => {
    try {
      await fs.promises.mkdir(stateDir(), { recursive: true });
      await fs.promises.writeFile(path.join(stateDir(), 'orphans.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (error) {
      logger.warn(`session-leftover-purge: cannot write orphans report: ${String(error)}`);
    }
  };

  const reconcile = async (cfg: PluginConfig): Promise<void> => {
    const current = await store();
    const probe = current.probe();
    const report: Record<string, unknown> = {
      checkedAt: new Date().toISOString(),
      root: probe.root,
      store: probe.kind,
      evidence: probe.evidence,
      scanned: 0,
      orphanCount: 0,
      orphans: [],
    };

    if (probe.kind === 'unknown') {
      // Without a readable session store every session looks orphaned. Report
      // the fact and stop: a wrong "orphan" list here is a mass delete waiting
      // for `autoPurgeOrphans`.
      report.evidence = `${probe.evidence} — orphan detection skipped (session store unknown)`;
      await writeOrphansReport(report);
      await logLine(`reconcile skipped: session store unknown (${probe.evidence})`);
      logger.warn(`session-leftover-purge: orphan detection skipped — ${probe.evidence}`);
      return;
    }

    const { scanned, orphans } = findOrphanFamilies(current, biliSessionsRoot());
    report.scanned = scanned;
    report.orphanCount = orphans.length;
    report.orphans = orphans.map((orphan) => orphan.id);
    await writeOrphansReport(report);
    await logLine(`reconcile scanned=${scanned} orphans=${orphans.length} ids=${orphans.map((o) => o.id).join(',')}`);
    if (orphans.length > 0) {
      logger.warn(
        `session-leftover-purge: ${orphans.length} bili snapshot family(s) without a session: ` +
          `${orphans.map((orphan) => orphan.id).join(', ')} — see ${path.join(stateDir(), 'orphans.json')}`,
      );
    }
    if (cfg.autoPurgeOrphans) {
      for (const orphan of orphans) {
        // Snapshot ids are whatever bili wrote; only real DSH session ids may be
        // auto-deleted. Everything else is reported and left alone (Codex, PR #8).
        if (!isSessionId(orphan.id)) {
          await logLine(`skip orphan ${orphan.id}: not a DSH session id`);
          continue;
        }
        await purgeFamily(familyOf(orphan.id, childrenOf(orphan.id)), {
          cfg,
          logger,
          store: current,
          adapters: adapters(),
        });
      }
    }
  };

  const bootPass = async (): Promise<void> => {
    const cfg = live();
    try {
      const swept = await sweepTrash(cfg, logger);
      if (swept.removed > 0) {
        logger.info(
          `session-leftover-purge: removed ${swept.removed} backup batch(es) ` +
            `(expired ${swept.expired}, trimmed ${swept.trimmed}, ${swept.bytes} B → ${swept.bytesAfter} B)`,
        );
      }
    } catch (error) {
      logger.warn(`session-leftover-purge: trash sweep failed: ${String(error)}`);
    }
    if (cfg.reconcileOnBoot) {
      try {
        await reconcile(cfg);
      } catch (error) {
        logger.warn(`session-leftover-purge: boot reconcile failed: ${String(error)}`);
      }
    }
    if (cfg.vacuumIndexDb) {
      try {
        const vacuum = await vacuumIndex(path.join(biliSessionsRoot(), 'index.db'), logger);
        await logLine(`vacuum index.db ${vacuum.ok ? 'ok' : vacuum.reason ?? 'skipped'}`);
      } catch (error) {
        logger.warn(`session-leftover-purge: vacuum failed: ${String(error)}`);
      }
    }
  };

  const bootDelay = Number.isFinite(cfgNow.bootDelayMs) ? cfgNow.bootDelayMs : 8000;
  const bootTimer = setTimeout(() => {
    void bootPass();
  }, bootDelay);
  bootTimer.unref?.();

  // Synchronous barrier: the host may start bili's lane as soon as this plugin
  // finishes loading, so a pending kv restore must commit before that. A
  // fire-and-forget restore could be overwritten by the lane's first request and
  // then clear its own marker, losing the retry (Codex, PR #11).
  try {
    const pending = applyPendingKvRestoreSync();
    if (pending !== 'none') logger.info(`session-leftover-purge: pending kv restore → ${pending}`);
  } catch (error) {
    logger.warn(`session-leftover-purge: pending kv restore failed: ${String(error)}`);
  }

  // Ghost sweep runs before the lane can start, not on the boot timer: bili
  // rewrites the blobs from memory on every request, so boot is the only window
  // where the file is authoritative.
  if (cfgNow.biliIndexDb && cfgNow.sweepGhostKvOnBoot !== false) {
    void (async () => {
      try {
        const current = await store();
        const result = await sweepGhostKv({ store: current, cfg: live(), batchDir: trashDir(), logger });
        if (!result.ok) logger.info(`session-leftover-purge: ghost kv sweep skipped (${result.reason ?? 'unknown'})`);
        else if (result.dryRun === true && (result.total ?? 0) > 0) {
          logger.info(`session-leftover-purge: dry run — ${result.total} ghost kv binding(s) would be removed`);
        }
      } catch (error) {
        logger.warn(`session-leftover-purge: ghost kv sweep failed: ${String(error)}`);
      }
    })();
  }

  // One line per start so an operator can confirm from the log alone that this
  // version is live, plus the exact roots this instance will touch.
  void logLine(
    `ready v${VERSION} subscribed=api-session/removed biliJson=${cfgNow.biliJson} ` +
      `biliIndexDb=${cfgNow.biliIndexDb} costMeterLedger=${cfgNow.costMeterLedger} ` +
      `costMeterFiles=${cfgNow.costMeterFiles} dshContextCache=${cfgNow.dshContextCache} ` +
      `archiveProjcache=${cfgNow.archiveProjcache} dryRun=${cfgNow.dryRun}`,
  );
  void (async () => {
    const probe = (await store()).probe();
    await logLine(
      `roots state=${stateDir()} bili=${biliSessionsRoot()} sessions=${dshSessionsRoot()} store=${probe.kind}`,
    );
  })();
  logger.info(
    `session-leftover-purge: ready v${VERSION} (biliJson=${cfgNow.biliJson} indexDb=${cfgNow.biliIndexDb} ` +
      `ledger=${cfgNow.costMeterLedger} reconcile=${cfgNow.reconcileOnBoot} dryRun=${cfgNow.dryRun})`,
  );

  return () => {
    disposed = true;
    clearTimeout(bootTimer);
    offRemoved();
  };
}

export { Config, configPath, DEFAULTS };
