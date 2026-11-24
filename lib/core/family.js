const SESSION_ID_SHAPE = /^session-[0-9a-zA-Z._-]+$/;
/**
 * bili files a subagent run as its own session: `session-<parent>|sub:<hex>`.
 *
 * Nothing else ever deletes those rows. bili's own `deleteSession` is an exact
 * `WHERE session_id = ?`, and DSH emits exactly one `api-session/removed` for
 * the parent — so a deleted parent used to leave its whole subagent family
 * behind. Everything below therefore works on a *family*: the id plus every
 * `|sub:` child it owns.
 */
const SUBAGENT_SUFFIX = '|sub:';
const SUBAGENT_TAIL_SHAPE = /^[0-9a-f]{6,}$/;
export function isSessionId(value) {
    return typeof value === 'string' && SESSION_ID_SHAPE.test(value);
}
/** Parent id of a subagent pseudo-session, or undefined for anything else. */
export function subagentParentOf(value) {
    if (typeof value !== 'string')
        return undefined;
    const at = value.indexOf(SUBAGENT_SUFFIX);
    if (at < 0)
        return undefined;
    const parent = value.slice(0, at);
    const tail = value.slice(at + SUBAGENT_SUFFIX.length);
    if (!SESSION_ID_SHAPE.test(parent) || !SUBAGENT_TAIL_SHAPE.test(tail))
        return undefined;
    return parent;
}
/** True for a session id and for the subagent pseudo-sessions it owns. */
export function isFamilyId(value) {
    return isSessionId(value) || subagentParentOf(value) !== undefined;
}
/** The family root a given id belongs to (itself for a plain session id). */
export function familyRootOf(value) {
    return subagentParentOf(value) ?? value;
}
/** A family with no known subagent children. */
export function familyOf(id, children = []) {
    return { id, children: [...new Set(children)].sort() };
}
/** Prefix used to match every child of `id` in SQL (`substr(col,1,n) = prefix`). */
export function childPrefix(id) {
    return `${id}${SUBAGENT_SUFFIX}`;
}
/**
 * JS-side membership test for a value that may be the parent, a child, or
 * something else entirely.
 */
export function inFamily(value, id) {
    return typeof value === 'string' && (value === id || subagentParentOf(value) === id);
}
