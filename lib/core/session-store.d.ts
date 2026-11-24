import type { SessionStore } from '../types.js';
/**
 * Resolve the backend once and cache the id set. Every caller asks the same
 * question during one boot pass, and the answer cannot change while DSH runs.
 */
export declare function loadSessionStore(root?: string): Promise<SessionStore>;
