import type { Adapter, AdapterPlan, AdapterResult, ApplyOptions, Family, PluginConfig, Probe, SessionStore, VerifyResult } from '../types.js';
export interface BiliDeps {
    root?: string;
}
export declare class BiliAdapter implements Adapter {
    private readonly deps;
    readonly id: "bili";
    constructor(deps?: BiliDeps);
    private root;
    probe(): Promise<Probe>;
    plan(family: Family, cfg: PluginConfig): Promise<AdapterPlan>;
    apply(plan: AdapterPlan, opts: ApplyOptions): Promise<AdapterResult>;
    verify(family: Family): Promise<VerifyResult>;
}
export interface SweepOptions {
    store: SessionStore;
    cfg: PluginConfig;
    batchDir: string;
    logger: {
        info(message: string): void;
        warn(message: string): void;
    };
    root?: string;
}
/**
 * Boot sweep: drop bindings that neither bili nor DSH still owns.
 *
 * The lane keeps the whole conversation table in memory and rewrites the blobs
 * from memory on every request, so a binding removed during the purge is back
 * within seconds. The window that holds is *before the lane starts*, which is
 * why this runs once at boot.
 */
export declare function sweepGhostKv(opts: SweepOptions): Promise<{
    ok: boolean;
    reason?: string;
    total?: number;
    kept?: number;
    backup?: string;
    dryRun?: boolean;
}>;
