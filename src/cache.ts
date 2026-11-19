import { fnv1a } from "./hash.ts";

/**
 * The disk copy of web responses: one JSON file per request under the plugin's `cache` folder, so
 * an app paints at once after a restart and still shows something when the network is down.
 */

/** A response as it came: when it was fetched, and its body. */
export interface CacheEntry {
  at: number;
  text: string;
  contentType: string;
}

/** The part of Obsidian's DataAdapter the cache uses; tests pass an in-memory one. */
export interface CacheAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Larger responses aren't kept; past this many entries the oldest go. */
export const MAX_ENTRY_BYTES = 1_000_000;
export const MAX_ENTRIES = 200;

function fnv(text: string, seed: number): string {
  return fnv1a(text, seed).toString(16).padStart(8, "0");
}

/** A file name for a key: two FNV-1a passes with different seeds. Files hold their key, so a collision is caught on read. */
export function cacheHash(key: string): string {
  return fnv(key, 0x811c9dc5) + fnv(key, 0x050c5d1f);
}

export class DiskCache {
  private adapter: CacheAdapter;
  private dir: string;
  /** Hash → when it was written and its size, read from the folder once. */
  private index: Promise<Map<string, { at: number; size: number }>> | undefined;

  constructor(adapter: CacheAdapter, dir: string) {
    this.adapter = adapter;
    this.dir = dir;
  }

  private path(hash: string): string {
    return `${this.dir}/${hash}.json`;
  }

  private load(): Promise<Map<string, { at: number; size: number }>> {
    this.index ??= (async () => {
      const index = new Map<string, { at: number; size: number }>();
      try {
        if (!(await this.adapter.exists(this.dir))) {
          await this.adapter.mkdir(this.dir);
          return index;
        }
        for (const file of (await this.adapter.list(this.dir)).files) {
          const hash = file.split("/").pop()!.replace(/\.json$/, "");
          const stat = await this.adapter.stat(file);
          if (stat && file.endsWith(".json")) index.set(hash, { at: stat.mtime, size: stat.size });
        }
      } catch {
        // An unreadable folder is an empty cache; writes try again.
      }
      return index;
    })();
    return this.index;
  }

  /** The stored response for this key, or undefined (none, unreadable, or another key's). */
  async read(key: string): Promise<CacheEntry | undefined> {
    const hash = cacheHash(key);
    if (!(await this.load()).has(hash)) return undefined;
    try {
      const stored = JSON.parse(await this.adapter.read(this.path(hash))) as CacheEntry & { key: string };
      if (stored.key !== key || typeof stored.text !== "string" || typeof stored.at !== "number") return undefined;
      return { at: stored.at, text: stored.text, contentType: String(stored.contentType ?? "") };
    } catch {
      return undefined;
    }
  }

  /** Stores a response; too big, it's skipped. Never throws: the cache is a convenience. */
  async write(key: string, entry: CacheEntry): Promise<void> {
    const json = JSON.stringify({ key, at: entry.at, contentType: entry.contentType, text: entry.text });
    const size = new TextEncoder().encode(json).length;
    if (size > MAX_ENTRY_BYTES) return;
    const index = await this.load();
    const hash = cacheHash(key);
    try {
      await this.adapter.write(this.path(hash), json);
    } catch {
      return;
    }
    index.set(hash, { at: entry.at, size });
    if (index.size <= MAX_ENTRIES) return;
    const oldest = [...index].sort((a, b) => a[1].at - b[1].at).slice(0, index.size - MAX_ENTRIES);
    for (const [h] of oldest) {
      index.delete(h);
      await this.adapter.remove(this.path(h)).catch(() => {});
    }
  }
}

/** `as of 3 hours ago`: how old a disk copy is. */
export function asOfText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 1440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  if (minutes < 1) return "as of just now";
  return `as of ${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
