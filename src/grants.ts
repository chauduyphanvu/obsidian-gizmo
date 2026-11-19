/**
 * Whether `wanted` is allowed under a grant key: exactly these were allowed, or there are none to
 * allow. With `opened`, wanting nothing isn't enough: the app must have been opened in its own tab,
 * which leaves an entry even when it asks for nothing. The background acts only for such apps, so
 * a note that became an app without the user looking at it never runs unseen.
 */
export function isAllowed(grants: Record<string, string>, key: string, wanted: readonly string[], opened = false): boolean {
  const entry = Object.hasOwn(grants, key) ? grants[key] : undefined;
  return (wanted.length === 0 && !opened) || entry === wanted.join("\n");
}

/** The grant keys that belong to a note: its own (an app's) and its embeds' (`<path>#<hash>`). */
function grantKeysOf(grants: Record<string, string>, path: string): string[] {
  return Object.keys(grants).filter((k) => k === path || k.startsWith(`${path}#`));
}

/** Moves a renamed note's grants, its embeds' included; true when there were any. */
export function moveGrants(grants: Record<string, string>, oldPath: string, path: string): boolean {
  const keys = grantKeysOf(grants, oldPath);
  for (const key of keys) {
    const value = grants[key];
    delete grants[key];
    grants[path + key.slice(oldPath.length)] = value;
  }
  return keys.length > 0;
}

/** Drops a deleted note's grants, its embeds' included; true when there were any. */
export function dropGrants(grants: Record<string, string>, path: string): boolean {
  const keys = grantKeysOf(grants, path);
  for (const key of keys) delete grants[key];
  return keys.length > 0;
}

/** What was allowed under a grant key last time; undefined when it was never allowed or opened. */
export function grantedOf(grants: Record<string, string>, key: string): string[] | undefined {
  const entry = grants[key];
  return entry === undefined ? undefined : entry ? entry.split("\n") : [];
}

/** Keeps that exactly `wanted` is allowed under a grant key. */
export function setGrant(grants: Record<string, string>, key: string, wanted: readonly string[]): void {
  grants[key] = wanted.join("\n");
}
