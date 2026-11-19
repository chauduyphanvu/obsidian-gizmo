import type { AppEnv } from "../../src/app.ts";
import { DataLayer, type FileInfo, type Host } from "../../src/datalayer.ts";
import { tickLine } from "../../src/sources/tasks.ts";
import { storeTarget } from "../../src/store.ts";
import { parseYaml } from "./yaml.ts";

/** A web response sent as written, with its content type. */
class Raw {
  text: string;
  contentType: string;
  constructor(text: string, contentType: string) {
    this.text = text;
    this.contentType = contentType;
  }
}
export const raw = (text: string, contentType: string) => new Raw(text, contentType);

/** A file in the fake vault: a note (frontmatter, tags, body) or any other file (its text in `raw`). */
type Notes = Record<string, { fm?: Record<string, unknown>; tags?: string[]; body?: string; raw?: string }>;

/** An in-memory vault and network. `flush()` delivers batched change notifications. */
export function fakeHost(notes: Notes = {}) {
  const files = new Map(Object.entries(notes));
  /** Files that aren't notes (a .base, say): path → text. */
  const others = new Map<string, string>();
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
    // A fake note keeps its frontmatter apart, so its text is its body and lines count from there.
    async readText(path) {
      const text = files.has(path) ? files.get(path)!.body ?? "" : others.get(path);
      if (text === undefined) throw new Error(`can't find ${path}`);
      return text;
    },
    resolveFile: (link) => [...files.keys(), ...others.keys()].find((p) => p === link || p.endsWith(`/${link}`) || p === `${link}.md`),
    parseYaml,
  };
  return {
    host,
    secrets,
    files,
    others,
    requests,
    calls,
    advance: (ms: number) => { clock += ms; },
    flush: () => { const q = queued; queued = []; q.forEach((cb) => cb()); return q.length; },
  };
}

/**
 * An AppEnv on a fake vault with every permission granted. Writes change the vault the way
 * Obsidian would and deliver the change; what the app writes, notifies and opens is recorded.
 * `responses` answers web requests by the start of their URL: a value is sent as JSON, or as
 * it is when wrapped in `raw(text, contentType)` (a feed, a calendar).
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
    const answer = responses[hit];
    if (answer instanceof Raw) return { status: 200, text: answer.text, contentType: answer.contentType };
    return { status: 200, text: JSON.stringify(answer), contentType: "application/json" };
  };
  const data = new DataLayer(f.host);
  const writes: string[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  /** The app note's text, which `sourceLines` gives back, and the lines `showSourceAt` was asked for. */
  const source = { lines: [] as string[], shownAt: [] as number[] };
  const copied: string[] = [];
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
    setTaskDone: async (path, line, text, done) => {
      const note = f.files.get(path);
      const next = note ? tickLine(note.body ?? "", line, text, done) : undefined;
      if (!note || next === undefined) return false;
      writes.push(path);
      note.body = next;
      changed(path);
      return true;
    },
    notify: (m) => { notices.push(m); },
    openNote: (path) => { opened.push(path); },
    showSource: () => {},
    showSourceAt: (line) => { source.shownAt.push(line); },
    sourceLines: async () => source.lines,
    copy: (text) => { copied.push(text); },
    now: () => new Date(2026, 10, 18, 12, 0),
  };
  return { env, f, data, writes, notices, opened, changed, source, copied };
}
