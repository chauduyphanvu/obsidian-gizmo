/**
 * What gizmod runs the engine with, in place of Obsidian: the vault folder as a Host, writes as an
 * app's actions make them, Gizmo's settings read from its data.json (never written: grants, keys
 * and the policy are given in Obsidian), and the files Gizmo keeps per device in its plugin folder.
 */
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { ActivityLog, type LogStore, type NewEntry } from "../activity.ts";
import { actionDepsOf, bodyOf, noteText, withLine, type ActionDeps, type ActionIO } from "../actions.ts";
import type { Actor } from "../activity.ts";
import type { AlertNotice, BackgroundEnv, BackgroundSink } from "../background.ts";
import { DataLayer, type Host } from "../datalayer.ts";
import { ledgerStore } from "../datastore.ts";
import { BEAT_EVERY_MS, PRIORITY, UNSEEN_MS, readBeat, runnerOf, startsOver, whereYouAre, type Beat } from "../device.ts";
import { localZone } from "../time.ts";
import { grantedOf, isAllowed, isAllowedUnder } from "../grants.ts";
import { clearance, isPolicyPath, rank, type AppliedPolicy } from "../policy.ts";
import { ResponseHistory, type FolderAdapter } from "../responses.ts";
import { isApp, notePath, storeTarget } from "../store.ts";
import { tickLine } from "../sources/tasks.ts";
import { NodeVault, yamlText } from "./vault.ts";

/** Gizmo's settings as Obsidian keeps them in data.json; gizmod only reads them. */
export interface Settings {
  grants: Record<string, string[]>;
  linkKeys?: Record<string, string>;
  answerTo?: Record<string, string[]>;
  captureKeys?: Record<string, Record<string, string>>;
  policy?: AppliedPolicy;
}

/** Node's fs as the history's folder adapter. */
export const fsAdapter: FolderAdapter = {
  exists: async (p) => existsSync(p),
  mkdir: async (p) => { await fs.mkdir(p, { recursive: true }); },
  list: async (p) => {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return { files: entries.filter((e) => e.isFile()).map((e) => join(p, e.name)), folders: entries.filter((e) => e.isDirectory()).map((e) => join(p, e.name)) };
  },
  read: (p) => fs.readFile(p, "utf8"),
  write: async (p, data) => { await fs.mkdir(dirname(p), { recursive: true }); await fs.writeFile(p, data); },
  append: async (p, data) => { await fs.mkdir(dirname(p), { recursive: true }); await fs.appendFile(p, data); },
  remove: (p) => fs.rm(p, { force: true }),
};

/** A file kept whole; reading one that isn't there gives undefined. */
export function fileStore(path: string): LogStore {
  return {
    read: async () => (existsSync(path) ? fs.readFile(path, "utf8") : undefined),
    write: async (text) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text); },
  };
}

/** `{secret:id}` filled from the environment, as `op run` gives it: GIZMO_SECRET_<ID>, dashes as underscores. */
export function secretFromEnv(id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[`GIZMO_SECRET_${id.toUpperCase().replace(/-/g, "_")}`] ?? null;
}

/** What gizmod pushes for an alert: its whole text when the policy clears it for that host, else only where it's from. */
export function pushText(notice: AlertNotice, policy: AppliedPolicy | undefined, host: string): string {
  const where = `${notice.app}: ${notice.panel}`;
  if (!policy || !notice.label) return where;
  const cleared = clearance(policy.rules, host);
  return cleared !== undefined && rank(notice.label) <= rank(cleared) ? notice.text : where;
}

export interface GizmodOptions {
  vault: string;
  configDir?: string;
  /** This gizmod's device id, named in its ledger files and beat. */
  device: string;
  /** Where alerts are pushed: a ntfy topic's URL. */
  ntfyUrl?: string;
  /** Shows alerts as macOS notices too. */
  macNotices?: boolean;
  log?: (line: string) => void;
  now?: () => number;
  fetch?: typeof fetch;
}

/** gizmod's vault, data layer, activity log, beat and the Background's env, put together. */
export function gizmodEnv(opts: GizmodOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  const doFetch = opts.fetch ?? fetch;
  const vault = new NodeVault(opts.vault, opts.configDir);
  const pluginDir = join(opts.vault, opts.configDir ?? ".obsidian", "plugins", "gizmo");
  const id = opts.device;

  let settings: Settings = { grants: {} };
  let settingsMtime = -1;
  /** data.json as Obsidian last wrote it, read again when it changed. */
  const store = (): Settings => {
    const path = join(pluginDir, "data.json");
    try {
      const m = statSync(path).mtimeMs;
      if (m !== settingsMtime) {
        const read = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
        settings = { ...read, grants: read.grants ?? {} };
        // Only once it parsed: a file caught half-written is read again next time.
        settingsMtime = m;
      }
    } catch {
      // No settings yet: nothing is allowed.
    }
    return settings;
  };

  const host: Host = {
    async fetch(url, headers, init) {
      const res = await doFetch(url, { headers, method: init?.method, body: init?.body });
      return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
    },
    markdownFiles: () => vault.notes(),
    fileInfo: (path) => (path.endsWith(".md") ? vault.file(path)?.info : undefined),
    frontmatter: (path) => vault.file(path)?.fm,
    tags: (path) => vault.file(path)?.tags ?? [],
    secret: (sid) => secretFromEnv(sid),
    now,
    schedule: (cb) => { setTimeout(cb, 30); },
    readFile: (path) => vault.read(path),
    resolveFile: (link, from) => vault.resolve(link, from),
    parseYaml: (text) => parse(text) as unknown,
    responses: new ResponseHistory(fsAdapter, join(pluginDir, "responses"), () => id, now),
    filesIn: (folder) => vault.filesIn(folder),
    append: (path, text) => vault.append(path, text),
    writeFile: (path, text) => vault.write(path, text),
    device: () => id,
  };
  const data = new DataLayer(host);
  const ledger = data.ledger!;
  const frontmatter = (path: string) => vault.file(path)?.fm;
  const refuse = (path: string) => {
    // Any case: on a disk that ignores case, "gizmo POLICY.md" is the same note.
    if (isPolicyPath(path)) throw new Error(`${path} is your Gizmo policy; apps can't change it`);
  };
  /** One write to a note at a time. */
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    refuse(path);
    const run = (queues.get(path) ?? Promise.resolve()).then(fn, fn);
    queues.set(path, run.catch(() => {}));
    return run;
  };

  const io: ActionIO & { setTaskDone(path: string, line: number, text: string, done: boolean): Promise<boolean> } = {
    now: () => new Date(now()),
    writeFrontmatter: (path, fn) => queued(path, () => vault.process(path, fn)),
    store: (dataPath, appPath) => ledgerStore(ledger, dataPath, () => frontmatter(appPath) ?? {}),
    appendLine: (path, line) => queued(path, async () => {
      const there = vault.file(path) !== undefined;
      await vault.write(path, withLine(there ? await vault.read(path) : "", line));
      return !there;
    }),
    createNote: (path, fm, body) => queued(path, async () => {
      if (vault.file(path) || existsSync(vault.abs(path))) return false;
      const text = noteText(Object.keys(fm).length ? yamlText(fm) : "", body);
      await vault.write(path, text);
      return text;
    }),
    readBody: async (path) => {
      const target = storeTarget(path);
      const found = vault.resolve(target, "") ?? (vault.file(notePath(target)) ? notePath(target) : undefined);
      if (!found) throw new Error(`can't find [[${target}]]`);
      return bodyOf(await vault.read(found));
    },
    notify: (message) => log(message),
    openNote: () => {},
    setTaskDone: (path, line, text, done) => queued(path, async () => {
      if (!vault.file(path)) return false;
      const next = tickLine(await vault.read(path), line, text, done);
      if (next === undefined) return false;
      await vault.write(path, next);
      return true;
    }),
  };

  const deviceNames = async () => {
    const out = new Map<string, string>();
    for (const b of await beats()) out.set(b.id, b.name);
    return out;
  };
  const activity = new ActivityLog(fileStore(join(pluginDir, "activity", `${id}.json`)), now, async () => {
    const dir = join(pluginDir, "activity");
    if (!existsSync(dir)) return [];
    const names = await deviceNames();
    const out: { device: string; text: string }[] = [];
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json") || f === `${id}.json`) continue;
      const text = await fs.readFile(join(dir, f), "utf8").catch(() => undefined);
      if (text !== undefined) out.push({ device: names.get(f.slice(0, -5)) ?? "another device", text });
    }
    return out;
  });

  /** Every device's word, from the plugin folder's devices/. */
  const beats = async (): Promise<Beat[]> => {
    const dir = join(pluginDir, "devices");
    if (!existsSync(dir)) return [];
    const out: Beat[] = [];
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const b = readBeat(await fs.readFile(join(dir, f), "utf8").catch(() => ""));
      if (b) out.push(b);
    }
    return out;
  };
  const beat = {
    heard: false,
    runner: undefined as Beat | undefined,
    seen: [] as Beat[],
    saidAt: 0,
    onStartOver: () => {},
    async beat(force = false): Promise<void> {
      const t = now();
      const me: Beat = { id, name: "gizmod", host: hostname(), priority: PRIORITY.gizmod, seen: t, zone: localZone() };
      // A folder a sync is rewriting is read next time: who runs stays as it was, and nothing starts over.
      const all = await beats().catch(() => undefined);
      if (!all) return;
      const last = this.heard ? undefined : all.find((b) => b.id === id)?.seen;
      if (!this.heard || force || t - this.saidAt >= BEAT_EVERY_MS) {
        await fileStore(join(pluginDir, "devices", `${id}.json`)).write(JSON.stringify(me)).then(() => { this.saidAt = t; }, (e: Error) => log(`couldn't write gizmod's beat: ${e.message}`));
      }
      const others = all.filter((b) => b.id !== id);
      this.seen = [me, ...others];
      const was = this.runner?.id;
      this.runner = runnerOf(this.seen, t);
      if (startsOver(id, this.runner?.id, was, !this.heard, last, others)) this.onStartOver();
      this.heard = true;
    },
    isRunner(): boolean {
      return this.heard && this.runner?.id === id;
    },
  };

  const notices: string[] = [];
  const sink: BackgroundSink = {
    notify: (message) => { notices.push(message); log(message); },
    setCommands: () => {},
    setStatus: () => {},
    openApp: () => {},
    // Nobody is at gizmod to say Run: what would ask is refused.
    confirm: async () => false,
    choose: async () => undefined,
    openUrl: () => {},
    alert(notice) {
      if (opts.macNotices) void macNotice(notice.text);
      if (!opts.ntfyUrl) return;
      const to = new URL(opts.ntfyUrl);
      const body = pushText(notice, store().policy, to.host);
      void doFetch(opts.ntfyUrl, { method: "POST", body, headers: { Title: "Gizmo" } }).catch((e: Error) => log(`couldn't push an alert: ${e.message}`));
    },
  };

  const bgEnv: BackgroundEnv = {
    data,
    frontmatter,
    notes: { resolve: (link, from) => vault.resolve(link, from), frontmatter },
    appPaths: () => vault.notes().filter((f) => isApp(frontmatter(f.path))).map((f) => f.path),
    // gizmod never opens an app: one runs here once it was opened and allowed in Obsidian, as in its background.
    isGranted: (path, wanted, asked) => (asked ? isAllowedUnder(store().grants, path, asked, true) : isAllowed(store().grants, path, wanted, true)),
    granted: (path) => grantedOf(store().grants, path),
    policy: () => store().policy,
    storePath: (s, from) => vault.resolve(storeTarget(s), from) ?? notePath(storeTarget(s)),
    actionDeps(appPath: string, dataPath: string, actor?: Actor): ActionDeps {
      return {
        ...actionDepsOf(io, appPath, dataPath),
        log: actor ? (what, changes) => activity.add({ app: appPath, actor, what, changes }).then((e) => e?.id, () => undefined) : undefined,
      };
    },
    now: () => new Date(now()),
    sink,
    triggers: fileStore(join(pluginDir, "triggers", `${id}.json`)),
    // gizmod never writes data.json; its own activity follows a rename it sees as a delete and a create.
    renamed: (from, to) => void activity.rename(from, to),
    otherTriggers: async () => {
      const dir = join(pluginDir, "triggers");
      if (!existsSync(dir)) return [];
      const out: string[] = [];
      for (const f of await fs.readdir(dir)) {
        if (!f.endsWith(".json") || f === `${id}.json`) continue;
        const text = await fs.readFile(join(dir, f), "utf8").catch(() => undefined);
        if (text !== undefined) out.push(text);
      }
      return out;
    },
    // gizmod uses the keys Obsidian made; it never makes one.
    linkKey: (path, shortcut) => store().linkKeys?.[`${path}#${shortcut}`],
    captureKey: (key) => {
      const keys = store().captureKeys;
      return keys && Object.hasOwn(keys, key) ? keys[key] : undefined;
    },
    destinations: (path, shortcut) => store().answerTo?.[`${path}#${shortcut}`] ?? [],
    allowDestination: () => {},
    logSent: (entry: NewEntry) => void activity.add(entry),
    runsBackground: () => beat.isRunner(),
    // Deadlines mean where the person is: the zone of the phone or desktop they used last.
    zone: () => whereYouAre(beat.seen),
    quietAlerts: () => false,
  };
  // Only the device running background work writes data notes' snapshots: gizmod, when it's there.
  data.setSnapshots({ isRunner: () => beat.isRunner(), delayMs: 5000, writeNote: (path, fn) => io.writeFrontmatter(path, fn) });

  return { vault, data, host, io, activity, beat, sink, notices, bgEnv, store, pluginDir, unseenMs: UNSEEN_MS };
}

/** A macOS notice, as a notification from Script Editor would show it. */
async function macNotice(text: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const quoted = JSON.stringify(text);
  execFile("osascript", ["-e", `display notification ${quoted} with title "Gizmo"`], () => {});
}
