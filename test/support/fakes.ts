import type { AppEnv } from "../../src/app.ts";
import { DataLayer, type FileInfo, type Host } from "../../src/datalayer.ts";
import { storeTarget } from "../../src/store.ts";

/** A file in the fake vault: a note (frontmatter, tags, body) or any other file (its text in `raw`). */
type Notes = Record<string, { fm?: Record<string, unknown>; tags?: string[]; body?: string; raw?: string }>;

/** An in-memory vault and network. `flush()` delivers batched change notifications. */
export function fakeHost(notes: Notes = {}) {
  const files = new Map(Object.entries(notes));
  const requests: string[] = [];
  /** Every request with what was sent besides the URL. */
  const calls: { url: string; headers: Record<string, string>; method: string; body?: string }[] = [];
  let queued: (() => void)[] = [];
  let clock = 1_000_000;
  const secrets: Record<string, string> = { demo: "s3cret" };
  const isNote = (path: string) => path.endsWith(".md");
  const info = (path: string): FileInfo => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, ""), mtime: 0, ctime: 0 });
  const host: Host = {
    async fetch(url, headers, init) {
      requests.push(url);
      calls.push({ url, headers, method: init?.method ?? "GET", body: init?.body });
      await new Promise((r) => setTimeout(r, 5));
      if (url.includes("/never")) return new Promise(() => {});
      if (url.includes("/fail")) return { status: 503, text: "", contentType: "" };
      return { status: 200, text: JSON.stringify({ current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } }), contentType: "application/json" };
    },
    markdownFiles: () => [...files.keys()].filter(isNote).map(info),
    fileInfo: (path) => (files.has(path) && isNote(path) ? info(path) : undefined),
    frontmatter: (path) => files.get(path)?.fm,
    tags: (path) => files.get(path)?.tags ?? [],
    secret: (id) => secrets[id] ?? null,
    now: () => clock,
    schedule: (cb) => { queued.push(cb); },
    readFile: async (path) => {
      const raw = files.get(path)?.raw;
      if (raw === undefined) throw new Error(`Can't find ${path}`);
      return raw;
    },
    resolveFile: (link) => [...files.keys()].find((p) => p === link || p.endsWith(`/${link}`)),
  };
  return {
    host,
    secrets,
    files,
    requests,
    calls,
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
  f.host.fetch = async (url, headers, init) => {
    const hit = Object.keys(responses).find((prefix) => url.startsWith(prefix));
    if (hit === undefined) return fetch(url, headers, init);
    f.requests.push(url);
    f.calls.push({ url, headers, method: init?.method ?? "GET", body: init?.body });
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
