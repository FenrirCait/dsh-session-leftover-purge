import fs from 'node:fs';
import path from 'node:path';
import { inFamily } from '../core/family.js';
import { biliSessionsRoot } from '../runtime/paths.js';
/** Cap for the head read: every id field bili writes is in the first KBs. */
const HEAD_BYTES = 8192;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const ID_IN_HEAD = /"id"\s*:\s*"([^"]+)"/;
/**
 * Read the session id out of a snapshot file without parsing it.
 *
 * The old scan called `JSON.parse` on every file — 131 files / 80 MB on this
 * machine, ~384 ms per boot — to look at one field. A snapshot's `id` sits in
 * the first object of the file, so 8 KB of head plus a regex is enough for the
 * common case; only a file whose id is not in that window falls back to a full
 * parse, and the fallback is bounded by `MAX_JSON_BYTES`.
 */
export function readSnapshotId(file) {
    let stat;
    try {
        stat = fs.statSync(file);
    }
    catch {
        return undefined;
    }
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES)
        return undefined;
    const head = readHead(file);
    if (head !== undefined) {
        const match = ID_IN_HEAD.exec(head);
        const id = match?.[1];
        if (id !== undefined && id.length > 0) {
            // A truncated head can stop mid-string; only accept a complete-looking id.
            if (!id.endsWith('"'))
                return id;
        }
    }
    return readIdByParse(file);
}
function readHead(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(HEAD_BYTES);
        const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
        return buffer.toString('utf8', 0, read);
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch {
                /* already closed */
            }
        }
    }
}
function readIdByParse(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(text);
        const id = parsed?.id ?? parsed?.payload?.id;
        return typeof id === 'string' && id.length > 0 ? id : undefined;
    }
    catch {
        const match = ID_IN_HEAD.exec(text.slice(0, HEAD_BYTES));
        return match?.[1];
    }
}
/** Every `<root>/<protocol>/*.json` snapshot file. */
export function listSnapshotFiles(root = biliSessionsRoot()) {
    const out = [];
    let protocols;
    try {
        protocols = fs.readdirSync(root, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of protocols) {
        if (!entry.isDirectory())
            continue;
        const dir = path.join(root, entry.name);
        let files;
        try {
            files = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const file of files) {
            if (file.isFile() && file.name.endsWith('.json'))
                out.push(path.join(dir, file.name));
        }
    }
    return out;
}
/** Snapshot files that belong to this family, with the id that matched. */
export function findFamilySnapshots(family, root = biliSessionsRoot()) {
    const hits = [];
    for (const file of listSnapshotFiles(root)) {
        const id = readSnapshotId(file);
        if (id === undefined || !inFamily(id, family.id))
            continue;
        let bytes = 0;
        try {
            bytes = fs.statSync(file).size;
        }
        catch {
            /* size is informational only */
        }
        hits.push({ file, id, bytes });
    }
    return hits;
}
export function snapshotPlanItems(hits, reportOnly) {
    return hits.map((hit) => ({
        key: `snapshot:${hit.file}`,
        kind: 'snapshot',
        target: hit.file,
        bytes: hit.bytes,
        risk: 'low',
        ...(reportOnly ? { reportOnly: true } : {}),
    }));
}
/**
 * Move a snapshot into the batch. `rename` first (same volume, atomic); the
 * copy+unlink fallback exists because the batch directory can sit on another
 * drive, and a half-moved file must never be left behind.
 */
export async function moveSnapshot(file, sessionId, batchDir) {
    const fsPromises = fs.promises;
    await fsPromises.mkdir(batchDir, { recursive: true });
    const target = path.join(batchDir, `${sessionId}__${path.basename(file)}`);
    try {
        await fsPromises.rename(file, target);
    }
    catch {
        await fsPromises.copyFile(file, target);
        await fsPromises.unlink(file);
    }
    return target;
}
/** Remaining snapshot files for a family — used by verify(). */
export function remainingSnapshots(family, root = biliSessionsRoot()) {
    return findFamilySnapshots(family, root).map((hit) => hit.file);
}
