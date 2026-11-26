/**
 * A vault folder read from disk, as Obsidian's vault and metadata cache read it, for gizmod: every
 * note's frontmatter (a block YAML can't read is dropped whole, as Obsidian drops it), its tags
 * (the frontmatter's and inline #tags outside code and HTML comments), its times, and links resolved
 * as Obsidian resolves them. Paths are NFC, as Obsidian gives them, whatever form a name has on disk.
 * The config folder and dot folders aren't part of it. A watcher keeps it current.
 * test/live/parity.mjs checks all of this against a real Obsidian.
 */
import { existsSync, promises as fs, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { FileInfo } from "../../src/datalayer.ts";
import { noteTags, readFrontmatter, resolveLink, splitNote, withFrontmatter } from "../../src/note-text.ts";
import { vaultPath } from "../../src/store.ts";

export interface VaultFile {
  info: FileInfo;
  /** Notes only: the frontmatter as Obsidian reads it, and every tag with its #. */
  fm?: Record<string, unknown>;
  tags: string[];
}

const toPosix = (p: string) => p.split(sep).join("/");
const isNote = (path: string) => path.endsWith(".md");

/** A vault path as Obsidian keeps one: inside the vault, slashes tidied, NFC. */
export function nodePath(path: string): string | undefined {
  return vaultPath(path)?.normalize("NFC");
}

export class NodeVault {
  readonly root: string;
  readonly configDir: string;
  private files = new Map<string, VaultFile>();
  /** A file's name on disk, by its NFC path, where the two differ (a name written decomposed, as macOS may). */
  private disk = new Map<string, string>();
  private listeners: ((path: string, gone: boolean) => void)[] = [];
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private again: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(root: string, configDir = ".obsidian") {
    this.root = root;
    this.configDir = configDir;
  }

  /** Whether a vault path is the vault's own: not in the config folder or any dot folder. */
  private ours(path: string): boolean {
    return !!path && !path.split("/").some((part) => part.startsWith("."));
  }

  /**
   * Where a vault path is on disk. Only the vault's own files have a place: a path that leaves the
   * folder, or goes into the config folder or a dot folder, is refused, as Obsidian's vault refuses it.
   */
  abs(path: string): string {
    const inside = nodePath(path);
    if (inside === undefined || !this.ours(inside)) throw new Error(`${path} isn't a file in this vault`);
    return join(this.root, ...(this.disk.get(inside) ?? inside).split("/"));
  }

  /** The vault path of a name as it is on disk, kept so the file can be found again by it. */
  private pathOf(onDisk: string): string {
    const path = onDisk.normalize("NFC");
    if (path !== onDisk) this.disk.set(path, onDisk);
    return path;
  }

  /**
   * Reads every file again. A folder reached through a symlink is read as Obsidian reads it (each
   * real folder once); a symlinked file isn't, as Obsidian leaves it out. The watcher doesn't see
   * inside a symlinked folder, nor does Obsidian's.
   */
  async scan(): Promise<void> {
    this.files.clear();
    this.disk.clear();
    for (const path of await this.walk()) await this.load(path);
  }

  /**
   * Reads again what changed while nobody was watching (macOS's watcher starts a moment after it is
   * asked to): each file that came, went or has another time than the one kept is told as changed.
   */
  async rescan(): Promise<void> {
    const now = new Set(await this.walk());
    for (const path of now) {
      const mtime = (await fs.stat(this.abs(path)).catch(() => undefined))?.mtimeMs;
      if (mtime !== this.files.get(path)?.info.mtime) await this.changed(path);
    }
    for (const path of [...this.files.keys()]) if (!now.has(path)) await this.changed(path);
  }

  /** Every file's vault path, through symlinked folders, each real folder once. */
  private async walk(): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = async (dir: string): Promise<void> => {
      const real = await fs.realpath(dir).catch(() => dir);
      if (seen.has(real)) return;
      seen.add(real);
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        const folder = e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(full).catch(() => undefined))?.isDirectory());
        if (folder) await visit(full);
        else if (e.isFile()) out.push(this.pathOf(toPosix(relative(this.root, full))));
      }
    };
    await visit(this.root);
    return out;
  }

  /** Reads one file into the index again; false when it's gone. */
  private async load(path: string): Promise<boolean> {
    let stat;
    try {
      // A symlinked file isn't one of the vault's, as Obsidian leaves it out.
      if ((await fs.lstat(this.abs(path))).isSymbolicLink() && (await fs.stat(this.abs(path))).isFile()) throw new Error("a symlinked file");
      stat = await fs.stat(this.abs(path));
    } catch {
      this.files.delete(path);
      return false;
    }
    if (!stat.isFile()) return false;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const info: FileInfo = { path, basename: isNote(path) ? name.slice(0, -3) : name, mtime: stat.mtimeMs, ctime: stat.birthtimeMs || stat.ctimeMs };
    if (!isNote(path)) {
      this.files.set(path, { info, tags: [] });
      return true;
    }
    // Obsidian reads the frontmatter of a note that starts with a byte order mark (though its own edits don't see it).
    const text = (await fs.readFile(this.abs(path), "utf8").catch(() => "")).replace(/^\uFEFF/, "");
    const { yaml, body } = splitNote(text);
    const fm = readFrontmatter(yaml);
    this.files.set(path, { info, fm, tags: noteTags(fm, body) });
    return true;
  }

  file(path: string): VaultFile | undefined {
    return this.files.get(path);
  }

  notes(): FileInfo[] {
    return [...this.files.values()].filter((f) => isNote(f.info.path)).map((f) => f.info);
  }

  /** The files directly in a folder, of any kind. */
  filesIn(folder: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/"));
  }

  /**
   * The file a link points at from the note at `from`, as Obsidian's getFirstLinkpathDest finds it:
   * a path that is a file's (with or without .md), else files of that name whose path ends with the
   * link, case aside; of several, the one in `from`'s folder, else the shortest path.
   */
  resolve(link: string, from: string): string | undefined {
    return resolveLink(this.files.keys(), link, from);
  }

  /** A file's size in bytes, without reading it; undefined when there's none. */
  size(path: string): number | undefined {
    try {
      return statSync(this.abs(path)).size;
    } catch {
      return undefined;
    }
  }

  async read(path: string): Promise<string> {
    if (!this.files.has(path) && !existsSync(this.abs(path))) throw new Error(`Can't find ${path}`);
    return fs.readFile(this.abs(path), "utf8");
  }

  /** Writes a file whole, making its folders, and reads it into the index at once. */
  async write(path: string, text: string): Promise<void> {
    await fs.mkdir(dirname(this.abs(path)), { recursive: true });
    await fs.writeFile(this.abs(path), text);
    await this.changed(path);
  }

  /** Makes a new file and its folders, as Obsidian's create does; throws when one is there already. */
  async create(path: string, text: string): Promise<void> {
    await fs.mkdir(dirname(this.abs(path)), { recursive: true });
    await fs.writeFile(this.abs(path), text, { flag: "wx" });
    await this.changed(path);
  }

  /**
   * Moves a file into the vault's `.trash` folder, where Obsidian keeps what it deletes when set
   * to, under a name nothing there has yet, so it can be got back.
   */
  async trash(path: string): Promise<void> {
    const from = this.abs(path);
    const dir = join(this.root, ".trash");
    await fs.mkdir(dir, { recursive: true });
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let to = join(dir, name);
    for (let n = 2; existsSync(to); n++) to = join(dir, `${stem} ${n}${ext}`);
    await fs.rename(from, to);
    await this.changed(path);
  }

  async append(path: string, text: string): Promise<void> {
    await fs.mkdir(dirname(this.abs(path)), { recursive: true });
    await fs.appendFile(this.abs(path), text);
    await this.changed(path);
  }

  /**
   * Changes a note's frontmatter as Obsidian's processFrontMatter does, keeping the rest of the
   * note; read again and done over when another program wrote the note meanwhile.
   */
  async process(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const before = existsSync(this.abs(path)) ? await fs.readFile(this.abs(path), "utf8") : "";
      const text = withFrontmatter(before, fn, path);
      const now = existsSync(this.abs(path)) ? await fs.readFile(this.abs(path), "utf8") : "";
      if (now !== before && attempt < 3) continue;
      await this.write(path, text);
      return;
    }
  }

  onChange(cb: (path: string, gone: boolean) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }

  /**
   * A path that changed: a file is read again; a folder (renamed, moved or deleted, which macOS
   * reports for the folder alone) has what's under it read again, and what's gone from it dropped.
   */
  private async changed(path: string): Promise<void> {
    const stat = await fs.stat(this.abs(path)).catch(() => undefined);
    if (stat?.isDirectory()) {
      // What was there and still is changes on its own events; only what came or went is read here.
      for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`) && !existsSync(this.abs(p))) await this.changed(p);
      for (const e of await fs.readdir(this.abs(path), { withFileTypes: true }).catch(() => [])) {
        const child = this.pathOf(`${this.disk.get(path) ?? path}/${e.name}`);
        if (e.name.startsWith(".") || !this.ours(child)) continue;
        if (e.isDirectory() || !this.files.has(child)) await this.changed(child);
      }
      return;
    }
    if (!stat) {
      for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`)) await this.changed(p);
    }
    const there = await this.load(path);
    for (const l of this.listeners) l(path, !there);
  }

  /**
   * Follows the folder: each file written, made or removed by anyone is read again a moment later.
   * A watcher that fails is told to `trouble`, and the folder is read again and followed anew.
   */
  watch(trouble?: (e: Error) => void): void {
    this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = this.pathOf(toPosix(String(name)));
      if (!this.ours(path)) return;
      clearTimeout(this.pending.get(path));
      this.pending.set(path, setTimeout(() => {
        this.pending.delete(path);
        void this.changed(path);
      }, 100));
    });
    this.watcher.on("error", (e) => {
      this.watcher?.close();
      this.watcher = undefined;
      trouble?.(e);
      this.again = setTimeout(() => {
        if (this.closed) return;
        this.watch(trouble);
        void this.rescan();
      }, 5000);
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.again);
    this.watcher?.close();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
