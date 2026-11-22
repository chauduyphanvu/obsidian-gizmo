import { noteText, withLine } from "../../src/actions.ts";
import { ActivityLog, type UndoIO } from "../../src/activity.ts";
import type { AppEnv } from "../../src/app.ts";
import { Background, type AlertNotice, type PausedApp } from "../../src/background.ts";
import type { WriterRecord } from "../../src/background-share.ts";
import { writersOf } from "../../src/stored.ts";
import { ResponseHistory, type FolderAdapter } from "../../src/responses.ts";
import { DataLayer, type FileInfo, type Host } from "../../src/datalayer.ts";
import { isAllowed, isAllowedUnder } from "../../src/grants.ts";
import { ledgerStore, type DataStore } from "../../src/datastore.ts";
import { policyHash, type Policy } from "../../src/policy.ts";
import { tickLine } from "../../src/sources/tasks.ts";
import { isKindLink } from "../../src/sources/kind.ts";
import type { Panel } from "../../src/spec.ts";
import { defaultDataPath, isKind, storeTarget } from "../../src/store.ts";
import { parseYaml } from "./yaml.ts";
import { stampOf, toTime } from "../../src/time.ts";

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

/** An in-memory folder for kept web responses; files get the fake clock's time as written. */
export function memoryAdapter(now: () => number = () => 0) {
  const files = new Map<string, { text: string; mtime: number }>();
  const folders = new Set<string>();
  /** What's directly in `path`: files, and folders made or holding files. */
  const under = (path: string, paths: Iterable<string>) => [...new Set([...paths].filter((p) => p.startsWith(`${path}/`)).map((p) => `${path}/${p.slice(path.length + 1).split("/")[0]}`))];
  const adapter: FolderAdapter = {
    exists: async (path) => folders.has(path) || files.has(path),
    mkdir: async (path) => { folders.add(path); },
    list: async (path) => {
      const direct = under(path, [...files.keys(), ...folders]);
      return { files: direct.filter((p) => files.has(p)), folders: direct.filter((p) => !files.has(p)) };
    },
    read: async (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`no file ${path}`);
      return file.text;
    },
    write: async (path, text) => { files.set(path, { text, mtime: now() }); },
    append: async (path, text) => { files.set(path, { text: (files.get(path)?.text ?? "") + text, mtime: now() }); },
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
  const responses = new ResponseHistory(kept.adapter, "plugin/responses", () => "d1mac000", () => clock);
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
    responses,
    // Files that aren't notes (an app's ledger) are kept as text in `others`.
    filesIn: (folder) => [...files.keys(), ...others.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")),
    fileSize: (path) => {
      const text = files.get(path)?.raw ?? others.get(path);
      return text === undefined ? undefined : new TextEncoder().encode(text).length;
    },
    append: async (path, text) => {
      const given = files.get(path);
      if (given) given.raw = (given.raw ?? "") + text;
      else others.set(path, (others.get(path) ?? "") + text);
    },
    writeFile: async (path, text) => {
      const given = files.get(path);
      if (given) given.raw = text;
      else others.set(path, text);
    },
    device: () => "d1mac000",
  };
  return {
    host,
    secrets,
    files,
    others,
    requests,
    calls,
    disk: kept,
    responses,
    /** Keeps an answer as if it had been fetched at `at`. */
    keep: (key: string, text: string, at: number, contentType = "application/json") => {
      const was = clock;
      clock = at;
      const done = responses.record(key, text, contentType);
      clock = was;
      return done;
    },
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
  // As Obsidian tells of a file a device appended to, at once here.
  if (data.ledger) data.ledger.onWrite = (path) => changed(path);
  /** The app note's text, which `sourceLines` gives back, and the lines `showSourceAt` was asked for. */
  const source = { lines: [] as string[], shownAt: [] as number[] };
  const copied: string[] = [];
  const grants: Record<string, string[]> = {};
  /** Renames whose rows the person chose to leave as they are, as data.json keeps them. */
  const leftAlone: Record<string, true> = {};
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
    store: (dataPath, appPath) => snapshotting(ledgerStore(data.ledger!, dataPath, () => f.files.get(appPath)?.fm ?? {}), data),
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
    leftAlone: (key) => Object.hasOwn(leftAlone, key),
    leaveAlone: (key) => { leftAlone[key] = true; },
  };
  // This device runs background work, so it writes each data note's snapshot, at once here.
  data.setSnapshots({ isRunner: () => true, delayMs: 0, gapMs: 0, writeNote: (path, fn) => env.writeFrontmatter(path, fn) });
  /** The activity log, kept in memory, its clock the env's. */
  const kept = { text: undefined as string | undefined };
  const activity = new ActivityLog({ read: async () => kept.text, write: async (text) => { kept.text = text; } }, () => env.now().getTime());
  /** Undoing on this fake vault, as Obsidian's undo does on the real one. */
  const undoIO: UndoIO = {
    frontmatter: (path) => f.files.get(path)?.fm,
    updateFrontmatter: env.updateFrontmatter,
    setTaskDone: env.setTaskDone,
    undoEvents: (dataPath, events) => snapshotting(ledgerStore(data.ledger!, dataPath), data).undo(events),
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
  return { env, f, data, writes, notices, opened, changed, source, copied, grants, leftAlone, activity, undoIO };
}

/**
 * A store whose every write is followed by the snapshot it leads to, so a test reads the data note
 * as the device running background work leaves it a few seconds later.
 */
function snapshotting(store: DataStore, data: DataLayer): DataStore {
  const after = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    const r = await fn(...a);
    await data.flushSnapshots();
    return r;
  };
  return {
    dataPath: store.dataPath,
    rows: (list) => store.rows(list),
    add: after(store.add), set: after(store.set), delete: after(store.delete), batch: after(store.batch),
    tick: after(store.tick), untick: after(store.untick), clear: after(store.clear), undo: after(store.undo),
  };
}

/** A data note's properties without the keys the ledger's snapshot adds: its lists, as an app shows them. */
export function listsIn(fm: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return fm && Object.fromEntries(Object.entries(fm).filter(([k]) => !k.startsWith("gizmo-")));
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
/**
 * The stamp a save writes for a local time typed as `2026-11-18T12:00`: that clock with this zone's
 * offset, so tests pass in any zone they run in.
 */
export function savedAt(local: string): string {
  return stampOf(new Date(toTime(local)!));
}

export function fakeBackground(
  notes: Notes = {}, responses: Record<string, unknown> = {}, opts: { seen?: boolean; triggers?: { text: string | undefined }; policy?: Policy } = {},
) {
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
    asked: [] as { title: string; lines: string[]; effects?: string[] }[],
    /** What a keyed link asked about where it sends word back, and the links opened out of Obsidian. */
    chose: [] as { title: string; lines: string[] }[],
    opened: [] as string[],
    /** The apps paused here, as the status bar would show them; and the alerts pushed beyond the notice (gizmod's ntfy). */
    paused: [] as PausedApp[],
    pushed: [] as AlertNotice[],
    /** Renames matched from a delete and a create, and apps gone for good, as told to the env. */
    renamed: [] as [string, string][],
    dropped: [] as string[],
  };
  /** The other devices' `triggers` files, as text, for a device taking over. */
  const others: string[] = [];
  /** How the person answers a link that asks: Run unless `answer` is false, or whatever `wait` resolves to; `choice` for where word goes back. */
  const ask = { answer: true, wait: undefined as undefined | (() => Promise<boolean>), choice: 1 as number | undefined };
  /** Each shortcut's link key, made in order: k1, k2, … */
  const linkKeys = new Map<string, string>();
  /** Where each shortcut's keyed link may send word back without asking. */
  const destinations = new Map<string, string[]>();
  /** Capture links' keys and what each runs without asking: name → `<app path>#<shortcut>`. */
  const captureKeys = new Map<string, Record<string, string>>();
  /** Whether this (fake) device runs background work. */
  const device = { background: true };
  /** The data policy applied, if any; change `rules`, then call `bg.policyChanged()`, as Apply does. */
  const policy = { rules: opts.policy };
  /** Where the person is, as the beats say: the zone rhythms' deadlines are worked out in; this machine's own when undefined. */
  const where = { zone: undefined as string | undefined };
  /** What this vault decided about writers of shared kinds, as data.json keeps it; and this device's share file. */
  const writers: Record<string, WriterRecord> = {};
  const shareState = { text: undefined as string | undefined };
  /** The other devices' share files, as text, for a device taking over. */
  const otherShareStates: string[] = [];
  const bg = new Background({
    data: t.data,
    frontmatter: t.env.frontmatter,
    notes: t.env.notes,
    appPaths: () => [...t.f.files].filter(([, n]) => n.fm?.app !== undefined || isKind(n.fm)).map(([path]) => path),
    isGranted: (path, wanted, asked) => !denied.has(path)
      && (!opts.seen || (asked ? isAllowedUnder(t.grants, path, asked, true) : isAllowed(t.grants, path, wanted, true))),
    granted: (path) => (opts.seen && Object.hasOwn(t.grants, path) ? [...t.grants[path]] : undefined),
    policy: () => (policy.rules ? { hash: policyHash(policy.rules), rules: policy.rules } : undefined),
    storePath: t.env.storePath,
    actionDeps: (appPath, dataPath, actor) => ({
      now, dataPath, appPath,
      store: t.env.store!(dataPath, appPath),
      kindStore: (kindPath) => t.env.store!(defaultDataPath(kindPath), kindPath),
      frontmatter: t.env.frontmatter,
      writeFrontmatter: t.env.writeFrontmatter,
      appendLine: t.env.appendLine,
      createNote: t.env.createNote,
      readBody: t.env.readBody,
      notify: t.env.notify,
      openNote: t.env.openNote,
      log: actor ? (what, changes) => t.activity.add({ app: appPath, actor, what, changes }).then((e) => e?.id) : undefined,
    }),
    now,
    triggers: { read: async () => triggers.text, write: async (text) => { triggers.text = text; } },
    otherTriggers: async () => [...others],
    shareState: { read: async () => shareState.text, write: async (text) => { shareState.text = text; } },
    otherShareStates: async () => [...otherShareStates],
    writers: (kindPath) => writersOf({ writers }, kindPath),
    setWriter: (kindPath, writer, record) => {
      if (record) writers[`${kindPath}\n${writer}`] = record;
      else delete writers[`${kindPath}\n${writer}`];
    },
    renamed: (from, to) => { out.renamed.push([from, to]); },
    dropped: (path) => { out.dropped.push(path); },
    linkKey: (path, shortcut, create) => {
      const id = `${path}#${shortcut}`;
      if (!linkKeys.has(id) && create) linkKeys.set(id, `k${linkKeys.size + 1}`);
      return linkKeys.get(id);
    },
    captureKey: (key) => captureKeys.get(key),
    destinations: (path, shortcut) => destinations.get(`${path}#${shortcut}`) ?? [],
    allowDestination: (path, shortcut, to) => {
      const id = `${path}#${shortcut}`;
      destinations.set(id, [...(destinations.get(id) ?? []), to]);
    },
    logSent: (entry) => void t.activity.add(entry),
    runsBackground: () => device.background,
    zone: () => where.zone,
    sink: {
      notify: t.env.notify,
      setCommands: (list) => { out.commands = list; },
      setStatus: (items) => { out.status = items; },
      openApp: (path) => { out.apps.push(path); },
      confirm: async (title, lines, effects) => {
        out.asked.push(effects ? { title, lines, effects } : { title, lines });
        return ask.wait ? ask.wait() : ask.answer;
      },
      choose: async (title, lines) => {
        out.chose.push({ title, lines });
        return ask.choice;
      },
      openUrl: (url) => { out.opened.push(url); },
      setPaused: (apps) => { out.paused = apps; },
      alert: (notice) => { out.pushed.push(notice); },
    },
  });
  return {
    ...t,
    bg,
    denied,
    out,
    ask,
    linkKeys,
    captureKeys,
    device,
    policy,
    where,
    triggers,
    others,
    writers,
    shareState,
    otherShareStates,
    advance: (ms: number) => { clock += ms; t.f.advance(ms); },
  };
}

/**
 * What expanding a panel would add for a source that links to a kind, for checking a view's example
 * alone, with no vault to find the kind in: `[[Spend]]` is a kind of that name.
 */
export function kindIn(raw: Record<string, unknown>): Partial<Panel> {
  if (!isKindLink(raw.source)) return {};
  const name = raw.source.trim().slice(2, -2);
  return { kind: { path: `Kinds/${name}.md`, name: name.toLowerCase() } };
}
