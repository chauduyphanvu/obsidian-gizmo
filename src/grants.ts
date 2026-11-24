/**
 * Whether `wanted` is allowed under a grant key: each permission it wants was allowed, or it wants
 * none. A permission allowed once and no longer wanted takes nothing away, so an edit or an update
 * that drops one never stops an app; a new one asks. With `opened`, wanting nothing isn't enough:
 * the app must have been opened in its own tab, which leaves an entry even when it asks for
 * nothing. The background acts only for such apps, so a note that became an app without the user
 * looking at it never runs unseen. Grants are compared as lists of whole permissions: an entry kept
 * as anything else is asked for again.
 */
export function isAllowed(grants: Record<string, string[]>, key: string, wanted: readonly string[], opened = false): boolean {
  if (wanted.length === 0 && !opened) return true;
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  return Array.isArray(entry) && wanted.every((p) => entry.includes(p));
}

/**
 * Whether an app is allowed under a data policy: everything the policy doesn't cover (`asked`) was
 * allowed. A policy that comes to cover more never makes an allowed app ask again; one that covers
 * less asks for just what it no longer covers. With `opened`, asking for nothing still needs the
 * app to have been opened once, as `isAllowed`.
 */
export function isAllowedUnder(grants: Record<string, string[]>, key: string, asked: readonly string[], opened = false): boolean {
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  if (asked.length === 0) return !opened || Array.isArray(entry);
  return Array.isArray(entry) && asked.every((p) => entry.includes(p));
}

/** Whether an app may run: under a data policy (`asked` given), by isAllowedUnder; else by isAllowed. */
export function isGranted(grants: Record<string, string[]>, key: string, wanted: readonly string[], opened: boolean, asked?: readonly string[]): boolean {
  return asked ? isAllowedUnder(grants, key, asked, opened) : isAllowed(grants, key, wanted, opened);
}

/**
 * Whether an allowed app is paused: it was allowed (an entry is kept) but asks now for something
 * that entry doesn't hold. No entry at all is never paused: the app was revoked or never allowed.
 */
export function isPaused(grants: Record<string, string[]>, key: string, wanted: readonly string[], asked?: readonly string[]): boolean {
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  if (!Array.isArray(entry)) return false;
  return (asked ?? wanted).some((p) => !entry.includes(p));
}

/**
 * Permissions given a new wording by a later Gizmo: each takes an old permission and returns its new
 * wording, or undefined. Applied on load, they add the new wording beside the old and never take the
 * old away, so a device still on an older Gizmo (gizmod reads the same grants) keeps working.
 */
export const PERMISSION_MIGRATIONS: readonly ((perm: string) => string | undefined)[] = [];

/** Adds each permission's new wording to every grant that holds the old; true when any grant changed. */
export function migrateGrants(grants: Record<string, string[]>, migrations = PERMISSION_MIGRATIONS): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(grants)) {
    if (!Array.isArray(entry)) continue;
    const added = entry.flatMap((p) => migrations.map((m) => m(p)).filter((n): n is string => n !== undefined && !entry.includes(n)));
    if (!added.length) continue;
    grants[key] = [...entry, ...new Set(added)];
    changed = true;
  }
  return changed;
}

/** The keys that belong to a note: its own (an app's) and its embeds' or shortcuts' (`<path>#…`). */
function keysOf<T>(byKey: Record<string, T>, path: string): string[] {
  return Object.keys(byKey).filter((k) => k === path || k.startsWith(`${path}#`));
}

/** Moves a renamed note's entries (grants, link keys), its embeds' included; true when there were any. */
export function moveGrants<T>(byKey: Record<string, T>, oldPath: string, path: string): boolean {
  const keys = keysOf(byKey, oldPath);
  for (const key of keys) {
    const value = byKey[key];
    delete byKey[key];
    byKey[path + key.slice(oldPath.length)] = value;
  }
  return keys.length > 0;
}

/** Drops a deleted note's entries (grants, link keys), its embeds' included; true when there were any. */
export function dropGrants<T>(byKey: Record<string, T>, path: string): boolean {
  const keys = keysOf(byKey, path);
  for (const key of keys) delete byKey[key];
  return keys.length > 0;
}

/** What was allowed under a grant key last time; undefined when it was never allowed or opened. */
export function grantedOf(grants: Record<string, string[]>, key: string): string[] | undefined {
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  return Array.isArray(entry) ? [...entry] : undefined;
}

/** Keeps that exactly `wanted` is allowed under a grant key. */
export function setGrant(grants: Record<string, string[]>, key: string, wanted: readonly string[]): void {
  grants[key] = [...wanted];
}

/** Whether a grant key holds exactly these permissions, in any order. */
export function sameGrant(grants: Record<string, string[]>, key: string, wanted: readonly string[]): boolean {
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  return Array.isArray(entry) && entry.length === new Set(wanted).size && wanted.every((p) => entry.includes(p));
}
