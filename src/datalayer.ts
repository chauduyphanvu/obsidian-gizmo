import { filterRows, getPath, parseBody, sortRows, stampParts, type Row } from "./data.ts";
import { isUrl, type Panel } from "./spec.ts";
import { resolveList } from "./store.ts";

export interface FileInfo {
  path: string;
  basename: string;
  mtime: number;
  ctime: number;
}

/** What the data layer needs from Obsidian; tests pass a fake. */
export interface Host {
  fetch(url: string, headers: Record<string, string>): Promise<{ status: number; text: string; contentType: string }>;
  markdownFiles(): FileInfo[];
  fileInfo(path: string): FileInfo | undefined;
  frontmatter(path: string): Record<string, unknown> | undefined;
  tags(path: string): string[];
  secret(id: string): string | null;
  now(): number;
  /** Runs cb once, soon; used to batch change notifications. */
  schedule(cb: () => void): void;
}

/** The notes an app is about: its own note and its data note. */
export interface AppFiles {
  appPath: string;
  dataPath: string;
}

const SECRET = /\{secret:([a-z0-9-]+)\}/g;

function hostOf(source: string): string {
  try {
    return new URL(source.replace(SECRET, "x")).host;
  } catch {
    return source;
  }
}

/**
 * One per plugin, shared by every open app. Web responses are cached by URL (in-flight requests
 * are shared, so three panels on one URL make one request); notes are indexed once and kept
 * current from vault events; listeners hear about changes in batches.
 */
export class DataLayer {
  private http = new Map<string, { at: number; promise: Promise<unknown> }>();
  private index: Map<string, Row> | undefined;
  private queries = new Map<string, Row[]>();
  private listeners = new Set<{ deps: Set<string>; cb: (changed: Set<string>) => void }>();
  private pending = new Set<string>();
  private flushQueued = false;

  private host: Host;

  constructor(host: Host) {
    this.host = host;
  }

  // ---- Panel data ---------------------------------------------------------------------------

  /** The dependency keys a panel's data comes from, so its app knows when to update it. */
  depsOf(source: string | undefined, p: Panel, files: AppFiles): string[] {
    if (!source) return [];
    if (isUrl(source)) return [`url:${source}`];
    if (source === "notes") return [`notes:${p.from ?? ""}`];
    return [`file:${files.dataPath}`, `file:${files.appPath}`];
  }

  async panelData(
    source: string | undefined,
    p: Panel,
    files: AppFiles,
    opts: { ttlMs: number; force?: boolean; now: Date },
  ): Promise<unknown> {
    if (!source) return undefined;
    let data: unknown;
    if (isUrl(source)) data = await this.fetch(source, p.headers, opts.ttlMs, opts.force);
    else if (source === "notes") data = this.notes(p.from ?? "");
    else data = resolveList(source, this.host.frontmatter(files.dataPath), this.host.frontmatter(files.appPath) ?? {});
    data = getPath(data, p.pick);
    if (Array.isArray(data)) {
      data = filterRows(data, p.where, opts.now);
      data = sortRows(data as unknown[], p.sort);
      if (p.limit) data = (data as unknown[]).slice(0, p.limit);
    }
    return data;
  }

  // ---- Web ----------------------------------------------------------------------------------

  fetch(source: string, headers: Record<string, string> | undefined, ttlMs: number, force = false): Promise<unknown> {
    // The key holds the {secret:id} placeholders, never the secrets themselves.
    const key = `${source}|${JSON.stringify(headers ?? {})}`;
    const hit = this.http.get(key);
    if (!force && hit && this.host.now() - hit.at < ttlMs) return hit.promise;
    const promise = (async () => {
      const filled = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, this.withSecrets(String(v))]));
      const res = await this.host.fetch(this.withSecrets(source), filled);
      if (res.status >= 400) throw new Error(`${hostOf(source)} answered ${res.status}`);
      return parseBody(res.text, res.contentType);
    })();
    this.http.set(key, { at: this.host.now(), promise });
    // A failure isn't cached: the next render tries again.
    promise.catch(() => { if (this.http.get(key)?.promise === promise) this.http.delete(key); });
    return promise;
  }

  private withSecrets(text: string): string {
    return text.replace(SECRET, (_, id: string) => {
      const value = this.host.secret(id);
      if (!value) throw new Error(`Missing secret "${id}". Add it under Settings → Keychain.`);
      return value;
    });
  }

  // ---- Notes --------------------------------------------------------------------------------

  /** Notes in any of the comma-separated scopes (a #tag, which includes its sub-tags, or a folder). */
  notes(from: string): Row[] {
    const key = from.trim();
    const cached = this.queries.get(key);
    if (cached) return cached;
    const scopes = splitScopes(key);
    const rows = [...this.rows().values()].filter((r) => inScopes(r, scopes));
    this.queries.set(key, rows);
    return rows;
  }

  private rows(): Map<string, Row> {
    if (!this.index) {
      this.index = new Map();
      for (const f of this.host.markdownFiles()) this.index.set(f.path, this.row(f));
    }
    return this.index;
  }

  private row(f: FileInfo): Row {
    return {
      ...(this.host.frontmatter(f.path) ?? {}),
      name: f.basename,
      path: f.path,
      tags: this.host.tags(f.path),
      mtime: stampParts(new Date(f.mtime)).at,
      ctime: stampParts(new Date(f.ctime)).at,
    };
  }

  // ---- Changes ------------------------------------------------------------------------------

  fileChanged(path: string): void {
    const before = this.index?.get(path);
    const info = this.host.fileInfo(path);
    if (this.index && info) this.index.set(path, this.row(info));
    this.touch(path, before, this.index?.get(path));
  }

  fileDeleted(path: string): void {
    const before = this.index?.get(path);
    this.index?.delete(path);
    this.touch(path, before, undefined);
  }

  fileRenamed(path: string, oldPath: string): void {
    this.fileDeleted(oldPath);
    this.fileChanged(path);
  }

  /** Drops cached web responses so the next load refetches them. */
  forgetUrls(sources: string[]): void {
    for (const key of [...this.http.keys()]) {
      if (sources.some((s) => key.startsWith(`${s}|`))) this.http.delete(key);
    }
    for (const s of sources) this.pending.add(`url:${s}`);
    this.queueFlush();
  }

  private touch(path: string, before: Row | undefined, after: Row | undefined): void {
    this.pending.add(`file:${path}`);
    for (const [key] of this.queries) {
      const scopes = splitScopes(key);
      if ((before && inScopes(before, scopes)) || (after && inScopes(after, scopes))) {
        this.queries.delete(key);
        this.pending.add(`notes:${key}`);
      }
    }
    // A scope nobody has queried yet still matters to listeners waiting on it.
    for (const l of this.listeners) {
      for (const dep of l.deps) {
        if (!dep.startsWith("notes:") || this.pending.has(dep)) continue;
        const scopes = splitScopes(dep.slice(6));
        if ((before && inScopes(before, scopes)) || (after && inScopes(after, scopes))) this.pending.add(dep);
      }
    }
    this.queueFlush();
  }

  subscribe(deps: Iterable<string>, cb: (changed: Set<string>) => void): () => void {
    const entry = { deps: new Set(deps), cb };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.host.schedule(() => {
      this.flushQueued = false;
      const changed = this.pending;
      this.pending = new Set();
      for (const l of [...this.listeners]) {
        const hit = new Set([...l.deps].filter((d) => changed.has(d)));
        if (hit.size) l.cb(hit);
      }
    });
  }
}

function splitScopes(from: string): string[] {
  return from.split(",").map((s) => s.trim()).filter(Boolean);
}

function inScopes(row: Row, scopes: string[]): boolean {
  const path = String(row.path);
  const tags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
  return scopes.some((s) => s.startsWith("#")
    ? tags.some((t) => t === s || t.startsWith(`${s}/`))
    : path.startsWith(`${s.replace(/\/+$/, "")}/`));
}
