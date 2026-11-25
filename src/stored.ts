import { shortcutId } from "./links.ts";
import type { WriterRecord } from "./background-share.ts";
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
  /** Renames in an app's keys whose saved rows the person chose to leave as they are, by renameKey. */
  leftAlone?: Record<string, true>;
  /** `<kind path>\n<writer>` → what this vault decided about that writer of a shared kind. */
  writers?: Record<string, WriterRecord>;
}

/** The settings kept as maps of entries, merged entry by entry; anything else is merged as one value. */
const MAPS = ["grants", "folded", "linkKeys", "answerTo", "captureKeys", "leftAlone", "writers"] as const;

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
        key === "grants" ? (x, y) => (Array.isArray(x) && Array.isArray(y) ? [...new Set([...(y as unknown[]), ...(x as unknown[])])] : y) : undefined)
      : pick(b[key], d[key], l[key]);
    if (v !== undefined) out[key] = v;
  }
  return { ...out, grants: (out.grants as StoredData["grants"] | undefined) ?? {} };
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

/**
 * data.json as a host keeps it: the settings in use, read again when it changed on disk, and written
 * where the host may write it (gizmod only reads it: what is allowed is decided where a person is).
 */
export interface SettingsSource {
  readonly data: StoredData;
  reload(): Promise<void>;
  save?(): Promise<void>;
}

/** How data.json is read and written whole: Obsidian's loadData and saveData. */
export interface SettingsIO {
  load(): Promise<unknown>;
  save(data: StoredData): Promise<void>;
}

/**
 * data.json as this device keeps it: the settings in use, and each save merged with what is on disk
 * (see mergeSettings), one save or reload after another.
 */
export class SettingsFile implements SettingsSource {
  private io: SettingsIO;
  /** The settings in use: what this device changes, and what a save writes. */
  data: StoredData = { grants: {} };
  /** The settings as last read from or written to data.json: what a save tells this device's changes by. */
  private settingsBase: StoredData = { grants: {} };
  /** Saves and reloads of data.json, one after another. */
  private settingsQueue: Promise<unknown> = Promise.resolve();

  constructor(io: SettingsIO) {
    this.io = io;
  }

  /** Reads data.json as the plugin starts. */
  async open(): Promise<void> {
    this.data = await this.readSettings();
    this.settingsBase = structuredClone(this.data);
  }

  /** data.json changed on disk (a sync from another device): what changed there comes in, and what changed here and isn't saved yet stays. */
  reload(): Promise<void> {
    return this.queueSettings(async () => {
      const disk = await this.readSettings();
      this.data = mergeSettings(this.settingsBase, disk, this.data);
      this.settingsBase = disk;
    });
  }

  /**
   * Writes the settings to data.json: what changed here since they were last read or written, laid
   * over what is on disk now, entry by entry, so what another device saved meanwhile isn't lost.
   */
  save(): Promise<void> {
    return this.queueSettings(async () => {
      const local = structuredClone(this.data);
      const merged = mergeSettings(this.settingsBase, await this.readSettings(), local);
      await this.io.save(merged);
      this.settingsBase = structuredClone(merged);
      // What changed here while this was written stays; what came from disk comes in.
      this.data = mergeSettings(local, merged, this.data);
    });
  }

  /** data.json as it is on disk; one that can't be read (a sync caught mid-write) counts as unchanged since last read. */
  private async readSettings(): Promise<StoredData> {
    try {
      return { grants: {}, ...((await this.io.load()) as Partial<StoredData> | null) };
    } catch {
      return structuredClone(this.settingsBase);
    }
  }

  private queueSettings(fn: () => Promise<void>): Promise<void> {
    const run = this.settingsQueue.then(fn, fn);
    this.settingsQueue = run.catch(() => {});
    return run;
  }
}

/** What this vault decided about each writer of a shared kind, by writer. */
export function writersOf(stored: Pick<StoredData, "writers">, kindPath: string): Record<string, WriterRecord> {
  const prefix = `${kindPath}\n`;
  return Object.fromEntries(Object.entries(stored.writers ?? {}).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}
