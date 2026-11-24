import { Config } from './schema.js';
import { DEFAULTS, configPath } from './config.js';
export declare const name = "dsh-session-leftover-purge";
/**
 * No service is injected on purpose: this plugin only listens on the public
 * `api-session/removed` event, so it can never interfere with session creation,
 * deletion or the workspace registry.
 */
export declare const inject: string[];
interface HostLogger {
    info?(message: string): void;
    warn?(message: string): void;
}
/** Structural view of the Cordis context; `src/index.ts` is the only file that knows about it. */
interface HostContext {
    logger?: HostLogger;
    on?(event: string, handler: (payload?: unknown) => void): (() => void) | void;
    inject?(deps: string[], callback: (ctx: HostContext) => void): void;
}
export declare function apply(ctx: HostContext, config?: unknown): () => void;
export { Config, configPath, DEFAULTS };
