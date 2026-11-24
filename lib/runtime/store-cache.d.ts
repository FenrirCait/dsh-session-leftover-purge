import type { SessionStore } from '../types.js';
/**
 * Two ways to ask "which sessions exist?": cached and fresh.
 *
 * The boot pass asks several times in a row and the answer cannot change while
 * DSH starts, so it caches. The delete handler must never cache: a session that
 * was in the boot snapshot is exactly the one about to be purged, and a cached
 * answer would make every retry conclude "still alive" and skip the cleanup.
 * That was the P1 Codex found on PR #8 — the handler shared one snapshot with
 * the boot pass.
 */
export interface StoreCache {
    /** Read once per process; used by the boot pass and the ready log. */
    cached(): Promise<SessionStore>;
    /** Always re-reads; used by the delete path, including every retry. */
    fresh(): Promise<SessionStore>;
    /** Drop the cached snapshot (tests, and after a purge). */
    reset(): void;
}
export declare function createStoreCache(load?: () => Promise<SessionStore>): StoreCache;
