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
import { actionDepsOf, bodyOf, type ActionDeps, type ActionIO } from "../actions.ts";
import type { Actor } from "../activity.ts";
import type { AlertNotice, BackgroundEnv, BackgroundSink } from "../background.ts";
import { DataLayer, type Host } from "../datalayer.ts";
import { ledgerStore } from "../datastore.ts";
import { DEVICE_FOLDERS, Heartbeat, PRIORITY, UNSEEN_MS, deviceFile, otherLogs, otherTriggers, whereYouAre, type PluginFiles } from "../device.ts";
import { localZone } from "../time.ts";
import { grantedOf, isAllowed, isAllowedUnder } from "../grants.ts";
import { clearance, rank, type AppliedPolicy } from "../policy.ts";
import { ResponseHistory, type FolderAdapter } from "../responses.ts";
import { SNAPSHOT_DELAY_MS, SNAPSHOT_GAP_MS } from "../snapshots.ts";
import { isApp, notePath, storeTarget } from "../store.ts";
import { captureNamesOf, destinationsOf, linkKeyOf, type StoredData } from "../stored.ts";
import { NodeVault, yamlText } from "./vault.ts";
import { vaultWrites } from "../vault-ops.ts";

/** Gizmo's settings as Obsidian keeps them in data.json; gizmod only reads them. */
export type Settings = Pick<StoredData, "grants" | "linkKeys" | "answerTo" | "captureKeys" | "policy">;

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

/** The plugin's folder on disk, as both hosts read and write it (see device.ts). */
export function pluginFiles(pluginDir: string): PluginFiles {
  return {
    file: (name) => fileStore(join(pluginDir, name)),
    async folder(name) {
      const dir = join(pluginDir, name);
      if (!existsSync(dir)) return [];
      const out: { name: string; text: string }[] = [];
      for (const f of await fs.readdir(dir)) {
        if (!f.endsWith(".json")) continue;
        const text = await fs.readFile(join(dir, f), "utf8").catch(() => undefined);
        if (text !== undefined) out.push({ name: f.slice(0, -".json".length), text });
      }
      return out;
    },
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
  const files = pluginFiles(pluginDir);
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
    fileSize: (path) => vault.size(path),
    append: (path, text) => vault.append(path, text),
    writeFile: (path, text) => vault.write(path, text),
    device: () => id,
  };
  const data = new DataLayer(host);
  const ledger = data.ledger!;
  const frontmatter = (path: string) => vault.file(path)?.fm;
  // Written as Obsidian writes them (see vault-ops.ts), each change read again just before it's written.
  const writes = vaultWrites({
    normalize: (path) => path,
    exists: (path) => vault.file(path) !== undefined || existsSync(vault.abs(path)),
    read: (path) => vault.read(path),
    write: (path, text) => vault.write(path, text),
    create: (path, text) => vault.write(path, text),
    processFrontmatter: (path, fn) => vault.process(path, fn),
    append: (path, text) => vault.append(path, text),
  }, yamlText);

  const io: ActionIO = {
    now: () => new Date(now()),
    writeFrontmatter: (path, fn) => writes.writeFrontmatter(path, fn),
    updateFrontmatter: (path, fn) => writes.updateFrontmatter(path, fn),
    store: (dataPath, appPath) => ledgerStore(ledger, dataPath, () => frontmatter(appPath) ?? {}),
    appendLine: (path, line) => writes.appendLine(path, line),
    createNote: (path, fm, body) => writes.createNote(path, fm, body),
    readBody: async (path) => {
      const target = storeTarget(path);
      const found = vault.resolve(target, "") ?? (vault.file(notePath(target)) ? notePath(target) : undefined);
      if (!found) throw new Error(`can't find [[${target}]]`);
      return bodyOf(await vault.read(found));
    },
    notify: (message) => log(message),
    openNote: () => {},
    setTaskDone: (path, line, text, done) => writes.setTaskDone(path, line, text, done),
  };

  const activity = new ActivityLog(files.file(deviceFile(DEVICE_FOLDERS.activity, id)), now, () => otherLogs(files, id));

  // gizmod says only on its interval; a beat it couldn't write is logged and written on the next one.
  const beat = new Heartbeat({
    id,
    files,
    now,
    mine: (t) => ({ id, name: "gizmod", host: hostname(), priority: PRIORITY.gizmod, seen: t, zone: localZone() }),
    writeFailed: (e) => log(`couldn't write gizmod's beat: ${e.message}`),
  });

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
    triggers: files.file(deviceFile(DEVICE_FOLDERS.triggers, id)),
    // gizmod never writes data.json; its own activity follows a rename it sees as a delete and a create.
    renamed: (from, to) => void activity.rename(from, to),
    otherTriggers: () => otherTriggers(files, id),
    // gizmod uses the keys Obsidian made; it never makes one.
    linkKey: (path, shortcut) => linkKeyOf(store(), path, shortcut),
    captureKey: (key) => captureNamesOf(store(), key),
    destinations: (path, shortcut) => destinationsOf(store(), path, shortcut),
    allowDestination: () => {},
    logSent: (entry: NewEntry) => void activity.add(entry),
    runsBackground: () => beat.isRunner(),
    // Deadlines mean where the person is: the zone of the phone or desktop they used last.
    zone: () => whereYouAre(beat.beats),
    quietAlerts: () => false,
  };
  // Only the device running background work writes data notes' snapshots: gizmod, when it's there.
  data.setSnapshots({ isRunner: () => beat.isRunner(), delayMs: SNAPSHOT_DELAY_MS, gapMs: SNAPSHOT_GAP_MS, writeNote: (path, fn) => io.writeFrontmatter(path, fn) });

  return { vault, data, host, io, activity, beat, sink, notices, bgEnv, store, pluginDir, unseenMs: UNSEEN_MS };
}

/** A macOS notice, as a notification from Script Editor would show it. */
async function macNotice(text: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const quoted = JSON.stringify(text);
  execFile("osascript", ["-e", `display notification ${quoted} with title "Gizmo"`], () => {});
}
