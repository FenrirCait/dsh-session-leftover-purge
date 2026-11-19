import os from 'node:os';
import path from 'node:path';

/** DSH home: `$DSH_HOME` wins (the launcher sets it), else `~/.dsh`. */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.dsh');
}

/**
 * This plugin's own state dir (config, trash, log).
 *
 * `SESSION_LEFTOVER_PURGE_DIR` wins over `$DSH_HOME`, and the override exists
 * because `$DSH_HOME` alone cannot isolate a test profile: bili's data
 * directory is user-level and does not follow the profile, so a sandbox run
 * would still delete rows from the real index. Point both this variable and
 * `BILI_SESSIONS_DIR` somewhere throwaway for a genuinely disposable run.
 */
export function stateDir() {
  const env = process.env.SESSION_LEFTOVER_PURGE_DIR;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(dshHome(), 'storages', 'session-leftover-purge');
}

/**
 * billion-context session snapshot root.
 * Upstream default is the XDG data dir; on Windows that resolves to
 * `%USERPROFILE%\.local\share\billion-context\sessions`. `BILI_SESSIONS_DIR`
 * overrides it, and that is what the running proxy actually uses.
 */
export function biliSessionsRoot() {
  const env = process.env.BILI_SESSIONS_DIR;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.local', 'share', 'billion-context', 'sessions');
}

export function dshSessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/**
 * dsh-cost-meter's ledger — the only record on this machine of what was actually
 * spent. Unlike bili's index.db it has no upstream to rebuild from, so anything
 * done to it is treated as an edit of the books, not as clearing a leftover.
 * `cost-meter` writes under `${ledgerFile()}.lock` (a directory): respect it.
 */
export function ledgerFile() {
  return path.join(dshHome(), 'storages', 'cost-meter', 'ledger.json');
}

/**
 * The raw per-stream receipts dsh-cost-meter keeps beside the ledger:
 * `groups/*.json` (session → group map), `streams/<hash>/*.json` (token totals
 * per turn/step) and `calls/<hash>/*.jsonl` (one line per model call).
 *
 * These are evidence of *which* turn spent what — deleting them does not change
 * any aggregate in `ledger.json`, but it does lose the explanation. Off by
 * default for that reason.
 */
export function costMeterFilesRoot() {
  return path.join(dshHome(), 'storages', 'cost-meter', 'ledger.json.billion-context');
}

export function trashDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(stateDir(), 'trash', stamp);
}
