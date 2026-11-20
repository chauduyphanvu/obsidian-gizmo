import { shortcutId } from "./links.ts";
import type { AppliedPolicy } from "./policy.ts";

/** Gizmo's settings as kept in the plugin's data.json, shared by every device a sync reaches. */
export interface StoredData {
  /** Note path → the permissions the user allowed; empty for an app opened that asks for none. */
  grants: Record<string, string[]>;
  /** Lens component paths the user folded away. */
  folded?: Record<string, true>;
  /** `<app path>#<shortcut>` → the key that shortcut's copied link carries. */
  linkKeys?: Record<string, string>;
  /** `<app path>#<shortcut>` → the apps (`scheme://host`) its keyed link may send word back to without asking. */
  answerTo?: Record<string, string[]>;
  /** A capture link's key → each capture name it may run without asking, with the `<app path>#<shortcut>` it named then. */
  captureKeys?: Record<string, Record<string, string>>;
  /** The data policy as last applied: until Apply, an edited policy note changes nothing. */
  policy?: AppliedPolicy;
}

/** The settings kept as maps of entries, merged entry by entry; anything else is merged as one value. */
const MAPS = ["grants", "folded", "linkKeys", "answerTo", "captureKeys"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One value changed on either side since `base`: the side that changed it wins; when both did, this
 * device's (`local`) does, except that a delete loses to a change. `both` merges two changed values.
 */
function pick<T>(base: T | undefined, disk: T | undefined, local: T | undefined, both?: (disk: T, local: T) => T): T | undefined {
  if (same(local, base)) return disk;
  if (same(disk, base)) return local;
  if (local === undefined) return disk;
  if (disk === undefined) return local;
  return both ? both(disk, local) : local;
}

function mergeMap<T>(base: Record<string, T> = {}, disk: Record<string, T> = {}, local: Record<string, T> = {}, both?: (disk: T, local: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(disk), ...Object.keys(local)])) {
    const v = pick(Object.hasOwn(base, key) ? base[key] : undefined, Object.hasOwn(disk, key) ? disk[key] : undefined, Object.hasOwn(local, key) ? local[key] : undefined, both);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Settings as this device saves them: what changed here since `base` (the settings as last read or
 * written) laid over what is on disk now, entry by entry, so a grant, key or fold another device saved
 * meanwhile isn't overwritten. A sync tool that keeps only the last whole file can still lose a save;
 * this keeps every save from losing the others.
 */
export function mergeSettings(base: StoredData, disk: StoredData, local: StoredData): StoredData {
  const out: Record<string, unknown> = {};
  const b = base as unknown as Record<string, unknown>;
  const d = disk as unknown as Record<string, unknown>;
  const l = local as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(d), ...Object.keys(l)])) {
    const v = (MAPS as readonly string[]).includes(key)
      ? mergeMap(b[key] as Record<string, unknown>, d[key] as Record<string, unknown>, l[key] as Record<string, unknown>,
        // Two devices allowing different things for one app: both were allowed.
        key === "grants" ? (x, y) => (Array.isArray(x) && Array.isArray(y) ? [...new Set([...y, ...x])] : y) : undefined)
      : pick(b[key], d[key], l[key]);
    if (v !== undefined) out[key] = v;
  }
  return { ...out, grants: (out.grants as StoredData["grants"] | undefined) ?? {} } as StoredData;
}

/** The key a shortcut's copied link carries; undefined when none was made. */
export function linkKeyOf(stored: Pick<StoredData, "linkKeys">, path: string, shortcut: string): string | undefined {
  const keys = stored.linkKeys;
  const id = shortcutId(path, shortcut);
  return keys && Object.hasOwn(keys, id) ? keys[id] : undefined;
}

/** The apps (`scheme://host`) a shortcut's keyed link may send word back to without asking. */
export function destinationsOf(stored: Pick<StoredData, "answerTo">, path: string, shortcut: string): string[] {
  return stored.answerTo?.[shortcutId(path, shortcut)] ?? [];
}

/** What a capture link's key may run without asking: name → shortcut id; undefined for a key Gizmo never made. */
export function captureNamesOf(stored: Pick<StoredData, "captureKeys">, key: string): Record<string, string> | undefined {
  const keys = stored.captureKeys;
  return keys && Object.hasOwn(keys, key) ? keys[key] : undefined;
}
