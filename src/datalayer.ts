import { Ledger } from "./ledger-store.ts";
import type { ResponseHistory } from "./responses.ts";
import { SnapshotWriter, type Snapshots } from "./snapshots.ts";
import { parseBody, type Row } from "./data.ts";
import { stampParts } from "./time.ts";
import { fileDep, nameDep, notesDep, scopeOfDep, urlDep } from "./deps.ts";
import { compilePipeline } from "./pipeline.ts";
import { sourceDef } from "./sources/registry.ts";
import type { LoadOpts } from "./sources/types.ts";
import type { Panel } from "./spec.ts";
import { basename } from "./store.ts";
import { secretIds, stringsIn } from "./template.ts";

export interface FileInfo {
  path: string;
  basename: string;
  mtime: number;
  ctime: number;
}

/** What the data layer needs from Obsidian; tests pass a fake. */
export interface Host {
  /**
   * Resolves with any answer, an error status included. When no answer came it rejects with a
   * WebError of kind "network"; anything else it throws (a try refusing a host) is passed on as it is.
   */
  fetch(url: string, headers: Record<string, string>, init?: { method?: string; body?: string }): Promise<{ status: number; text: string; contentType: string }>;
  markdownFiles(): FileInfo[];
  fileInfo(path: string): FileInfo | undefined;
  frontmatter(path: string): Record<string, unknown> | undefined;
  tags(path: string): string[];
  secret(id: string): string | null;
  now(): number;
  /** Runs cb once, soon; used to batch change notifications. */
  schedule(cb: () => void): void;
  /** The whole text of any file in the vault (a note's frontmatter included); rejects with `Can't find <path>` when there is none. */
  readFile(path: string): Promise<string>;
  /** The vault path a link or file name points at from the note at `from`, or undefined when no file matches. */
  resolveFile(link: string, from: string): string | undefined;
  /** YAML text as data; throws when it isn't YAML. */
  parseYaml(text: string): unknown;
  /** Web responses as they came, kept on this device: the newest for a restart or no network, and the past for replay. */
  responses?: Pick<ResponseHistory, "latest" | "record" | "at" | "times" | "changed">;
  /** The files directly in a folder, of any kind: with append and writeFile, what an app's ledger is kept in. */
  filesIn?: (folder: string) => string[];
  /** Adds text at the end of a file, making it and its folders when there's none. */
  append?: (path: string, text: string) => Promise<void>;
  /** Writes a whole file, making it and its folders when there's none. */
  writeFile?: (path: string, text: string) => Promise<void>;
  /** A file's size in bytes, known without reading it: a log a checkpoint holds all of is then left unread. */
  fileSize?: (path: string) => number | undefined;
  /** This device's id, which its ledger files are named for. */
  device?(): string;
}

/** The notes an app is about: its own note and its data note. */
export interface AppFiles {
  appPath: string;
  dataPath: string;
  /** The note it sits in (`$this`, `source: this`) when that isn't its own: an embed's or a lens's note. */
  hostPath?: string;
  /** With `devices: split`, the folder of device notes from before the ledger, read in as the app's rows. */
  devices?: string;
}

/** A note as a row: its properties, then its name, path, tags and file times (which win over properties of those names). */
export function noteRow(f: FileInfo, frontmatter: Record<string, unknown> | undefined, tags: string[]): Row {
  return {
    ...(frontmatter ?? {}),
    name: f.basename,
    path: f.path,
    tags,
    mtime: stampParts(new Date(f.mtime)).at,
    ctime: stampParts(new Date(f.ctime)).at,
  };
}

const SECRET = /\{secret:([a-z0-9-]+)\}/g;

/** A web response longer than this isn't read: no app's data is that big, and reading it would stall the window. */
export const MAX_RESPONSE_CHARS = 10_000_000;

/**
 * A web request that failed where the failure is known: no answer came (the host says so, see
 * Host.fetch), the site answered with an error status, or its answer looked like JSON and isn't.
 * Its message is the failure's own; `kind`, `host` and `status` let a panel say it in plain words.
 */
export class WebError extends Error {
  readonly kind: "network" | "status" | "not-json";
  readonly host: string;
  readonly status?: number;

  constructor(kind: WebError["kind"], host: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.kind = kind;
    this.host = host;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

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
  private parsedFiles = new Map<string, Promise<unknown>>();
  /** What each parse made of a note's text, by note path; dropped when the note changes. */
  private parsed = new Map<string, Map<unknown, Promise<unknown>>>();
  /** What `kept` made, by key, with the files it was made from; dropped when one of them changes. */
  private made = new Map<string, { paths: string[]; value: unknown }>();

  /** What sources read the vault through. */
  readonly host: Host;
  /** Every app's lists as events, when the host can keep files of any kind. */
  readonly ledger: Ledger | undefined;
  private snapshotWriter: SnapshotWriter;

  /**
   * The vault as it was at this time (ms), for replay: lists from the ledger's events up to it and web
   * answers from the response history at or before it. Notes are read as they are now (a synced
   * note's ctime is when it arrived here, not when it was made). Nothing is written.
   */
  at: number | undefined;

  /**
   * A what-if at this time still to come (ms): lists are the live ones with the what-if's own rows
   * (see Ledger's `branch`), web answers the latest kept, and notes as they are now.
   */
  ahead: number | undefined;

  /** What the apps ask of the person now, as `source: asks` reads it; set by the background while it runs. */
  asks: (() => Row[]) | undefined;

  /** Layers told of every change this one hears (see follow). */
  private followers = new Set<DataLayer>();

  /** `like`: the live layer a replay or a what-if folds recorded lists as; `ahead`: a what-if's name, for its branch, and its time. */
  constructor(host: Host, opts: { at?: number; like?: DataLayer; ahead?: { name: string; at: number } } = {}) {
    this.host = host;
    this.at = opts.at;
    this.ahead = opts.ahead?.at;
    const { filesIn, append, writeFile, fileSize } = host;
    if (filesIn && append && writeFile) {
      this.ledger = new Ledger({
        filesIn: (folder) => filesIn.call(host, folder),
        readFile: (path) => host.readFile(path),
        append: (path, text) => append.call(host, path, text),
        writeFile: (path, text) => writeFile.call(host, path, text),
        frontmatter: (path) => host.frontmatter(path),
        ...(fileSize && { size: (path: string) => fileSize.call(host, path) }),
      }, () => host.device?.() ?? "device", () => host.now(), opts.at, opts.ahead?.name);
      this.ledger.onWrite = (path) => this.fileChanged(path);
      if (opts.like?.ledger) this.ledger.capsFrom(opts.like.ledger);
    }
    this.snapshotWriter = new SnapshotWriter(host, this.ledger, (folder) => this.deviceNotes(folder));
  }

  /** Moves a replay to another time: what it read is read again as of then. */
  setAt(at: number): void {
    if (this.at === undefined) throw new Error("only a replay's time can be moved");
    this.at = at;
    if (this.ledger) this.ledger.until = at;
    this.index = undefined;
    this.queries.clear();
    this.made.clear();
  }

  /** Moves a what-if to another time still to come. */
  setAhead(at: number): void {
    this.ahead = at;
    this.index = undefined;
    this.queries.clear();
    this.made.clear();
  }

  /** Tells `other` of each change to the vault this layer hears, until the function it gives is called. */
  follow(other: DataLayer): () => void {
    this.followers.add(other);
    return () => this.followers.delete(other);
  }

  /** Who writes snapshots, and how; until set, none are written. */
  setSnapshots(s: Snapshots | undefined): void {
    this.snapshotWriter.set(s);
  }

  /** The app note whose lists a data note keeps (for the lists typed in it), and its old device notes' folder. */
  noteApp(dataPath: string, appPath: string, devices?: string): void {
    this.snapshotWriter.noteApp(dataPath, appPath, devices);
  }

  /** The frontmatter of the device notes an app kept under `devices: split`. */
  deviceNotes(folder: string): Record<string, unknown>[] {
    return this.notesIn(folder).filter((path) => typeof this.host.frontmatter(path)?.device === "string").sort().map((path) => this.host.frontmatter(path)!);
  }

  /**
   * Writes a data note's snapshot now, from any device: after Import or Discard, `force` writes it
   * over a hand edit.
   */
  snapshotNow(dataPath: string, force: boolean): Promise<void> {
    return this.snapshotWriter.now(dataPath, force);
  }

  /** Stops waiting snapshots: the plugin is going, and the runner writes them next time. */
  dispose(): void {
    this.snapshotWriter.dispose();
  }

  /** Writes now the snapshots waiting to be written. */
  flushSnapshots(): Promise<void> {
    return this.snapshotWriter.flush();
  }

  // ---- Panel data ---------------------------------------------------------------------------

  /** The dependency keys a panel's data comes from, so its app knows when to update it. */
  depsOf(source: string | undefined, p: Panel, files: AppFiles): string[] {
    if (!source) return [];
    return sourceDef(source).deps(withSource(p, source), files);
  }

  /** What the source returns, before any step of the panel's pipeline. */
  async rawData(source: string | undefined, p: Panel, files: AppFiles, opts: LoadOpts): Promise<unknown> {
    if (!source) return undefined;
    return sourceDef(source).load(withSource(p, source), files, this, opts);
  }

  /** `source` may differ from `p.source`: a checklist reads the list it saves to. */
  async panelData(source: string | undefined, p: Panel, files: AppFiles, opts: LoadOpts): Promise<unknown> {
    if (!source) return undefined;
    return compilePipeline(p, opts.now)(await this.rawData(source, p, files, opts));
  }

  /**
   * A panel's data from the disk copies of the web responses it reads, through its pipeline, and
   * when the oldest of them was fetched. Undefined when it reads none, or one has no copy.
   */
  async cachedPanelData(source: string | undefined, p: Panel, files: AppFiles, now: Date): Promise<{ data: unknown; at: number } | undefined> {
    // The past, and a what-if, have no newer copy to paint first.
    if (!source || this.at !== undefined || this.ahead !== undefined) return undefined;
    let at: number | undefined;
    // The source loads as usual, with each web request answered from disk.
    const offline = Object.create(this) as DataLayer;
    offline.fetch = async (url, headers, _ttlMs, _force, body, secrets = []) => {
      const refused = this.refused(url, headers, body, secrets);
      if (refused) throw refused;
      const copy = await this.cached(url, headers, body);
      if (!copy) throw new Error("no copy");
      at = Math.min(at ?? Infinity, copy.at);
      return copy.data;
    };
    try {
      const data = await sourceDef(source).load(withSource(p, source), files, offline, { ttlMs: 0, now });
      return at === undefined ? undefined : { data: compilePipeline(p, now)(data), at };
    } catch {
      return undefined;
    }
  }

  // ---- Web ----------------------------------------------------------------------------------

  /**
   * With a `body`, the request is a POST; the same URL with another body is another request.
   * `secrets` are the ids its `{secret:id}` placeholders may name, settled from the keys of the
   * panel that asks; a request naming any other is refused before anything is sent or read from
   * the cache, so text a value assembled can't reach a secret.
   */
  fetch(
    source: string, headers: Record<string, string> | undefined, ttlMs: number, force = false,
    body?: string | Record<string, unknown>, secrets: readonly string[] = [], now?: Date,
  ): Promise<unknown> {
    const refused = this.refused(source, headers, body, secrets);
    if (refused) return Promise.reject(refused);
    const at = this.at ?? this.ahead;
    if (at !== undefined) return this.answerAt(source, headers, body, at);
    const key = cacheKey(source, headers, body);
    const hit = this.http.get(key);
    if (!force && hit && this.host.now() - hit.at < ttlMs) return hit.promise;
    const promise = (async () => {
      const filled = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, this.withSecrets(String(v))]));
      const init = body === undefined ? undefined : this.post(body, filled);
      const res = await this.host.fetch(this.withSecrets(source), filled, init);
      const host = hostOf(source);
      if (res.status >= 400) throw new WebError("status", host, `${host} answered ${res.status}`, { status: res.status });
      if (res.text.length > MAX_RESPONSE_CHARS) throw new Error(`${host} sent more than 10 MB`);
      let data: unknown;
      try {
        // Read at the panel's time, which a replay sets; the request itself is made now.
        data = parseBody(res.text, res.contentType, now ?? new Date(this.host.now()));
      } catch (e) {
        // JSON.parse is what throws a SyntaxError here.
        if (e instanceof SyntaxError) throw new WebError("not-json", host, e.message, { cause: e });
        throw e;
      }
      if (keptOnDisk(source, headers, body)) void this.host.responses?.record(key, res.text, res.contentType);
      return data;
    })();
    this.http.set(key, { at: this.host.now(), promise });
    // A failure isn't cached: the next render tries again.
    promise.catch(() => { if (this.http.get(key)?.promise === promise) this.http.delete(key); });
    return promise;
  }

  /** A map is sent as JSON, unless the headers say what it is; text is sent as typed. Secrets are filled into values only, after the map is complete, so they can't break the JSON. */
  private post(body: string | Record<string, unknown>, headers: Record<string, string>): { method: string; body: string } {
    if (typeof body === "string") return { method: "POST", body: this.withSecrets(body) };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    return { method: "POST", body: JSON.stringify(body, (_, v: unknown) => (typeof v === "string" ? this.withSecrets(v) : v)) };
  }

  /** What a request answered at a time, as kept (for a time still to come, the latest kept); never the network. */
  private async answerAt(source: string, headers: Record<string, string> | undefined, body: string | Record<string, unknown> | undefined, at: number): Promise<unknown> {
    if (!keptOnDisk(source, headers, body)) throw new Error(`${hostOf(source)}'s answers aren't kept: the request uses a secret or sends a body`);
    const r = await this.host.responses?.at(cacheKey(source, headers, body), at);
    if (!r) throw new Error(`nothing kept from ${hostOf(source)} by then`);
    return parseBody(r.text, r.contentType, new Date(at));
  }

  /** The disk copy of one web request, parsed as a fresh response is; undefined when there is none. */
  async cached(source: string, headers: Record<string, string> | undefined, body?: string | Record<string, unknown>): Promise<{ data: unknown; at: number } | undefined> {
    if (!keptOnDisk(source, headers, body)) return undefined;
    const entry = await this.host.responses?.latest(cacheKey(source, headers, body));
    if (!entry) return undefined;
    try {
      return { data: parseBody(entry.text, entry.contentType, new Date(this.host.now())), at: entry.at };
    } catch {
      return undefined;
    }
  }

  /** Why a request may not be made: it names a secret it wasn't allowed. Only what withSecrets fills is looked at. */
  private refused(source: string, headers: Record<string, string> | undefined, body: unknown, secrets: readonly string[]): Error | undefined {
    const texts = [source, ...Object.values(headers ?? {}).map(String), ...stringsIn(body)];
    const id = texts.flatMap(secretIds).find((s) => !secrets.includes(s));
    return id === undefined ? undefined : new Error(`This app wasn't allowed the secret "${id}"`);
  }

  private withSecrets(text: string): string {
    return text.replace(SECRET, (_, id: string) => {
      const value = this.host.secret(id);
      if (!value) throw new Error(`Missing secret "${id}". Add it under Settings → Keychain.`);
      return value;
    });
  }

  // ---- Vault files --------------------------------------------------------------------------

  /** A vault file read and parsed once; the next change to the file, or a failed read, drops it. */
  parsedFile(path: string, parse: (text: string) => unknown): Promise<unknown> {
    const hit = this.parsedFiles.get(path);
    if (hit) return hit;
    const promise = this.host.readFile(path).then(parse);
    this.parsedFiles.set(path, promise);
    promise.catch(() => { if (this.parsedFiles.get(path) === promise) this.parsedFiles.delete(path); });
    return promise;
  }

  /**
   * What `make` returns, made once and kept until one of `paths` changes, is deleted or is renamed
   * (a path ending in `/`: any note in that folder, a new one included).
   * For work that reads only those files' frontmatter, which every panel on them would otherwise repeat.
   */
  kept<T>(key: string, paths: string[], make: () => T): T {
    const hit = this.made.get(key);
    if (hit) return hit.value as T;
    const value = make();
    this.made.set(key, { paths, value });
    return value;
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

  /** Whether a note is in any of the comma-separated scopes, as `notes(from)` would list it. */
  inScope(from: string, path: string): boolean {
    const row = this.rows().get(path);
    return !!row && inScopes(row, splitScopes(from));
  }

  /** Every markdown note in the vault. */
  allNotes(): Row[] {
    return [...this.rows().values()];
  }

  /** The paths of the notes directly in a folder, by path alone. */
  notesIn(folder: string): string[] {
    const prefix = `${folder}/`;
    return [...this.rows().keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
  }

  /**
   * What `parse` makes of a note's text. Each note is read and parsed once and kept until it
   * changes, so a scope of many notes re-reads only the ones that changed.
   */
  parseNote<T>(path: string, parse: (text: string) => T): Promise<T> {
    let byParse = this.parsed.get(path);
    if (!byParse) this.parsed.set(path, (byParse = new Map<unknown, Promise<unknown>>()));
    const hit = byParse.get(parse) as Promise<T> | undefined;
    if (hit) return hit;
    const promise = this.host.readFile(path).then(parse);
    byParse.set(parse, promise);
    promise.catch(() => { if (this.parsed.get(path)?.get(parse) === promise) this.parsed.get(path)!.delete(parse); });
    return promise;
  }

  private rows(): Map<string, Row> {
    if (!this.index) {
      this.index = new Map();
      for (const f of this.host.markdownFiles()) this.index.set(f.path, this.row(f));
    }
    return this.index;
  }

  private row(f: FileInfo): Row {
    return noteRow(f, this.host.frontmatter(f.path), this.host.tags(f.path));
  }

  // ---- Changes ------------------------------------------------------------------------------

  fileChanged(path: string): void {
    const dataPath = this.ledger?.fileChanged(path);
    if (dataPath) this.snapshotWriter.soon(dataPath);
    this.parsed.delete(path);
    const before = this.index?.get(path);
    const info = this.host.fileInfo(path);
    if (this.index && info) this.index.set(path, this.row(info));
    this.touch(path, before, this.index?.get(path));
    for (const f of this.followers) f.fileChanged(path);
  }

  fileDeleted(path: string): void {
    this.parsed.delete(path);
    const before = this.index?.get(path);
    this.index?.delete(path);
    this.touch(path, before, undefined);
    for (const f of this.followers) f.fileDeleted(path);
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
    for (const s of sources) this.pending.add(urlDep(s));
    this.queueFlush();
  }

  /** Something no file holds changed (what the apps ask): those listening for `dep` hear it with the next batch. */
  told(dep: string): void {
    this.pending.add(dep);
    this.queueFlush();
  }

  private touch(path: string, before: Row | undefined, after: Row | undefined): void {
    this.pending.add(fileDep(path));
    this.parsedFiles.delete(path);
    // A path ending in a slash stands for every note in that folder, some of which may be new.
    for (const [key, made] of this.made) if (made.paths.some((p) => p === path || (p.endsWith("/") && path.startsWith(p)))) this.made.delete(key);
    // Links resolve by name, so a note appearing, changing or moving under a name reaches its users.
    this.pending.add(nameDep(basename(path)));
    // Heard by whatever reads every note, such as a base.
    if (before || after) this.pending.add(notesDep("*"));
    for (const [key] of this.queries) {
      const scopes = splitScopes(key);
      if ((before && inScopes(before, scopes)) || (after && inScopes(after, scopes))) {
        this.queries.delete(key);
        this.pending.add(notesDep(key));
      }
    }
    // A scope nobody has queried yet still matters to listeners waiting on it.
    for (const l of this.listeners) {
      for (const dep of l.deps) {
        if (dep.startsWith("folder:") && path.startsWith(dep.slice(7))) this.pending.add(dep);
        const scope = scopeOfDep(dep);
        if (scope === undefined || this.pending.has(dep)) continue;
        const scopes = splitScopes(scope);
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

/**
 * Whether a response may be kept on disk: not when the request carries a secret or a body, whose
 * answer may be an account, a balance or a token. The disk copy lives in the plugin's folder in
 * the vault, which syncs and may be committed; the secret itself lives only in the keychain.
 */
function keptOnDisk(source: string, headers: Record<string, string> | undefined, body: unknown): boolean {
  if (body !== undefined) return false;
  return ![source, ...Object.values(headers ?? {}).map(String)].some((text) => secretIds(text).length > 0);
}

/** What a web response is cached under, in memory and on disk: its {secret:id} placeholders, never the secrets. */
export function cacheKey(source: string, headers: Record<string, string> | undefined, body?: string | Record<string, unknown>): string {
  return `${source}|${JSON.stringify(headers ?? {})}${body === undefined ? "" : `|${JSON.stringify(body)}`}`;
}

function withSource(p: Panel, source: string): Panel {
  return p.source === source ? p : { ...p, source };
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
