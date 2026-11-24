import os from 'node:os';
import path from 'node:path';
/** DSH home: `$DSH_HOME` wins (the launcher sets it), else `~/.dsh`. */
export function dshHome() {
    const env = process.env.DSH_HOME;
    if (typeof env === 'string' && env.trim() !== '')
        return env.trim();
    return path.join(os.homedir(), '.dsh');
}
/**
 * This plugin's own state (config, trash, log).
 *
 * `SESSION_LEFTOVER_PURGE_DIR` exists because `$DSH_HOME` alone cannot isolate
 * a test profile: bili's data directory is user-level and does not follow the
 * profile, so a sandbox run would still delete rows from the real index. Point
 * both this variable and `BILI_SESSIONS_DIR` somewhere throwaway for a
 * genuinely disposable run.
 */
export function stateDir() {
    const env = process.env.SESSION_LEFTOVER_PURGE_DIR;
    if (typeof env === 'string' && env.trim() !== '')
        return env.trim();
    return path.join(dshHome(), 'storages', 'session-leftover-purge');
}
export function trashDir() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(stateDir(), 'trash', stamp);
}
/**
 * billion-context session snapshots. Upstream default is the XDG data dir; on
 * Windows that is `%USERPROFILE%\.local\share\billion-context\sessions`.
 * `BILI_SESSIONS_DIR` overrides it, and that is what the running proxy uses.
 */
export function biliSessionsRoot() {
    const env = process.env.BILI_SESSIONS_DIR;
    if (typeof env === 'string' && env.trim() !== '')
        return env.trim();
    return path.join(os.homedir(), '.local', 'share', 'billion-context', 'sessions');
}
/** Where DSH keeps session transcripts (jsonl backend). */
export function dshSessionsRoot() {
    return path.join(dshHome(), 'sessions');
}
/**
 * dsh-cost-meter: the ledger plus its sibling caches. Unlike bili's index this
 * file has no upstream to rebuild from, so every edit is treated as an edit of
 * the books.
 */
export function costMeterRoot() {
    return path.join(dshHome(), 'storages', 'cost-meter');
}
export function ledgerFile() {
    return path.join(costMeterRoot(), 'ledger.json');
}
/** Raw per-turn receipts kept beside the ledger. */
export function costMeterDetailsRoot() {
    return path.join(costMeterRoot(), 'ledger.json.billion-context');
}
/** dsh-context: context overview cache, keyed by session inside shards. */
export function dshContextRoot() {
    return path.join(dshHome(), 'storages', 'dsh-context');
}
/** archive-manager's project cache (left behind by right-click delete). */
export function archiveProjcacheRoot() {
    return path.join(dshHome(), 'storages', 'session_projcache');
}
