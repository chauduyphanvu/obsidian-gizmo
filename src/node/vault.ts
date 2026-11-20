/**
 * A vault folder read from disk, as Obsidian's vault and metadata cache read it, for gizmod: every
 * note's frontmatter (a block YAML can't read is dropped whole, as Obsidian drops it), its tags
 * (the frontmatter's and inline #tags outside code), its times, and links resolved as Obsidian
 * resolves them. The config folder and dot folders aren't part of it. A watcher keeps it current.
 */
import { existsSync, promises as fs, watch, type FSWatcher } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import type { FileInfo } from "../datalayer.ts";

export interface VaultFile {
  info: FileInfo;
  /** Notes only: the frontmatter as Obsidian reads it, and every tag with its #. */
  fm?: Record<string, unknown>;
  tags: string[];
}

const toPosix = (p: string) => p.split(sep).join("/");
const isNote = (path: string) => path.endsWith(".md");

/** A note's frontmatter block and the text after it; no block when the note doesn't start with one. */
export function splitNote(text: string): { yaml?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!m || m.index !== 0) return { body: text };
  return { yaml: m[1], body: text.slice(m[0].length) };
}

/** YAML as Obsidian reads frontmatter: a map, or nothing at all when any of it can't be read. */
export function readFrontmatter(yaml: string | undefined): Record<string, unknown> | undefined {
  if (yaml === undefined || !yaml.trim()) return undefined;
  try {
    const v = parse(yaml) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function yamlText(fm: Record<string, unknown>): string {
  return stringify(fm, { lineWidth: 0 });
}

/** The tags `tags:` (or `tag:`) gives: a list, or one string split on commas and spaces. */
function frontmatterTags(fm: Record<string, unknown> | undefined): string[] {
  const raw = fm?.tags ?? fm?.tag;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  return list.map((t) => t.trim().replace(/^#/, "")).filter(Boolean).map((t) => `#${t}`);
}

/** Inline #tags in a note's body, outside code blocks and inline code; a tag isn't all digits. */
export function inlineTags(body: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, " ");
    for (const m of plain.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) if (/[^\d]/.test(m[1])) out.push(`#${m[1]}`);
  }
  return out;
}

export class NodeVault {
  readonly root: string;
  readonly configDir: string;
  private files = new Map<string, VaultFile>();
  private listeners: ((path: string, gone: boolean) => void)[] = [];
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(root: string, configDir = ".obsidian") {
    this.root = root;
    this.configDir = configDir;
  }

  /** Whether a vault path is the vault's own: not in the config folder or any dot folder. */
  private ours(path: string): boolean {
    return !!path && !path.split("/").some((part) => part.startsWith("."));
  }

  abs(path: string): string {
    return join(this.root, ...path.split("/"));
  }

  async scan(): Promise<void> {
    this.files.clear();
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) await this.load(toPosix(relative(this.root, full)));
      }
    };
    await walk(this.root);
  }

  /** Reads one file into the index again; false when it's gone. */
  private async load(path: string): Promise<boolean> {
    let stat;
    try {
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
    const text = await fs.readFile(this.abs(path), "utf8").catch(() => "");
    const { yaml, body } = splitNote(text);
    const fm = readFrontmatter(yaml);
    this.files.set(path, { info, fm, tags: [...new Set([...frontmatterTags(fm), ...inlineTags(body)])] });
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
    const target = link.split("#")[0].split("|")[0].trim();
    if (!target) return undefined;
    for (const p of [target, `${target}.md`]) if (this.files.has(p)) return p;
    const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    if (target.startsWith("./") || target.startsWith("../")) {
      const joined = toPosix(relative(this.root, join(this.root, fromDir, target)));
      for (const p of [joined, `${joined}.md`]) if (this.files.has(p)) return p;
    }
    const want = target.toLowerCase();
    const candidates = [...this.files.keys()].filter((p) => {
      const lower = p.toLowerCase();
      return [want, `${want}.md`].some((w) => lower === w || lower.endsWith(`/${w}`));
    });
    if (!candidates.length) return undefined;
    const here = candidates.find((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === fromDir);
    return here ?? candidates.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
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
      const { yaml, body } = splitNote(before);
      const fm = yaml === undefined ? {} : readFrontmatter(yaml) ?? (yaml.trim() ? undefined : {});
      if (!fm) throw new Error(`${path} has frontmatter that isn't YAML`);
      fn(fm);
      const text = `---\n${yamlText(fm)}---\n${body}`;
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

  private async changed(path: string): Promise<void> {
    const there = await this.load(path);
    for (const l of this.listeners) l(path, !there);
  }

  /** Follows the folder: each file written, made or removed by anyone is read again a moment later. */
  watch(): void {
    this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = toPosix(String(name));
      if (!this.ours(path)) return;
      clearTimeout(this.pending.get(path));
      this.pending.set(path, setTimeout(() => {
        this.pending.delete(path);
        void this.changed(path);
      }, 100));
    });
  }

  close(): void {
    this.watcher?.close();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
