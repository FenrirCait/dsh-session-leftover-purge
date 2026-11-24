import fs from 'node:fs';
import path from 'node:path';

import type { Logger, PluginConfig } from './types.js';
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
export const DEFAULTS: PluginConfig = {
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

export function configPath(): string {
  return path.join(stateDir(), CONFIG_FILE);
}

/** Headless fallback: `<state>/config.json`, used when the form has no value. */
export function loadConfig(logger?: Logger): Partial<PluginConfig> {
  let onDisk: unknown = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn(`session-leftover-purge: config unreadable (${String(error)}), using defaults`);
    }
  }
  return onDisk !== null && typeof onDisk === 'object' ? (onDisk as Partial<PluginConfig>) : {};
}

/**
 * Merge the on-disk file with the live form value. `.volatile()` fields arrive
 * as objects with `get()`, so the effective config is re-read on every use and
 * an edit applies to the next deleted session without a restart.
 */
export function readLiveConfig(config: unknown, disk: Partial<PluginConfig>): PluginConfig {
  const merged: Record<string, unknown> = { ...DEFAULTS, ...disk };
  if (config !== null && typeof config === 'object') {
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      if (value === undefined) continue;
      merged[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get(): unknown }).get()
        : value;
    }
  }
  return merged as unknown as PluginConfig;
}
