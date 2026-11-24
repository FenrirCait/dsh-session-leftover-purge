import type { Family } from '../types.js';
export declare function isSessionId(value: unknown): value is string;
/** Parent id of a subagent pseudo-session, or undefined for anything else. */
export declare function subagentParentOf(value: unknown): string | undefined;
/** True for a session id and for the subagent pseudo-sessions it owns. */
export declare function isFamilyId(value: unknown): value is string;
/** The family root a given id belongs to (itself for a plain session id). */
export declare function familyRootOf(value: string): string;
/** A family with no known subagent children. */
export declare function familyOf(id: string, children?: string[]): Family;
/** Prefix used to match every child of `id` in SQL (`substr(col,1,n) = prefix`). */
export declare function childPrefix(id: string): string;
/**
 * JS-side membership test for a value that may be the parent, a child, or
 * something else entirely.
 */
export declare function inFamily(value: unknown, id: string): boolean;
