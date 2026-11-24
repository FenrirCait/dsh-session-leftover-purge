import fs from 'node:fs';
import path from 'node:path';
import { Config } from './schema.js';
import { DEFAULTS, configPath, loadConfig, readLiveConfig } from './config.js';
import { BiliAdapter, sweepGhostKv } from './adapters/bili.js';
import { CostMeterAdapter } from './adapters/cost-meter.js';
import { vacuumIndex } from './adapters/bili-index.js';
import { listSnapshotFiles, readSnapshotId } from './adapters/bili-snapshots.js';
import { familyOf, isSessionId, subagentParentOf } from './core/family.js';
import { loadSessionStore } from './core/session-store.js';
import { findOrphanFamilies, purgeFamily } from './runtime/execute.js';
import { deleteAllBatches, logLine, restoreLatest, sweepTrash } from './runtime/backup.js';
import { biliSessionsRoot, dshSessionsRoot, ledgerFile, stateDir, trashDir } from './runtime/paths.js';
export const name = 'dsh-session-leftover-purge';
/** Package version, read once so the ready line names what is actually running. */
const VERSION = (() => {
    try {
        return String(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0');
    }
    catch {
        return '0.0.0';
    }
})();
/**
 * No service is injected on purpose: this plugin only listens on the public
 * `api-session/removed` event, so it can never interfere with session creation,
 * deletion or the workspace registry.
 */
export const inject = [];
/** Retry budget for the "session store still has it" race: 1 try + 2 retries. */
const ALIVE_RETRY_TIMES = 3;
const ALIVE_RETRY_MS = 1500;
const TRIGGER_STATE_FILE = 'triggers.json';
function triggerStatePath() {
    return path.join(stateDir(), TRIGGER_STATE_FILE);
}
function readTriggerState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(triggerStatePath(), 'utf8'));
        return { restore: Number(parsed.restore ?? 0) || 0, delete: Number(parsed.delete ?? 0) || 0, ledger: Number(parsed.ledger ?? 0) || 0 };
    }
    catch {
        return { restore: 0, delete: 0, ledger: 0 };
    }
}
async function writeTriggerState(state) {
    await fs.promises.mkdir(stateDir(), { recursive: true });
    await fs.promises.writeFile(triggerStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
export function apply(ctx, config) {
    const logger = {
        info: (message) => ctx.logger?.info?.(message),
        warn: (message) => ctx.logger?.warn?.(message),
    };
    const disk = loadConfig(logger);
    const cfgNow = readLiveConfig(config, disk);
    const live = () => readLiveConfig(config, disk);
    const inFlight = new Set();
    let disposed = false;
    let storePromise;
    const store = () => (storePromise ??= loadSessionStore());
    const adapters = () => [new BiliAdapter(), new CostMeterAdapter()];
    // `node:sqlite` carries the whole index half of this plugin. On an older Node
    // the import fails and every caller degrades to "skipped", which looks exactly
    // like "nothing left to clean". Say it once, out loud.
    void import('node:sqlite').catch((error) => {
        logger.warn(`session-leftover-purge: node:sqlite is unavailable on Node ${process.versions.node} — ` +
            `bili index cleanup and the boot sweep stay off (needs Node >= 22.13, or >= 23.4): ${String(error)}`);
        void logLine(`node:sqlite-unavailable node=${process.versions.node}`);
    });
    // ---- actions expressed as number bumps ---------------------------------
    let triggerBusy = false;
    const runTriggers = async () => {
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
            }
            catch (error) {
                logger.warn(`session-leftover-purge: ledger snapshot failed: ${String(error)}`);
            }
        }
        if (changed) {
            try {
                await writeTriggerState(state);
            }
            catch (error) {
                logger.warn(`session-leftover-purge: cannot persist trigger state: ${String(error)}`);
            }
        }
    };
    const checkTriggers = () => {
        if (triggerBusy)
            return;
        triggerBusy = true;
        void runTriggers()
            .catch((error) => logger.warn(`session-leftover-purge: trigger handling failed: ${String(error)}`))
            .finally(() => {
            triggerBusy = false;
        });
    };
    checkTriggers();
    try {
        ctx.inject?.(['settings'], (sctx) => {
            sctx.on?.('settings/document-updated', (payload) => {
                const id = String(payload);
                if (id === name || id === 'session-leftover-purge')
                    checkTriggers();
            });
        });
    }
    catch (error) {
        logger.warn(`session-leftover-purge: cannot watch settings changes: ${String(error)}`);
    }
    if (cfgNow.enabled === false) {
        logger.info('session-leftover-purge: disabled in plugin settings (no listener registered)');
        return () => { };
    }
    // ---- family purge on the archive-manager delete event -------------------
    const childrenOf = (root) => {
        const prefix = `${root}|sub:`;
        const found = [];
        for (const file of listSnapshotFiles(biliSessionsRoot())) {
            const id = readSnapshotId(file);
            if (typeof id === 'string' && id.startsWith(prefix))
                found.push(id);
        }
        return [...new Set(found)];
    };
    const summarize = (run) => ({
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
    const attempt = async (sessionId, round) => {
        try {
            const current = await store();
            if (current.has(sessionId)) {
                // A delete can emit while the store still lists the session; retry a
                // couple of times before believing the session is gone.
                if (round < ALIVE_RETRY_TIMES && !disposed) {
                    await new Promise((resolve) => setTimeout(resolve, ALIVE_RETRY_MS));
                    if (!disposed)
                        return attempt(sessionId, round + 1);
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
        }
        catch (error) {
            logger.warn(`session-leftover-purge: purge failed for ${sessionId}: ${String(error)}`);
        }
        finally {
            inFlight.delete(sessionId);
        }
    };
    const runPurge = (payload) => {
        if (disposed || typeof payload !== 'string')
            return;
        const sessionId = subagentParentOf(payload) ?? payload;
        if (!isSessionId(sessionId)) {
            logger.warn(`session-leftover-purge: refusing suspicious id ${JSON.stringify(payload)}`);
            return;
        }
        if (inFlight.has(sessionId))
            return;
        inFlight.add(sessionId);
        void attempt(sessionId, 0);
    };
    let offRemoved = () => { };
    try {
        offRemoved = ctx.on?.('api-session/removed', runPurge) ?? (() => { });
    }
    catch (error) {
        logger.warn(`session-leftover-purge: cannot subscribe to api-session/removed: ${String(error)}`);
    }
    // ---- boot pass ---------------------------------------------------------
    const writeOrphansReport = async (report) => {
        try {
            await fs.promises.mkdir(stateDir(), { recursive: true });
            await fs.promises.writeFile(path.join(stateDir(), 'orphans.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        }
        catch (error) {
            logger.warn(`session-leftover-purge: cannot write orphans report: ${String(error)}`);
        }
    };
    const reconcile = async (cfg) => {
        const current = await store();
        const probe = current.probe();
        const report = {
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
            logger.warn(`session-leftover-purge: ${orphans.length} bili snapshot family(s) without a session: ` +
                `${orphans.map((orphan) => orphan.id).join(', ')} — see ${path.join(stateDir(), 'orphans.json')}`);
        }
        if (cfg.autoPurgeOrphans) {
            for (const orphan of orphans) {
                await purgeFamily(familyOf(orphan.id, childrenOf(orphan.id)), {
                    cfg,
                    logger,
                    store: current,
                    adapters: adapters(),
                });
            }
        }
    };
    const bootPass = async () => {
        const cfg = live();
        try {
            const swept = await sweepTrash(cfg, logger);
            if (swept.removed > 0) {
                logger.info(`session-leftover-purge: removed ${swept.removed} backup batch(es) ` +
                    `(expired ${swept.expired}, trimmed ${swept.trimmed}, ${swept.bytes} B → ${swept.bytesAfter} B)`);
            }
        }
        catch (error) {
            logger.warn(`session-leftover-purge: trash sweep failed: ${String(error)}`);
        }
        if (cfg.reconcileOnBoot) {
            try {
                await reconcile(cfg);
            }
            catch (error) {
                logger.warn(`session-leftover-purge: boot reconcile failed: ${String(error)}`);
            }
        }
        if (cfg.vacuumIndexDb) {
            try {
                const vacuum = await vacuumIndex(path.join(biliSessionsRoot(), 'index.db'), logger);
                await logLine(`vacuum index.db ${vacuum.ok ? 'ok' : vacuum.reason ?? 'skipped'}`);
            }
            catch (error) {
                logger.warn(`session-leftover-purge: vacuum failed: ${String(error)}`);
            }
        }
    };
    const bootDelay = Number.isFinite(cfgNow.bootDelayMs) ? cfgNow.bootDelayMs : 8000;
    const bootTimer = setTimeout(() => {
        void bootPass();
    }, bootDelay);
    bootTimer.unref?.();
    // Ghost sweep runs before the lane can start, not on the boot timer: bili
    // rewrites the blobs from memory on every request, so boot is the only window
    // where the file is authoritative.
    if (cfgNow.biliIndexDb && cfgNow.sweepGhostKvOnBoot !== false) {
        void (async () => {
            try {
                const current = await store();
                const result = await sweepGhostKv({ store: current, cfg: live(), batchDir: trashDir(), logger });
                if (!result.ok)
                    logger.info(`session-leftover-purge: ghost kv sweep skipped (${result.reason ?? 'unknown'})`);
                else if (result.dryRun === true && (result.total ?? 0) > 0) {
                    logger.info(`session-leftover-purge: dry run — ${result.total} ghost kv binding(s) would be removed`);
                }
            }
            catch (error) {
                logger.warn(`session-leftover-purge: ghost kv sweep failed: ${String(error)}`);
            }
        })();
    }
    // One line per start so an operator can confirm from the log alone that this
    // version is live, plus the exact roots this instance will touch.
    void logLine(`ready v${VERSION} subscribed=api-session/removed biliJson=${cfgNow.biliJson} ` +
        `biliIndexDb=${cfgNow.biliIndexDb} costMeterLedger=${cfgNow.costMeterLedger} ` +
        `costMeterFiles=${cfgNow.costMeterFiles} dshContextCache=${cfgNow.dshContextCache} ` +
        `archiveProjcache=${cfgNow.archiveProjcache} dryRun=${cfgNow.dryRun}`);
    void (async () => {
        const probe = (await store()).probe();
        await logLine(`roots state=${stateDir()} bili=${biliSessionsRoot()} sessions=${dshSessionsRoot()} store=${probe.kind}`);
    })();
    logger.info(`session-leftover-purge: ready v${VERSION} (biliJson=${cfgNow.biliJson} indexDb=${cfgNow.biliIndexDb} ` +
        `ledger=${cfgNow.costMeterLedger} reconcile=${cfgNow.reconcileOnBoot} dryRun=${cfgNow.dryRun})`);
    return () => {
        disposed = true;
        clearTimeout(bootTimer);
        offRemoved();
    };
}
export { Config, configPath, DEFAULTS };
