import type { Adapter, AdapterPlan, AdapterResult, ApplyOptions, Family, PluginConfig, Probe, VerifyResult } from '../types.js';
export declare class CostMeterAdapter implements Adapter {
    private readonly deps;
    readonly id: "cost-meter";
    constructor(deps?: {
        root?: string;
    });
    private ledgerPath;
    probe(): Promise<Probe>;
    plan(family: Family, cfg: PluginConfig): Promise<AdapterPlan>;
    apply(plan: AdapterPlan, opts: ApplyOptions): Promise<AdapterResult>;
    private applyLedger;
    private applyDetails;
    verify(family: Family): Promise<VerifyResult>;
}
