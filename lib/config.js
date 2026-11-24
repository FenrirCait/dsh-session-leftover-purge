import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './runtime/paths.js';
const CONFIG_FILE = 'config.json';
/**
 * Defaults are deliberately conservative:
 *  - biliJson / biliIndexDb: on. These are the leftovers the plugin exists for,
 *    and every write keeps a snapshot in `trash/` first.
 *  - cost-meter ledger and detail files: off. Somebody else's accounting.
 *  - dsh-context / archive-manager caches: off. Caches are cheap to rebuild and
 *    their formats are not documented — report first, delete on request.
 *  - dryRun: off, but honoured by every path including the boot sweep.
 */
export const DEFAULTS = {
    enabled: true,
    biliJson: true,
    biliIndexDb: true,
    costMeterLedger: false,
    costMeterFiles: false,
    costMeterReportBackups: true,
    dshContextCache: false,
    archiveProjcache: false,
    dryRun: false,
    trashRetentionDays: 7,
    trashMaxMb: 2048,
    reconcileOnBoot: true,
    sweepGhostKvOnBoot: true,
    autoPurgeOrphans: false,
    bootDelayMs: 8000,
    vacuumIndexDb: false,
    restoreBackupTrigger: 0,
    deleteBackupsTrigger: 0,
    backupLedgerTrigger: 0,
};
export function configPath() {
    return path.join(stateDir(), CONFIG_FILE);
}
/** Headless fallback: `<state>/config.json`, used when the form has no value. */
export function loadConfig(logger) {
    let onDisk = {};
    try {
        onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            logger?.warn(`session-leftover-purge: config unreadable (${String(error)}), using defaults`);
        }
    }
    return onDisk !== null && typeof onDisk === 'object' ? onDisk : {};
}
/**
 * Merge the on-disk file with the live form value. `.volatile()` fields arrive
 * as objects with `get()`, so the effective config is re-read on every use and
 * an edit applies to the next deleted session without a restart.
 */
export function readLiveConfig(config, disk) {
    const merged = { ...DEFAULTS, ...disk };
    if (config !== null && typeof config === 'object') {
        for (const [key, value] of Object.entries(config)) {
            if (value === undefined)
                continue;
            merged[key] = value !== null && typeof value === 'object' && typeof value.get === 'function'
                ? value.get()
                : value;
        }
    }
    return merged;
}
