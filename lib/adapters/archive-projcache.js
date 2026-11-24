import fs from 'node:fs';
import path from 'node:path';
import { inFamily } from '../core/family.js';
import { archiveProjcacheRoot } from '../runtime/paths.js';
/**
 * archive-manager's project cache lives at `<root>/sessions/*.json`. The format
 * is unknown to us, so this adapter only ever trusts one signal: a filename of
 * the shape `session-<uuid>.json`, which is the DSH session id verbatim.
 *
 * The real directory also holds many `<bare-uuid>.json` files whose contents
 * carry no session id and no parent link, so they cannot be mapped to a family.
 * Those are deliberately never touched — they are reported as `unkeyed` and the
 * plan leaves them alone.
 */
const SESSION_FILE = /^session-[0-9a-zA-Z._-]+\.json$/;
/** The session id a file is keyed by, or undefined when it is not session-keyed. */
function sessionIdOf(file) {
    const base = path.basename(file);
    if (!SESSION_FILE.test(base))
        return undefined;
    return base.slice(0, -'.json'.length);
}
/**
 * Discover candidate files. The real layout nests them under `<root>/sessions/`;
 * if that directory is absent, fall back to `<root>/*.json` so a flatter future
 * layout is not silently missed.
 */
function listSessionFiles(root) {
    const candidates = [path.join(root, 'sessions'), root];
    for (const dir of candidates) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const files = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => path.join(dir, entry.name));
        if (files.length > 0)
            return files.sort();
    }
    return [];
}
export class ArchiveProjcacheAdapter {
    deps;
    id = 'archive-projcache';
    constructor(deps = {}) {
        this.deps = deps;
    }
    root() {
        return this.deps.root ?? archiveProjcacheRoot();
    }
    async probe() {
        const root = this.root();
        const files = listSessionFiles(root);
        const keyed = files.filter((file) => sessionIdOf(file) !== undefined).length;
        const unkeyed = files.length - keyed;
        const capabilities = [];
        if (keyed > 0)
            capabilities.push(`sessionKeyed:${keyed}`);
        if (unkeyed > 0)
            capabilities.push(`unkeyed:${unkeyed}`);
        return {
            // Only advertise as available when a reliable session-id extraction exists;
            // a directory full of bare-uuid files is not actionable.
            available: keyed > 0,
            root,
            evidence: `${keyed} session-keyed file(s), ${unkeyed} unkeyed file(s) under ${root}`,
            capabilities,
        };
    }
    async plan(family, cfg) {
        const items = [];
        const notes = [];
        const files = listSessionFiles(this.root());
        for (const file of files) {
            const id = sessionIdOf(file);
            if (id === undefined || !inFamily(id, family.id))
                continue;
            let bytes = 0;
            try {
                bytes = fs.statSync(file).size;
            }
            catch {
                /* size is informational only */
            }
            items.push({
                key: `cache-entry:${file}`,
                kind: 'cache-entry',
                target: file,
                bytes,
                risk: 'low',
                ...(cfg.archiveProjcache ? {} : { reportOnly: true }),
            });
        }
        if (!cfg.archiveProjcache && items.length > 0) {
            notes.push(`${items.length} projcache file(s) reported only (archiveProjcache off)`);
        }
        const unkeyed = files.filter((file) => sessionIdOf(file) === undefined).length;
        if (unkeyed > 0)
            notes.push(`${unkeyed} projcache file(s) not session-keyed — left untouched`);
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
        const backupRoot = path.join(opts.batchDir, 'projcache');
        // Re-read the flag from opts.cfg so apply() stays report-only even if the
        // plan items were built under a different config.
        const reportOnly = !opts.cfg.archiveProjcache;
        let backup;
        let freed = 0;
        for (const item of plan.items) {
            if (item.reportOnly === true || reportOnly) {
                outcomes.push({ key: item.key, status: 'reported' });
                continue;
            }
            // Copy first, then unlink: a cache file that cannot be backed up is not deleted.
            try {
                await fs.promises.mkdir(backupRoot, { recursive: true });
                await fs.promises.copyFile(item.target, path.join(backupRoot, path.basename(item.target)));
            }
            catch (error) {
                outcomes.push({ key: item.key, status: 'failed', detail: `backup-failed:${String(error)}` });
                continue;
            }
            let bytes = 0;
            try {
                bytes = fs.statSync(item.target).size;
            }
            catch {
                /* already gone */
            }
            try {
                await fs.promises.unlink(item.target);
                outcomes.push({ key: item.key, status: 'done' });
                freed += bytes;
                backup = backupRoot;
            }
            catch (error) {
                outcomes.push({ key: item.key, status: 'failed', detail: `remove:${String(error)}` });
            }
        }
        return { adapter: this.id, outcomes, ...(backup === undefined ? {} : { backup }), ...(freed > 0 ? { freed } : {}) };
    }
    async verify(family) {
        const remaining = [];
        for (const file of listSessionFiles(this.root())) {
            const id = sessionIdOf(file);
            if (id === undefined || !inFamily(id, family.id))
                continue;
            remaining.push({ key: `cache-entry:${file}`, kind: 'cache-entry', target: file, risk: 'low' });
        }
        return {
            adapter: this.id,
            ok: remaining.length === 0,
            remaining,
            evidence: `projcache=${remaining.length}`,
        };
    }
}
