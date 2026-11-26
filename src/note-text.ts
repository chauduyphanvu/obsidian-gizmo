/**
 * A note's text as Obsidian reads it, on any host: its frontmatter block (a block YAML can't read
 * is dropped whole), its tags (the frontmatter's and inline #tags outside code and HTML comments),
 * a frontmatter edit as Obsidian's processFrontMatter makes one, and a link resolved as Obsidian
 * resolves it. gizmod's vault reads notes with it, and test/live/parity.mjs checks gizmod against a
 * real Obsidian.
 */
import { parse, stringify } from "yaml";
import { fenceStep } from "./fences.ts";

/** Where a note's frontmatter YAML sits (from after its opening line to its closing line), and where the block ends. */
export function frontmatterSpan(text: string): { from: number; to: number; end: number } | undefined {
  const open = /^---\r?\n/.exec(text);
  if (!open) return undefined;
  const close = /^---[ \t]*(?:\r?\n|$)/gm;
  close.lastIndex = open[0].length;
  const m = close.exec(text);
  return m ? { from: open[0].length, to: m.index, end: m.index + m[0].length } : undefined;
}

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

/** A tag as Obsidian takes one: letters, digits, _, / and -, not all digits. */
const isTag = (t: string) => /^[\p{L}\p{N}_/-]+$/u.test(t) && /[^\d]/.test(t);

/** The tags `tags:` gives, as Obsidian reads them: each of a list, or one string as one tag; anything else isn't a tag. */
export function frontmatterTags(fm: Record<string, unknown> | undefined): string[] {
  const raw = fm?.tags;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  return list.map((t) => t.trim().replace(/^#/, "")).filter(isTag).map((t) => `#${t}`);
}

/**
 * Inline #tags in a note's body, outside code blocks, inline code and HTML comments; a tag isn't all
 * digits. Tags in `%% %%` comments count, as Obsidian counts them.
 */
export function inlineTags(body: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  let comment = false;
  for (const raw of body.split("\n")) {
    let line = raw.replace(/\r$/, "");
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      comment = false;
      line = line.slice(end + 3);
    } else {
      const step = fenceStep(fence, line);
      fence = step.open;
      if (step.code) continue;
    }
    let plain = line.replace(/`[^`]*`/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
    const opened = plain.indexOf("<!--");
    if (opened >= 0) {
      comment = true;
      plain = plain.slice(0, opened);
    }
    for (const m of plain.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) if (/[^\d]/.test(m[1])) out.push(`#${m[1]}`);
  }
  return out;
}

/** Every tag a note has, with its #: the frontmatter's, then the body's, each once. */
export function noteTags(fm: Record<string, unknown> | undefined, body: string): string[] {
  return [...new Set([...frontmatterTags(fm), ...inlineTags(body)])];
}

/**
 * A note's text with its frontmatter changed by `fn`, as Obsidian's processFrontMatter changes it:
 * only the YAML is replaced, the block's own lines kept as they were; a block left empty goes.
 */
export function withFrontmatter(before: string, fn: (fm: Record<string, unknown>) => void, path: string): string {
  const span = frontmatterSpan(before);
  const yaml = span && before.slice(span.from, span.to);
  const fm = yaml === undefined ? {} : readFrontmatter(yaml) ?? (yaml.trim() ? undefined : {});
  if (!fm) throw new Error(`${path} has frontmatter that isn't YAML`);
  fn(fm);
  const empty = Object.keys(fm).length === 0;
  return !span ? (empty ? before : `---\n${yamlText(fm)}---\n${before}`)
    : empty ? before.slice(span.end)
    : before.slice(0, span.from) + yamlText(fm) + before.slice(span.to);
}

/** `rel` from the folder `dir`, as a POSIX path join normalizes it: `..` above the top kept, so it matches nothing. */
function joinPath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of [...dir.split("/"), ...rel.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return (out.join("/") || ".") + (rel.endsWith("/") && out.length ? "/" : "");
}

/** The file of `paths` a link from the note at `from` points at, as Obsidian finds it; undefined when none. */
export function resolveLink(paths: Iterable<string>, link: string, from: string): string | undefined {
  const all = [...paths];
  const target = link.split("#")[0].split("|")[0].trim().normalize("NFC");
  if (!target) return undefined;
  // A path is a path whatever its case, and wins over a note of that name nearer the link.
  const lower = target.toLowerCase();
  const exact = all.find((p) => p.toLowerCase() === lower || p.toLowerCase() === `${lower}.md`);
  if (exact) return exact;
  const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  if (target.startsWith("./") || target.startsWith("../")) {
    // Case aside, as for any other path; one that leaves the vault finds nothing.
    const joined = joinPath(fromDir, target).toLowerCase();
    const found = all.find((p) => p.toLowerCase() === joined || p.toLowerCase() === `${joined}.md`);
    if (found) return found;
  }
  const candidates = all.filter((p) => {
    const name = p.toLowerCase();
    return [lower, `${lower}.md`].some((w) => name === w || name.endsWith(`/${w}`));
  });
  if (!candidates.length) return undefined;
  const here = candidates.find((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === fromDir);
  return here ?? candidates.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
}
