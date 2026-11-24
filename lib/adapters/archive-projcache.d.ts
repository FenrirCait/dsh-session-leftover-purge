import type { Adapter, AdapterPlan, AdapterResult, ApplyOptions, Family, PluginConfig, Probe, VerifyResult } from '../types.js';
export declare class ArchiveProjcacheAdapter implements Adapter {
    private readonly deps;
    readonly id: "archive-projcache";
    constructor(deps?: {
        root?: string;
    });
    private root;
    probe(): Promise<Probe>;
    plan(family: Family, cfg: PluginConfig): Promise<AdapterPlan>;
    apply(plan: AdapterPlan, opts: ApplyOptions): Promise<AdapterResult>;
    verify(family: Family): Promise<VerifyResult>;
}
