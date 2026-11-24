import fs from 'node:fs';
import path from 'node:path';
import { inFamily } from '../core/family.js';
import { dshContextRoot } from '../runtime/paths.js';
/**
 * dsh-context keeps a context overview cache under `<root>/overview-cache.v3/`,
 * sharded into `shard-*.json` files. Each shard is:
 *
 *   { "format": 3, "savedAt": <epoch ms>, "sessions": [ { materialization, identity }, ... ] }
 *
 * `identity.path` is a `.../<session-id>/session.v4.jsonl.zstd` path, so a
 * top-level session id is one of its path segments. The subagent records are
 * keyed by a bare uuid and link back to their parent through
 * `materialization.facts.parentSession` (a `session-<uuid>` token). Rather than
 * trust those exact sub-fields — the on-disk shape has drifted before — the
 * matcher scans every string inside `materialization` for `session-<uuid>`
 * tokens, which is where both `facts.id` and `facts.parentSession` live.
 */
const SESSION_TOKEN = /session-[0-9a-zA-Z._-]+/g;
const SESSION_ID_SHAPE = /^session-[0-9a-zA-Z._-]+$/;
const SHARD_DIR = 'overview-cache.v3';
const MAX_JSON_BYTES = 64 * 1024 * 1024;
/**
 * Collect every `session-<uuid>` token out of an arbitrary value. `materialization`
 * is an object on this machine (with `facts`, `signature`, `values`), but the
 * brief described it as a NUL-joined string, so the same recursion handles both:
 * a string is regex'd directly, an object/array is walked recursively.
 */
function collectSessionTokens(value, out) {
    if (typeof value === 'string') {
        const matches = value.match(SESSION_TOKEN);
        if (matches !== null)
            for (const token of matches)
                out.add(token);
    }
    else if (Array.isArray(value)) {
        for (const item of value)
            collectSessionTokens(item, out);
    }
    else if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value))
            collectSessionTokens(child, out);
    }
}
/** Path segments of `identity.path` that are themselves a session id. */
function collectPathSegmentTokens(value, out) {
    if (typeof value !== 'string')
        return;
    for (const segment of value.split(/[\\/]/)) {
        if (SESSION_ID_SHAPE.test(segment))
            out.add(segment);
    }
}
/**
 * True when a session record belongs to `family`. Two independent signals:
 * (a) a `session-<uuid>` path segment in `identity.path`, and (b) a
 * `session-<uuid>` token anywhere inside `materialization` — which is how a
 * subagent record carries its parent's id.
 */
function recordMatches(record, family) {
    if (record === null || typeof record !== 'object')
        return false;
    const tokens = new Set();
    const entry = record;
    const identity = entry.identity;
    if (identity !== null && typeof identity === 'object') {
        collectPathSegmentTokens(identity.path, tokens);
    }
    collectSessionTokens(entry.materialization, tokens);
    for (const token of tokens) {
        if (inFamily(token, family.id))
            return true;
    }
    return false;
}
/** Number of `sessions[]` entries that belong to the family, or 0 when malformed. */
function familyEntryCount(shard, family) {
    if (shard === null || typeof shard !== 'object')
        return 0;
    const sessions = shard.sessions;
    if (!Array.isArray(sessions))
        return 0;
    return sessions.filter((record) => recordMatches(record, family)).length;
}
/**
 * Parse a shard defensively. Returns `undefined` when the file is missing, too
 * large, not JSON, or has no `sessions` array — callers must then leave it alone.
 */
function readShard(file) {
    let text;
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_JSON_BYTES)
            return undefined;
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object')
            return undefined;
        if (!Array.isArray(parsed.sessions))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** Every `overview-cache.v3/shard-*.json` file, sorted for stable reporting. */
function listShards(root) {
    const dir = path.join(root, SHARD_DIR);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isFile() && entry.name.startsWith('shard-') && entry.name.endsWith('.json'))
        .map((entry) => path.join(dir, entry.name))
        .sort();
}
export class DshContextAdapter {
    deps;
    id = 'dsh-context';
    constructor(deps = {}) {
        this.deps = deps;
    }
    root() {
        return this.deps.root ?? dshContextRoot();
    }
    async probe() {
        const root = this.root();
        const shards = listShards(root);
        const capabilities = [];
        if (shards.length > 0)
            capabilities.push(`cache:${shards.length}`);
        return {
            available: fs.existsSync(root),
            root,
            evidence: shards.length > 0
                ? `${shards.length} shard(s) under ${SHARD_DIR} at ${root}`
                : `no shards under ${path.join(root, SHARD_DIR)}`,
            capabilities,
        };
    }
    async plan(family, cfg) {
        const items = [];
        const notes = [];
        let total = 0;
        for (const shard of listShards(this.root())) {
            const parsed = readShard(shard);
            if (parsed === undefined) {
                notes.push(`${path.basename(shard)} unreadable or has no sessions array — left untouched`);
                continue;
            }
            const count = familyEntryCount(parsed, family);
            if (count === 0)
                continue;
            total += count;
            items.push({
                key: `cache:${shard}`,
                kind: 'cache-entry',
                target: shard,
                rows: count,
                risk: 'low',
                ...(cfg.dshContextCache ? {} : { reportOnly: true }),
            });
        }
        if (!cfg.dshContextCache && items.length > 0) {
            notes.push(`${items.length} shard(s) holding ${total} family entr(ies) reported only (dshContextCache off)`);
        }
        return { adapter: this.id, family, items, notes, writes: items.filter((item) => item.reportOnly !== true).length };
    }
    async apply(plan, opts) {
        const outcomes = [];
        if (opts.dryRun) {
            return {
                adapter: this.id,
                outcomes: plan.items.map((item) => ({ key: item.key, status: 'skipped', reason: 'dry-run' })),
            };
        }
        const cacheDir = path.join(opts.batchDir, 'cache');
        // plan() already stamps reportOnly from cfg, but re-read the flag here so
        // apply() never writes when the cache is configured report-only.
        const reportOnly = !opts.cfg.dshContextCache;
        let freed = 0;
        let wrote = false;
        for (const item of plan.items) {
            if (item.reportOnly === true || reportOnly) {
                outcomes.push({ key: item.key, status: 'reported' });
                continue;
            }
            const result = await this.rewriteShard(item, plan.family, cacheDir);
            outcomes.push(result.outcome);
            freed += result.freed;
            if (result.outcome.status === 'done')
                wrote = true;
        }
        return { adapter: this.id, outcomes, ...(wrote ? { backup: cacheDir } : {}), ...(freed > 0 ? { freed } : {}) };
    }
    /**
     * Rewrite one shard: back up the original into `batchDir/cache/`, drop the
     * family's entries, refresh `savedAt`, then atomically tmp + rename.
     */
    async rewriteShard(item, family, cacheDir) {
        const file = item.target;
        let parsed;
        let before;
        try {
            before = fs.readFileSync(file);
            parsed = JSON.parse(before.toString('utf8'));
        }
        catch (error) {
            return { outcome: { key: item.key, status: 'failed', detail: String(error) }, freed: 0 };
        }
        if (parsed === null || typeof parsed !== 'object') {
            return { outcome: { key: item.key, status: 'skipped', reason: 'no-sessions-array' }, freed: 0 };
        }
        const sessions = parsed.sessions;
        if (!Array.isArray(sessions)) {
            return { outcome: { key: item.key, status: 'skipped', reason: 'no-sessions-array' }, freed: 0 };
        }
        const kept = sessions.filter((record) => !recordMatches(record, family));
        if (kept.length === sessions.length) {
            return { outcome: { key: item.key, status: 'skipped', reason: 'nothing-to-remove' }, freed: 0 };
        }
        // Never rewrite until the original is safe in the batch.
        try {
            await fs.promises.mkdir(cacheDir, { recursive: true });
            await fs.promises.copyFile(file, path.join(cacheDir, path.basename(file)));
        }
        catch (error) {
            return { outcome: { key: item.key, status: 'failed', detail: `backup-failed:${String(error)}` }, freed: 0 };
        }
        const updated = { ...parsed, sessions: kept, savedAt: Date.now() };
        const next = JSON.stringify(updated);
        const tmp = `${file}.${process.pid}.purge-tmp`;
        try {
            await fs.promises.writeFile(tmp, next, 'utf8');
            await fs.promises.rename(tmp, file);
        }
        catch (error) {
            await fs.promises.rm(tmp, { force: true });
            return { outcome: { key: item.key, status: 'failed', detail: String(error) }, freed: 0 };
        }
        const removed = sessions.length - kept.length;
        return {
            outcome: { key: item.key, status: 'done', detail: `removed=${removed}` },
            freed: Math.max(0, before.length - Buffer.byteLength(next, 'utf8')),
        };
    }
    async verify(family) {
        const remaining = [];
        for (const shard of listShards(this.root())) {
            const parsed = readShard(shard);
            if (parsed === undefined)
                continue;
            const count = familyEntryCount(parsed, family);
            if (count > 0)
                remaining.push({ key: `cache:${shard}`, kind: 'cache-entry', target: shard, rows: count, risk: 'low' });
        }
        const rows = remaining.reduce((sum, item) => sum + (item.rows ?? 0), 0);
        return {
            adapter: this.id,
            ok: remaining.length === 0,
            remaining,
            evidence: `shards=${remaining.length} entries=${rows}`,
        };
    }
}
