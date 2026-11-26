// A GizmoRuntime on an in-memory vault, as a program other than Obsidian would run it: for testing
// the runtime and the helpers built on it in plain Node, with nothing standing in for Obsidian.
import { stringify } from "yaml";
import { GizmoRuntime, type RuntimeHost } from "../../src/runtime.ts";
import { SettingsFile, type SettingsSource, type StoredData } from "../../src/stored.ts";
import { PRIORITY, type PluginFiles } from "../../src/device.ts";
import { vaultWrites, type VaultFiles } from "../../src/vault-ops.ts";
import { ledgerStore } from "../../src/datastore.ts";
import { fakeHost } from "./fakes.ts";
import { parseYaml } from "./yaml.ts";

export type Notes = Parameters<typeof fakeHost>[0];

/** A note's text as the fake vault keeps it: its frontmatter apart from its body. */
export function memoryFiles(f: ReturnType<typeof fakeHost>, trashed: string[]): VaultFiles {
  const textOf = (path: string) => {
    const note = f.files.get(path);
    if (!note) return f.others.get(path) ?? "";
    return note.fm ? `---\n${stringify(note.fm)}---\n${note.body ?? ""}` : note.body ?? "";
  };
  const write = async (path: string, text: string) => {
    if (!path.endsWith(".md")) return void f.others.set(path, text);
    const m = /^---\n([\s\S]*?)---\n([\s\S]*)$/.exec(text);
    f.files.set(path, m ? { fm: parseYaml(m[1]) as Record<string, unknown>, body: m[2] } : { body: text });
  };
  return {
    normalize: (path) => path,
    exists: (path) => f.files.has(path) || f.others.has(path),
    read: async (path) => textOf(path),
    write,
    async create(path, text) {
      if (f.files.has(path) || f.others.has(path)) throw new Error("File already exists.");
      await write(path, text);
    },
    async processFrontmatter(path, fn) {
      const note = f.files.get(path) ?? {};
      note.fm ??= {};
      fn(note.fm);
      f.files.set(path, note);
    },
    append: async (path, text) => write(path, textOf(path) + text),
    async trash(path) {
      f.files.delete(path);
      trashed.push(path);
    },
  };
}

/** The plugin's folder, in memory. */
export function memoryPluginFiles(kept: Map<string, string>): PluginFiles {
  return {
    file: (name) => ({ read: async () => kept.get(name), write: async (text) => { kept.set(name, text); } }),
    folder: async (name) => [...kept].filter(([k]) => k.startsWith(`${name}/`) && k.endsWith(".json")).map(([k, text]) => ({ name: k.slice(name.length + 1, -".json".length), text })),
  };
}

/**
 * A runtime on an in-memory vault: `disk` is data.json as the sync leaves it; without `writes`, the
 * host only reads it, as gizmod does. Timers never fire on their own: a test ticks or seals itself.
 */
export async function runtimeOn(notes: Notes, opts: { settings?: Partial<StoredData>; writes?: boolean; device?: string; folder?: string; secrets?: Record<string, string> | false } = {}) {
  const f = fakeHost(notes);
  const disk = { json: JSON.stringify({ grants: {}, ...opts.settings }) };
  const file = new SettingsFile({ load: async () => JSON.parse(disk.json) as unknown, save: async (data) => { disk.json = JSON.stringify(data); } });
  await file.open();
  const settings: SettingsSource = opts.writes === false ? { get data() { return file.data; }, reload: () => file.reload() } : file;
  const kept = new Map<string, string>();
  const trashed: string[] = [];
  const renamed: [string, string][] = [];
  const id = opts.device ?? "d1mac000";
  const secrets = new Map(Object.entries(opts.secrets || {}));
  const notices: string[] = [];
  const opened: string[] = [];
  // Set below: a rename made here is told back to the runtime, as Obsidian tells of it.
  let runtime: GizmoRuntime | undefined;
  const writes = vaultWrites(memoryFiles(f, trashed), (fm) => stringify(fm));
  const frontmatter = (path: string) => f.files.get(path)?.fm;
  const host: RuntimeHost = {
    host: f.host,
    settings,
    files: memoryPluginFiles(kept),
    device: { id, name: "Mac" },
    beat: { mine: (t) => ({ id, name: "Mac", host: "mac", priority: PRIORITY.desktop, seen: t, zone: "UTC", used: t }) },
    writes,
    notes: { resolve: (link) => [...f.files.keys()].find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)), frontmatter: (p) => f.files.get(p)?.fm },
    storePath: (store) => `${store}.md`,
    // An app's actions run through the same writes, as gizmod's do.
    actionIO: (appPath) => ({
      now: () => new Date(f.host.now()),
      frontmatter,
      writeFrontmatter: (path, fn) => writes.writeFrontmatter(path, fn),
      updateFrontmatter: (path, fn) => writes.updateFrontmatter(path, fn),
      store: (dataPath, app) => ledgerStore(runtime!.dataLayer.ledger!, dataPath, () => frontmatter(app) ?? {}),
      appendLine: (path, line) => writes.appendLine(path, line),
      createNote: (path, fm, body) => writes.createNote(path, fm, body),
      readBody: async (link) => {
        const found = [...f.files.keys()].find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)) ?? (f.files.has(link) ? link : undefined);
        if (!found) throw new Error(`can't find [[${link}]] from ${appPath}`);
        return f.files.get(found)!.body ?? "";
      },
      notify: (message) => { notices.push(message); },
      openNote: () => {},
      setTaskDone: (path, line, text, done) => writes.setTaskDone(path, line, text, done),
    }),
    // Moves a note, or every file under a folder, as a rename in Obsidian does.
    async rename(from, to) {
      const under = [...f.files.keys(), ...f.others.keys()].filter((p) => p === from || p.startsWith(`${from}/`));
      if (!under.length || [...f.files.keys(), ...f.others.keys()].some((p) => p === to || p.startsWith(`${to}/`))) return false;
      renamed.push([from, to]);
      for (const p of under) {
        const moved = `${to}${p.slice(from.length)}`;
        if (f.files.has(p)) { f.files.set(moved, f.files.get(p)!); f.files.delete(p); }
        else { f.others.set(moved, f.others.get(p)!); f.others.delete(p); }
        runtime!.fileRenamed(moved, p);
      }
      return true;
    },
    newNotesFolder: () => opts.folder ?? "",
    exists: (path) => [...f.files.keys(), ...f.others.keys()].some((p) => p === path || p.startsWith(`${path}/`)),
    whenIndexed: async () => {},
    ...(opts.secrets !== false && { secrets: { get: (sid) => secrets.get(sid) ?? null, set: (sid, value) => { secrets.set(sid, value); } } }),
    sink: {
      notify: (message) => { notices.push(message); }, setCommands: () => {}, setStatus: () => {}, openApp: (path) => { opened.push(path); },
      confirm: async () => false, choose: async () => undefined, openUrl: () => {},
    },
    every: () => () => {},
    later: (fn) => { fn(); return () => {}; },
  };
  runtime = new GizmoRuntime(host);
  await runtime.open();
  return { runtime, f, disk, kept, trashed, renamed, secrets, notices, opened, saved: () => JSON.parse(disk.json) as StoredData };
}
