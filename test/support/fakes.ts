import { noteText, withLine } from "../../src/actions.ts";
import { ActivityLog, type UndoIO } from "../../src/activity.ts";
import type { AppEnv } from "../../src/app.ts";
import { Background } from "../../src/background.ts";
import { DiskCache, type CacheAdapter } from "../../src/cache.ts";
import { DataLayer, type FileInfo, type Host } from "../../src/datalayer.ts";
import { isAllowed } from "../../src/grants.ts";
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
  /** Files that aren't notes (a .base, say): path → text. */
  const others = new Map<string, string>();
  const requests: string[] = [];
  /** Every request with what was sent besides the URL. */
  const calls: { url: string; headers: Record<string, string>; method: string; body?: string }[] = [];
  let queued: (() => void)[] = [];
  let clock = 1_000_000;
  const kept = disk ?? memoryAdapter(() => clock);
  const cache = new DiskCache(kept.adapter, "plugin/cache");
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
    // A fake note keeps its frontmatter apart, so its text is its body and lines count from there.
    readFile: async (path) => {
      const entry = files.get(path);
      const text = entry && isNote(path) ? entry.body ?? "" : entry?.raw ?? others.get(path);
      if (text === undefined) throw new Error(`Can't find ${path}`);
      return text;
    },
    resolveFile: (link) => [...files.keys(), ...others.keys()].find((p) => p === link || p.endsWith(`/${link}`) || p === `${link}.md`),
    parseYaml,
    cacheRead: (key) => cache.read(key),
    cacheWrite: (key, entry) => cache.write(key, entry),
  };
  return {
    host,
    secrets,
    files,
    others,
    requests,
    calls,
    disk: kept,
    advance: (ms: number) => { clock += ms; },
    flush: () => { const q = queued; queued = []; q.forEach((cb) => cb()); return q.length; },
  };
}

/**
 * An AppEnv on a fake vault with every permission granted; what the app stores as granted (an app
 * opened in its own tab leaves an entry) is kept in `grants`. Writes change the vault the way
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
  const grants: Record<string, string[]> = {};
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
    granted: (path) => (Object.hasOwn(grants, path) ? [...grants[path]] : undefined),
    grant: async (path, wanted) => { grants[path] = [...wanted]; },
    storePath: (store) => `${storeTarget(store)}.md`,
    writeFrontmatter: async (path, fn) => {
      writes.push(path);
      const note = f.files.get(path) ?? {};
      note.fm ??= {};
      fn(note.fm);
      f.files.set(path, note);
      changed(path);
    },
    updateFrontmatter: async (path, fn) => {
      const note = f.files.get(path);
      if (!note) return false;
      writes.push(path);
      note.fm ??= {};
      fn(note.fm);
      changed(path);
      return true;
    },
    // As Obsidian's: the line goes at the end of the note's text, which it creates when there's none.
    appendLine: async (path, line) => {
      writes.push(path);
      const note = f.files.get(path);
      const created = !note;
      f.files.set(path, { ...note, body: withLine(note?.body ?? "", line) });
      changed(path);
      return created;
    },
    // As in Obsidian, a new note reaches the data layer through the metadata cache's change event.
    createNote: async (path, fm, body) => {
      if (f.files.has(path)) return false;
      writes.push(path);
      f.files.set(path, { fm: structuredClone(fm), body });
      changed(path);
      return noteTextOf(f.files.get(path)!);
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
    log: (entry) => void activity.add(entry),
    now: () => new Date(2026, 10, 18, 12, 0),
  };
  /** The activity log, kept in memory, its clock the env's. */
  const kept = { text: undefined as string | undefined };
  const activity = new ActivityLog({ read: async () => kept.text, write: async (text) => { kept.text = text; } }, () => env.now().getTime());
  /** Undoing on this fake vault, as Obsidian's undo does on the real one. */
  const undoIO: UndoIO = {
    frontmatter: (path) => f.files.get(path)?.fm,
    updateFrontmatter: env.updateFrontmatter,
    setTaskDone: env.setTaskDone,
    processText: async (path, fn) => {
      const note = f.files.get(path);
      if (!note) return false;
      writes.push(path);
      note.body = fn(note.body ?? "");
      changed(path);
      return true;
    },
    trashIf: async (path, unchanged) => {
      const note = f.files.get(path);
      if (!note) return "gone";
      if (!unchanged(noteTextOf(note))) return "changed";
      f.files.delete(path);
      data.fileDeleted(path);
      f.flush();
      return "trashed";
    },
  };
  return { env, f, data, writes, notices, opened, changed, source, copied, grants, activity, undoIO };
}

/** A fake note's whole text, as Obsidian would have written it. */
function noteTextOf(note: { fm?: Record<string, unknown>; body?: string }): string {
  const fm = note.fm && Object.keys(note.fm).length ? JSON.stringify(note.fm) : "";
  return noteText(fm ? `${fm}\n` : "", note.body ?? "");
}

/**
 * The background service on a fake vault (see fakeEnv), with a clock that starts at 2026-11-18
 * 12:00 and moves only with `advance` (the data layer's clock moves with it). Every app is
 * allowed except those in `denied`; with `seen`, only apps whose grants (fakeEnv's `grants`) say
 * they were opened and allowed, as in Obsidian. What it notifies goes to `notices`; the commands
 * and status items it publishes, and the apps it opens, are kept.
 */
export function fakeBackground(notes: Notes = {}, responses: Record<string, unknown> = {}, opts: { seen?: boolean; triggers?: { text: string | undefined } } = {}) {
  const t = fakeEnv(notes, responses);
  let clock = new Date(2026, 10, 18, 12, 0).getTime();
  const now = () => new Date(clock);
  t.env.now = now;
  const denied = new Set<string>();
  /** What alerts with `then` keep across restarts; pass it to a second fakeBackground to restart. */
  const triggers = opts.triggers ?? { text: undefined as string | undefined };
  const out = {
    commands: [] as { id: string; name: string }[],
    status: [] as { appPath: string; text: string; title: string }[],
    apps: [] as string[],
    /** What a link without its key asked the person. */
    asked: [] as { title: string; lines: string[] }[],
    /** What a keyed link asked about where it sends word back, and the links opened out of Obsidian. */
    chose: [] as { title: string; lines: string[] }[],
    opened: [] as string[],
  };
  /** How the person answers a link that asks: Run unless `answer` is false, or whatever `wait` resolves to; `choice` for where word goes back. */
  const ask = { answer: true, wait: undefined as undefined | (() => Promise<boolean>), choice: 1 as number | undefined };
  /** Each shortcut's link key, made in order: k1, k2, … */
  const linkKeys = new Map<string, string>();
  /** Where each shortcut's keyed link may send word back without asking. */
  const destinations = new Map<string, string[]>();
  const bg = new Background({
    data: t.data,
    frontmatter: t.env.frontmatter,
    notes: t.env.notes,
    appPaths: () => [...t.f.files].filter(([, n]) => n.fm?.app !== undefined).map(([path]) => path),
    isGranted: (path, wanted) => !denied.has(path) && (!opts.seen || isAllowed(t.grants, path, wanted, true)),
    storePath: t.env.storePath,
    actionDeps: (appPath, dataPath, actor) => ({
      now, dataPath, appPath,
      writeFrontmatter: t.env.writeFrontmatter,
      appendLine: t.env.appendLine,
      createNote: t.env.createNote,
      readBody: t.env.readBody,
      notify: t.env.notify,
      openNote: t.env.openNote,
      log: actor ? (what, changes) => void t.activity.add({ app: appPath, actor, what, changes }) : undefined,
    }),
    now,
    triggers: { read: async () => triggers.text, write: async (text) => { triggers.text = text; } },
    linkKey: (path, shortcut, create) => {
      const id = `${path}#${shortcut}`;
      if (!linkKeys.has(id) && create) linkKeys.set(id, `k${linkKeys.size + 1}`);
      return linkKeys.get(id);
    },
    destinations: (path, shortcut) => destinations.get(`${path}#${shortcut}`) ?? [],
    allowDestination: (path, shortcut, to) => {
      const id = `${path}#${shortcut}`;
      destinations.set(id, [...(destinations.get(id) ?? []), to]);
    },
    logSent: (entry) => void t.activity.add(entry),
    sink: {
      notify: t.env.notify,
      setCommands: (list) => { out.commands = list; },
      setStatus: (items) => { out.status = items; },
      openApp: (path) => { out.apps.push(path); },
      confirm: async (title, lines) => {
        out.asked.push({ title, lines });
        return ask.wait ? ask.wait() : ask.answer;
      },
      choose: async (title, lines) => {
        out.chose.push({ title, lines });
        return ask.choice;
      },
      openUrl: (url) => { out.opened.push(url); },
    },
  });
  return {
    ...t,
    bg,
    denied,
    out,
    ask,
    linkKeys,
    triggers,
    advance: (ms: number) => { clock += ms; t.f.advance(ms); },
  };
}
