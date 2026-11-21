import { describeChange } from "./activity.ts";
import { bodyOf } from "./actions.ts";
import type { AppEnv } from "./app.ts";
import { DataLayer, type FileInfo, type Host } from "./datalayer.ts";
import { Overlay } from "./dryrun.ts";
import { basename, notePath, storeTarget } from "./store.ts";

/** A note a try can see: the app's own, the components and templates it uses, or a shared bundle's. */
export interface SandboxNote {
  frontmatter: Record<string, unknown> | undefined;
  text: string;
}

/** One thing the app did in a try: a change it made to the copies, something it told, or a `then` it would run. */
export interface SandboxEvent {
  kind: "change" | "notice" | "then";
  text: string;
}

export interface Sandbox {
  env: AppEnv;
  data: DataLayer;
  overlay: Overlay;
  events: SandboxEvent[];
  /** Lets plain requests to these hosts through, for this try only. */
  allow(hosts: string[]): void;
  /** Calls `cb` after each event; returns how to stop. */
  onEvent(cb: () => void): () => void;
}

/**
 * An app's world in a try before Allow, made fresh and never from the real host or env: it sees
 * only `notes`, writes only to copies of them, uses no secret, keeps nothing on disk, and fetches
 * nothing unless a host was allowed for this try, and then only a plain request without a body.
 * Pictures aren't loaded. A `then` is told, not run; nothing opens.
 */
export function makeSandbox(opts: {
  appPath: string;
  notes: Map<string, SandboxNote>;
  parseYaml: (text: string) => unknown;
  now(): Date;
  /** The web, for requests to an allowed host. */
  fetch: Host["fetch"];
  copy(text: string): void;
}): Sandbox {
  const { notes } = opts;
  const allowed = new Set<string>();
  const events: SandboxEvent[] = [];
  const listeners = new Set<() => void>();
  const record = (kind: SandboxEvent["kind"], text: string) => {
    events.push({ kind, text });
    for (const cb of [...listeners]) cb();
  };
  const overlay = new Overlay({
    frontmatter: (path) => notes.get(path)?.frontmatter,
    text: async (path) => notes.get(path)?.text,
    exists: (path) => notes.has(path),
  });
  const isNote = (path: string) => path.endsWith(".md");
  const info = (path: string): FileInfo => ({ path, basename: basename(path), mtime: 0, ctime: 0 });
  const paths = () => [...new Set([...notes.keys(), ...overlay.touched])].filter((p) => isNote(p) && overlay.exists(p));
  /** A link or path among the notes the try can see, as Obsidian would find it: by path, then by name. */
  const resolve = (link: string): string | undefined => {
    const target = link.replace(/\.md$/i, "").toLowerCase();
    const all = [...new Set([...notes.keys(), ...overlay.touched])].filter((p) => overlay.exists(p));
    return all.find((p) => p.toLowerCase() === `${target}.md` || p.toLowerCase() === target)
      ?? all.find((p) => basename(p).toLowerCase() === target.split("/").pop());
  };

  const host: Host = {
    async fetch(url, headers, init) {
      let to: string;
      try {
        to = new URL(url).host;
      } catch {
        throw new Error(`${url} isn't a web address`);
      }
      if (init?.body !== undefined || (init?.method !== undefined && init.method !== "GET")) throw new Error(`A try never sends anything to ${to}`);
      if (!allowed.has(to)) throw new Error(`Not fetched in a try: ${to}`);
      return opts.fetch(url, headers, init);
    },
    markdownFiles: () => paths().map(info),
    fileInfo: (path) => (isNote(path) && overlay.exists(path) ? info(path) : undefined),
    frontmatter: (path) => overlay.frontmatter(path),
    tags: () => [],
    secret: () => { throw new Error("A try never uses your saved secrets"); },
    now: () => opts.now().getTime(),
    schedule: (cb) => { window.setTimeout(cb, 30); },
    async readFile(path) {
      const text = await overlay.text(path);
      if (text === undefined) throw new Error(`Can't find ${path}`);
      return text;
    },
    resolveFile: (link) => resolve(link),
    parseYaml: opts.parseYaml,
  };
  const data = new DataLayer(host);
  overlay.onChange((path) => data.fileChanged(path));

  const env: AppEnv = {
    data,
    frontmatter: (path) => overlay.frontmatter(path),
    notes: { resolve: (link) => resolve(link), frontmatter: (path) => overlay.frontmatter(path) },
    // Inside the try everything is allowed, since nothing it does leaves it.
    isGranted: () => true,
    granted: () => undefined,
    grant: async () => {},
    storePath: (store) => resolve(storeTarget(store)) ?? notePath(storeTarget(store)),
    writeFrontmatter: async (path, fn) => overlay.writeFrontmatter(path, fn),
    updateFrontmatter: async (path, fn) => overlay.updateFrontmatter(path, fn),
    appendLine: (path, line) => overlay.appendLine(path, line),
    createNote: async (path, fm, body) => overlay.createNote(path, fm, body),
    async readBody(path) {
      const found = resolve(storeTarget(path));
      const text = found ? await overlay.text(found) : undefined;
      if (text === undefined) throw new Error(`can't find [[${storeTarget(path)}]] in this try`);
      return bodyOf(text);
    },
    setTaskDone: (path, line, text, done) => overlay.setTaskDone(path, line, text, done),
    notify: (message) => record("notice", message),
    openNote: (path) => record("notice", `It would open ${path}`),
    showSource: () => {},
    showSourceAt: () => {},
    sourceLines: async () => (notes.get(opts.appPath)?.text ?? "").split(/\r?\n/),
    copy: (text) => opts.copy(text),
    // A try can't tell whether a note it adds a line to is there, since it sees none of them.
    log: (entry) => { for (const c of entry.changes) record("change", describeChange(c.kind === "line-added" ? { ...c, created: false } : c)); },
    trigger: async (_from, then) => record("then", `It would run “${then.do}” in ${storeTarget(then.app)}`),
    now: () => opts.now(),
    preview: true,
  };

  return {
    env,
    data,
    overlay,
    events,
    allow(hosts) {
      for (const h of hosts) allowed.add(h);
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * The hosts a try may fetch from once the person says so: those the app fetches from, less any it
 * sends someone's data or a body to. Requests that use a secret never get as far as a host.
 */
export function plainHosts(wanted: string[]): string[] {
  const hostOf = (perm: string) => perm.slice(perm.indexOf(":") + 1);
  const sending = new Set(wanted.filter((p) => p.startsWith("send:") || p.startsWith("post:")).map((p) => hostOf(p).split("|")[0]));
  return wanted.filter((p) => p.startsWith("net:")).map(hostOf).filter((h) => !sending.has(h));
}
