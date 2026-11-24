import type { Adapter, AdapterPlan, AdapterResult, ApplyOptions, Family, PluginConfig, Probe, VerifyResult } from '../types.js';
export declare class DshContextAdapter implements Adapter {
    private readonly deps;
    readonly id: "dsh-context";
    constructor(deps?: {
        root?: string;
    });
    private root;
    probe(): Promise<Probe>;
    plan(family: Family, cfg: PluginConfig): Promise<AdapterPlan>;
    apply(plan: AdapterPlan, opts: ApplyOptions): Promise<AdapterResult>;
    /**
     * Rewrite one shard: back up the original into `batchDir/cache/`, drop the
     * family's entries, refresh `savedAt`, then atomically tmp + rename.
     */
    private rewriteShard;
    verify(family: Family): Promise<VerifyResult>;
}
