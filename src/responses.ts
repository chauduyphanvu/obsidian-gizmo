/**
 * Web responses as they came, kept per device under the plugin's `responses` folder:
 * - `<device>/latest.json`: each request's newest response, so an app paints at once after a
 *   restart and still shows something when the network is down;
 * - `<device>/index.jsonl`: a line each time a request's answer changed, and once an hour while it
 *   didn't, so what an app showed at a past time can be shown again;
 * - `<device>/blobs/<sha256>.txt`: each answer's text, kept once however often it came.
 * A device writes only its own folder; reading the past reads every device's. Lines older than 90
 * days go, and the oldest go past 200 MB a device.
 */

/** A response as it came: when it was fetched, and its body. */
export interface StoredResponse {
  at: number;
  text: string;
  contentType: string;
}

/** The part of Obsidian's DataAdapter (or Node's fs) the history uses; tests pass an in-memory one. */
export interface FolderAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const MAX_BODY_BYTES = 1_000_000;
export const KEEP_MS = 90 * 24 * 3_600_000;
export const MAX_DEVICE_BYTES = 200_000_000;
/** An answer that hasn't changed gets a line this often, so the history says it was still the answer. */
export const STILL_EVERY_MS = 3_600_000;
/** Pruned after this many lines are added, and when first read. */
const PRUNE_EVERY = 200;

/** One kept answer: the request's key, when, the text's hash and size, and its type. */
interface Line {
  k: string;
  at: number;
  h: string;
  ct: string;
  n: number;
}

interface Own {
  latest: Map<string, Line>;
  lines: Line[];
  /** Each key's newest line. */
  last: Map<string, Line>;
  /** Blobs written, by hash: their size. */
  blobs: Map<string, number>;
  added: number;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as Partial<Line>;
      if (typeof l.k === "string" && typeof l.at === "number" && typeof l.h === "string") out.push({ k: l.k, at: l.at, h: l.h, ct: String(l.ct ?? ""), n: Number(l.n ?? 0) });
    } catch {
      // A line cut short by a sync is skipped.
    }
  }
  return out;
}

export class ResponseHistory {
  private adapter: FolderAdapter;
  private dir: string;
  private device: () => string;
  private now: () => number;
  private own_: Promise<Own> | undefined;
  /** Every device's lines by key, newest last, with the device that keeps each. */
  private all: Promise<Map<string, (Line & { d: string })[]>> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(adapter: FolderAdapter, dir: string, device: () => string, now: () => number) {
    this.adapter = adapter;
    this.dir = dir;
    this.device = device;
    this.now = now;
  }

  private folder(device = this.device()): string {
    return `${this.dir}/${device}`;
  }

  private blobPath(h: string, device = this.device()): string {
    return `${this.folder(device)}/blobs/${h}.txt`;
  }

  private own(): Promise<Own> {
    this.own_ ??= (async () => {
      const own: Own = { latest: new Map(), lines: [], last: new Map(), blobs: new Map(), added: 0 };
      const f = this.folder();
      try {
        const kept = JSON.parse(await this.adapter.read(`${f}/latest.json`)) as { latest?: Record<string, Line> };
        for (const [k, l] of Object.entries(kept.latest ?? {})) own.latest.set(k, l);
      } catch {
        // None yet.
      }
      own.lines = await this.adapter.read(`${f}/index.jsonl`).then(readLines, () => []);
      for (const l of [...own.lines, ...own.latest.values()]) own.blobs.set(l.h, l.n);
      for (const l of own.lines) if ((own.last.get(l.k)?.at ?? -Infinity) <= l.at) own.last.set(l.k, l);
      await this.prune(own);
      return own;
    })();
    return this.own_;
  }

  /** One write at a time, so lines and files land in the order they were made. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async mkdirs(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (p && !(await this.adapter.exists(p))) await this.adapter.mkdir(p);
    }
  }

  /** This device's newest answer to a request, or undefined. */
  async latest(key: string): Promise<StoredResponse | undefined> {
    const l = (await this.own()).latest.get(key);
    return l ? this.body(l) : undefined;
  }

  private async body(l: Line, device = this.device()): Promise<StoredResponse | undefined> {
    try {
      return { at: l.at, text: await this.adapter.read(this.blobPath(l.h, device)), contentType: l.ct };
    } catch {
      return undefined;
    }
  }

  /** Keeps an answer as it came. Too big, it's skipped; never throws: the history is a convenience. */
  record(key: string, text: string, contentType: string): Promise<void> {
    const at = this.now();
    return this.serial(async () => {
      const n = new TextEncoder().encode(text).length;
      if (n > MAX_BODY_BYTES) return;
      const own = await this.own();
      const h = await sha256(text);
      const f = this.folder();
      const line: Line = { k: key, at, h, ct: contentType, n };
      if (!own.blobs.has(h)) {
        await this.mkdirs(`${f}/blobs`);
        await this.adapter.write(this.blobPath(h), text);
        own.blobs.set(h, n);
      }
      own.latest.set(key, line);
      await this.adapter.write(`${f}/latest.json`, JSON.stringify({ latest: Object.fromEntries(own.latest) }));
      const last = own.last.get(key);
      if (!last || last.h !== h || at - last.at >= STILL_EVERY_MS) {
        await this.adapter.append(`${f}/index.jsonl`, `${JSON.stringify(line)}\n`);
        own.lines.push(line);
        own.last.set(key, line);
        this.all = undefined;
        if (++own.added >= PRUNE_EVERY) await this.prune(own);
      }
    }).catch(() => {});
  }

  /** Drops lines past 90 days, then the oldest past 200 MB, and the blobs nothing names any more. */
  private async prune(own: Own): Promise<void> {
    own.added = 0;
    const from = this.now() - KEEP_MS;
    const before = own.lines.length;
    own.lines = own.lines.filter((l) => l.at >= from).sort((a, b) => a.at - b.at);
    for (const [k, l] of own.latest) if (l.at < from) own.latest.delete(k);
    const refs = new Map<string, number>();
    for (const l of own.lines) refs.set(l.h, (refs.get(l.h) ?? 0) + 1);
    const pinned = new Set([...own.latest.values()].map((l) => l.h));
    const sizeOf = (h: string) => own.blobs.get(h) ?? 0;
    let total = [...new Set([...refs.keys(), ...pinned])].reduce((s, h) => s + sizeOf(h), 0);
    let cut = 0;
    while (total > MAX_DEVICE_BYTES && cut < own.lines.length) {
      const l = own.lines[cut++];
      const left = refs.get(l.h)! - 1;
      refs.set(l.h, left);
      if (left === 0 && !pinned.has(l.h)) total -= sizeOf(l.h);
    }
    own.lines = own.lines.slice(cut);
    const kept = new Set([...own.lines.map((l) => l.h), ...pinned]);
    const gone = [...own.blobs.keys()].filter((h) => !kept.has(h));
    if (own.lines.length === before && !gone.length) return;
    for (const h of gone) {
      own.blobs.delete(h);
      await this.adapter.remove(this.blobPath(h)).catch(() => {});
    }
    own.last = new Map(own.lines.map((l) => [l.k, l]));
    const f = this.folder();
    await this.adapter.write(`${f}/index.jsonl`, own.lines.map((l) => `${JSON.stringify(l)}\n`).join("")).catch(() => {});
    await this.adapter.write(`${f}/latest.json`, JSON.stringify({ latest: Object.fromEntries(own.latest) })).catch(() => {});
    this.all = undefined;
  }

  /** Every device's lines, by key, oldest first. */
  private every(): Promise<Map<string, (Line & { d: string })[]>> {
    this.all ??= (async () => {
      const out = new Map<string, (Line & { d: string })[]>();
      const folders = await this.adapter.list(this.dir).then((l) => l.folders, () => [] as string[]);
      for (const folder of folders) {
        const d = folder.slice(folder.lastIndexOf("/") + 1);
        const lines = await this.adapter.read(`${folder}/index.jsonl`).then(readLines, () => []);
        for (const l of lines) out.set(l.k, [...(out.get(l.k) ?? []), { ...l, d }]);
      }
      for (const lines of out.values()) lines.sort((a, b) => a.at - b.at || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      return out;
    })();
    return this.all;
  }

  /** The answer a request had at time `t`, from any device: the newest kept at or before it. */
  async at(key: string, t: number): Promise<StoredResponse | undefined> {
    const lines = (await this.every()).get(key) ?? [];
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].at <= t) lo = mid + 1;
      else hi = mid;
    }
    const l = lines[lo - 1];
    return l ? this.body(l, l.d) : undefined;
  }

  /** When a request's answer was kept, by any device, oldest first. */
  async times(key: string): Promise<number[]> {
    return ((await this.every()).get(key) ?? []).map((l) => l.at);
  }

  /** Reads every device's lines again next time: another device's history changed. */
  changed(): void {
    this.all = undefined;
  }
}

/** `as of 3 hours ago`: how old a kept answer is. */
export function asOfText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 1440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  if (minutes < 1) return "as of just now";
  return `as of ${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
