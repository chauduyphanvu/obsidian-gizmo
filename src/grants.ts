/**
 * Whether `wanted` is allowed under a grant key: exactly these were allowed, or there are none to
 * allow. With `opened`, wanting nothing isn't enough: the app must have been opened in its own tab,
 * which leaves an entry even when it asks for nothing. The background acts only for such apps, so
 * a note that became an app without the user looking at it never runs unseen. Grants are compared
 * as lists, permission by permission: an entry kept as anything else is asked for again.
 */
export function isAllowed(grants: Record<string, string[]>, key: string, wanted: readonly string[], opened = false): boolean {
  if (wanted.length === 0 && !opened) return true;
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  return Array.isArray(entry) && entry.length === wanted.length && entry.every((p, i) => p === wanted[i]);
}

/**
 * Whether an app is allowed under a data policy: everything the policy doesn't cover (`asked`) was
 * allowed, and nothing allowed is beyond what it wants now. A policy that comes to cover more never
 * makes an allowed app ask again; one that covers less asks for just what it no longer covers.
 * With `opened`, asking for nothing still needs the app to have been opened once, as `isAllowed`.
 */
export function isAllowedUnder(grants: Record<string, string[]>, key: string, wanted: readonly string[], asked: readonly string[], opened = false): boolean {
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  if (asked.length === 0) return !opened || Array.isArray(entry);
  return Array.isArray(entry) && asked.every((p) => entry.includes(p)) && entry.every((p) => wanted.includes(p));
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
