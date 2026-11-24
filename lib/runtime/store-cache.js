import { loadSessionStore } from '../core/session-store.js';
export function createStoreCache(load = () => loadSessionStore()) {
    let pending;
    return {
        cached: () => (pending ??= load()),
        fresh: () => load(),
        reset: () => {
            pending = undefined;
        },
    };
}
