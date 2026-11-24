import type { Logger, PluginConfig } from './types.js';
/**
 * Defaults are deliberately conservative:
 *  - biliJson / biliIndexDb: on. These are the leftovers the plugin exists for,
 *    and every write keeps a snapshot in `trash/` first.
 *  - cost-meter ledger and detail files: off. Somebody else's accounting.
 *  - dsh-context / archive-manager caches: off. Caches are cheap to rebuild and
 *    their formats are not documented — report first, delete on request.
 *  - dryRun: off, but honoured by every path including the boot sweep.
 */
export declare const DEFAULTS: PluginConfig;
export declare function configPath(): string;
/** Headless fallback: `<state>/config.json`, used when the form has no value. */
export declare function loadConfig(logger?: Logger): Partial<PluginConfig>;
/**
 * Merge the on-disk file with the live form value. `.volatile()` fields arrive
 * as objects with `get()`, so the effective config is re-read on every use and
 * an edit applies to the next deleted session without a restart.
 */
export declare function readLiveConfig(config: unknown, disk: Partial<PluginConfig>): PluginConfig;
