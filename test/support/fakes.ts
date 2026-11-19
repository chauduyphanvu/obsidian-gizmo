import type { AppEnv } from "../../src/app.ts";
import { Background } from "../../src/background.ts";
import { DiskCache, type CacheAdapter } from "../../src/cache.ts";
import { DataLayer, type FileInfo, type Host } from "../../src/datalayer.ts";
import { storeTarget } from "../../src/store.ts";

type Notes = Record<string, { fm?: Record<string, unknown>; tags?: string[]; body?: string }>;

/** An in-memory folder for the disk cache; files get the fake clock's time as written. */
export function memoryAdapter(now: () => number = () => 0) {
  const files = new Map<string, { text: string; mtime: number }>();
  const folders = new Set<string>();
  const adapter: CacheAdapter = {
    exists: async (path) => folders.has(path) || files.has(path),
    mkdir: async (path) => { folders.add(path); },
    list: async (path) => ({ files: [...files.keys()].filter((p) => p.startsWith(`${path}/`)), folders: [] }),
    stat: async (path) => {
      const file = files.get(path);
      return file ? { mtime: file.mtime, size: file.text.length } : null;
    },
    read: async (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`no file ${path}`);
      return file.text;
    },
    write: async (path, text) => { files.set(path, { text, mtime: now() }); },
    remove: async (path) => { files.delete(path); },
  };
  return { adapter, files, folders };
}

/**
 * An in-memory vault and network. `flush()` delivers batched change notifications. Web responses
 * are kept in `disk` (pass one in to start "after a restart" with what an earlier run kept).
 */
export function fakeHost(notes: Notes = {}, disk?: ReturnType<typeof memoryAdapter>) {
  const files = new Map(Object.entries(notes));
  const requests: string[] = [];
  let queued: (() => void)[] = [];
  let clock = 1_000_000;
  const kept = disk ?? memoryAdapter(() => clock);
  const cache = new DiskCache(kept.adapter, "plugin/cache");
  const secrets: Record<string, string> = { demo: "s3cret" };
  const info = (path: string): FileInfo => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, ""), mtime: 0, ctime: 0 });
  const host: Host = {
    async fetch(url) {
      requests.push(url);
      await new Promise((r) => setTimeout(r, 5));
      if (url.includes("/never")) return new Promise(() => {});
      if (url.includes("/fail")) return { status: 503, text: "", contentType: "" };
      return { status: 200, text: JSON.stringify({ current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } }), contentType: "application/json" };
    },
    markdownFiles: () => [...files.keys()].map(info),
    fileInfo: (path) => (files.has(path) ? info(path) : undefined),
    frontmatter: (path) => files.get(path)?.fm,
    tags: (path) => files.get(path)?.tags ?? [],
    secret: (id) => secrets[id] ?? null,
    now: () => clock,
    schedule: (cb) => { queued.push(cb); },
    cacheRead: (key) => cache.read(key),
    cacheWrite: (key, entry) => cache.write(key, entry),
  };
  return {
    host,
    files,
    requests,
    disk: kept,
    advance: (ms: number) => { clock += ms; },
    flush: () => { const q = queued; queued = []; q.forEach((cb) => cb()); return q.length; },
  };
}

/**
 * An AppEnv on a fake vault with every permission granted. Writes change the vault the way
 * Obsidian would and deliver the change; what the app writes, notifies and opens is recorded.
 * `responses` answers web requests by the start of their URL.
 */
export function fakeEnv(notes: Notes = {}, responses: Record<string, unknown> = {}) {
  const f = fakeHost(notes);
  const fetch = f.host.fetch;
  f.host.fetch = async (url, headers) => {
    const hit = Object.keys(responses).find((prefix) => url.startsWith(prefix));
    if (hit === undefined) return fetch(url, headers);
    f.requests.push(url);
    await new Promise((r) => setTimeout(r, 5));
    return { status: 200, text: JSON.stringify(responses[hit]), contentType: "application/json" };
  };
  const data = new DataLayer(f.host);
  const writes: string[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const changed = (path: string) => {
    data.fileChanged(path);
    f.flush();
  };
  const resolve = (link: string) => [...f.files.keys()].find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`));
  const env: AppEnv = {
    data,
    frontmatter: (path) => f.files.get(path)?.fm,
    notes: { resolve, frontmatter: (path) => f.files.get(path)?.fm },
    isGranted: () => true,
    granted: () => [],
    grant: async () => {},
    storePath: (store) => `${storeTarget(store)}.md`,
    writeFrontmatter: async (path, fn) => {
      writes.push(path);
      const note = f.files.get(path) ?? {};
      note.fm ??= {};
      fn(note.fm);
      f.files.set(path, note);
      changed(path);
    },
    appendLine: async (path) => { writes.push(path); },
    // As in Obsidian, a new note reaches the data layer through the metadata cache's change event.
    createNote: async (path, fm, body) => {
      if (f.files.has(path)) return false;
      writes.push(path);
      f.files.set(path, { fm: structuredClone(fm), body });
      changed(path);
      return true;
    },
    readBody: async (link) => {
      const path = resolve(storeTarget(link));
      if (!path) throw new Error(`can't find [[${storeTarget(link)}]]`);
      return f.files.get(path)?.body ?? "";
    },
    notify: (m) => { notices.push(m); },
    openNote: (path) => { opened.push(path); },
    showSource: () => {},
    now: () => new Date(2026, 10, 18, 12, 0),
  };
  return { env, f, data, writes, notices, opened, changed };
}

/**
 * The background service on a fake vault (see fakeEnv), with a clock that starts at 2026-11-18
 * 12:00 and moves only with `advance` (the data layer's clock moves with it). Every app is
 * allowed except those in `denied`. What it notifies goes to `notices`; the commands and status
 * items it publishes, and the apps it opens, are kept.
 */
export function fakeBackground(notes: Notes = {}, responses: Record<string, unknown> = {}) {
  const t = fakeEnv(notes, responses);
  let clock = new Date(2026, 10, 18, 12, 0).getTime();
  const now = () => new Date(clock);
  t.env.now = now;
  const denied = new Set<string>();
  const out = {
    commands: [] as { id: string; name: string }[],
    status: [] as { appPath: string; text: string; title: string }[],
    apps: [] as string[],
  };
  const bg = new Background({
    data: t.data,
    frontmatter: t.env.frontmatter,
    notes: t.env.notes,
    appPaths: () => [...t.f.files].filter(([, n]) => n.fm?.app !== undefined).map(([path]) => path),
    isGranted: (path) => !denied.has(path),
    storePath: t.env.storePath,
    actionDeps: (appPath, dataPath) => ({
      now, dataPath, appPath,
      writeFrontmatter: t.env.writeFrontmatter,
      appendLine: t.env.appendLine,
      createNote: t.env.createNote,
      readBody: t.env.readBody,
      notify: t.env.notify,
      openNote: t.env.openNote,
    }),
    now,
    sink: {
      notify: t.env.notify,
      setCommands: (list) => { out.commands = list; },
      setStatus: (items) => { out.status = items; },
      openApp: (path) => { out.apps.push(path); },
    },
  });
  return {
    ...t,
    bg,
    denied,
    out,
    advance: (ms: number) => { clock += ms; t.f.advance(ms); },
  };
}
