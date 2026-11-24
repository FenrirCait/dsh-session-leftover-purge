/** DSH home: `$DSH_HOME` wins (the launcher sets it), else `~/.dsh`. */
export declare function dshHome(): string;
/**
 * This plugin's own state (config, trash, log).
 *
 * `SESSION_LEFTOVER_PURGE_DIR` exists because `$DSH_HOME` alone cannot isolate
 * a test profile: bili's data directory is user-level and does not follow the
 * profile, so a sandbox run would still delete rows from the real index. Point
 * both this variable and `BILI_SESSIONS_DIR` somewhere throwaway for a
 * genuinely disposable run.
 */
export declare function stateDir(): string;
export declare function trashDir(): string;
/**
 * billion-context session snapshots. Upstream default is the XDG data dir; on
 * Windows that is `%USERPROFILE%\.local\share\billion-context\sessions`.
 * `BILI_SESSIONS_DIR` overrides it, and that is what the running proxy uses.
 */
export declare function biliSessionsRoot(): string;
/** Where DSH keeps session transcripts (jsonl backend). */
export declare function dshSessionsRoot(): string;
/**
 * dsh-cost-meter: the ledger plus its sibling caches. Unlike bili's index this
 * file has no upstream to rebuild from, so every edit is treated as an edit of
 * the books.
 */
export declare function costMeterRoot(): string;
export declare function ledgerFile(): string;
/** Raw per-turn receipts kept beside the ledger. */
export declare function costMeterDetailsRoot(): string;
/** dsh-context: context overview cache, keyed by session inside shards. */
export declare function dshContextRoot(): string;
/** archive-manager's project cache (left behind by right-click delete). */
export declare function archiveProjcacheRoot(): string;
