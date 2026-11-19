import { fillTemplate, fillWith, formatValue, getPath, stampParts, type Row } from "./data.ts";
import { notePath, saveTarget, type Panel } from "./spec.ts";
import { withoutDefinition } from "./store.ts";

/**
 * What running a panel's actions needs, and nothing more: an open app passes its env; something
 * running a panel without opening its app (a shortcut) passes its own.
 */
export interface ActionDeps {
  now(): Date;
  /** The app's data note, where lists are saved. */
  dataPath: string;
  /** The app note: links in `open` resolve from it. */
  appPath: string;
  writeFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  appendLine(path: string, line: string): Promise<void>;
  /** Creates a note; false, writing nothing, when one is already at that path. */
  createNote(path: string, frontmatter: Record<string, unknown>, body: string): Promise<boolean>;
  /** The text after the frontmatter of the note a link or path names. */
  readBody(path: string): Promise<string>;
  notify(message: string): void;
  openNote(path: string, fromPath: string): void;
}

/** How a run went: `ok` is false when it stopped on an error or a note that already exists. */
export interface ActionResult {
  ok: boolean;
  /** The note a save to a folder created. */
  path?: string;
}

/** Characters Obsidian won't take in a file name. */
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

/** A file name from filled text: forbidden characters become spaces, and it can't start with a dot. */
export function fileName(text: string): string {
  return text.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^\.+\s*/, "");
}

/** Line breaks in filled text, which would split a line, a file name or a notice in two. */
const oneLine = (text: string) => text.replace(/\r\n|\r|\n/g, " ");

/**
 * A value as written into a note, a file name or a notice: a number as it is, never rounded for
 * display (91.06 stays 91.06), with only the binary noise of arithmetic taken off (0.1 + 0.2 is 0.3).
 */
function written(v: unknown): string {
  if (typeof v === "number") return String(Number(v.toPrecision(15)));
  if (Array.isArray(v)) return v.map(written).join(", ");
  return formatValue(v, undefined, false);
}

/** A template filled from a row where one line is wanted: each value's line breaks become spaces. */
function fillLine(template: string, ctx: Row): string {
  return fillWith(template, ctx, (_, v) => oneLine(written(v)));
}

/**
 * A note's text with a line added at the end. Nothing from data ever starts a note with `---`,
 * which Obsidian would read as the start of its properties: a first line that would is put after a
 * blank one.
 */
export function withLine(text: string, line: string): string {
  if (text === "") return `${/^---/.test(line) ? "\n" : ""}${line}\n`;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

/**
 * A new note's text: its properties as a YAML block (`yaml` as stringified, empty for none), then
 * its body. A body that would start the note with `---` is put after a blank line, so a filled
 * template can't make properties of its own.
 */
export function noteText(yaml: string, body: string): string {
  if (yaml) return `---\n${yaml}---\n${body}`;
  return /^---/.test(body) ? `\n${body}` : body;
}

/** A note's text after its frontmatter block. */
export function bodyOf(text: string): string {
  const m = text.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/);
  return m ? text.slice(m[0].length) : text;
}

/** A template note's body filled from the row; Obsidian's `{{title}}` reads like `{title}`. */
export function fillBody(body: string, ctx: Row): string {
  return fillTemplate(body.replace(/\{\{([^{}]+)\}\}/g, "{$1}"), ctx);
}

/**
 * `row:` filled from the context; a value that is exactly one `{placeholder}` keeps the value's
 * type, and so does one that is already a number or true/false (a whole `$reference` filled in).
 */
export function fillRow(templates: Record<string, string | number | boolean>, ctx: Row): Row {
  return Object.fromEntries(Object.entries(templates).map(([key, t]) => {
    if (typeof t !== "string") return [key, t];
    const whole = t.match(/^\{([^{}]+)\}$/);
    return [key, whole ? getPath(ctx, whole[1].trim()) ?? null : fillTemplate(t, ctx)];
  }));
}

const filled = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";

/**
 * Creates one note in `folder` for a saved row: named by `name:` (else the row's name, its title,
 * or the time), with the row as its frontmatter and the `template:` note's body, filled, as its
 * text. Undefined when the note already exists, which is never overwritten.
 */
async function saveNote(p: Panel, folder: string, saved: Row, ctx: Row, deps: ActionDeps): Promise<string | undefined> {
  const template = p.name ?? (filled(ctx.name) ? "{name}" : filled(ctx.title) ? "{title}" : "");
  const at = String(saved.at);
  const name = fileName(template ? fillLine(template, ctx) : "") || at.replace("T", " ").replace(":", ".");
  // A row's name that only names the file isn't kept as a property too; nor is anything that would make the note run.
  const frontmatter = withoutDefinition(template === "{name}" ? Object.fromEntries(Object.entries(saved).filter(([k]) => k !== "name")) : saved);
  const body = p.template ? fillBody(await deps.readBody(p.template), ctx) : "";
  const path = `${folder ? `${folder}/` : ""}${name}.md`;
  if (await deps.createNote(path, frontmatter, body)) return path;
  deps.notify(`“${name}” already exists`);
  return undefined;
}

/**
 * Runs a panel's actions with one row (a form's values, a list's row, a button's empty row): append
 * a line, save the row (to a list, or as a new note), notify, then open a note. `{placeholders}` in
 * them read the row, the saved row and `date`, `time`, `at`; after a save to a folder, `{path}` is
 * the new note. Failures are notified, never thrown.
 */
export async function runActions(p: Panel, input: Row, deps: ActionDeps): Promise<ActionResult> {
  const stamp = stampParts(deps.now());
  const row = p.row ? fillRow(p.row, { ...stamp, ...input }) : input;
  const saved: Row = { ...Object.fromEntries(Object.entries(row)), at: stamp.at };
  const ctx: Row = { ...stamp, ...input, ...row };
  const target = p.target ?? (p.save ? saveTarget(p.save) : undefined);
  let path: string | undefined;
  try {
    if (p.append) {
      // The row's values are added after filling, so they are never read as placeholders themselves.
      const fields = Object.entries(row).map(([k, v]) => `${k}: ${oneLine(String(v))}`).join(", ");
      const line = p.line !== undefined ? fillLine(p.line, ctx) : `${fillLine("- {date} {time}", ctx)}${fields ? ` ${fields}` : ""}`;
      await deps.appendLine(notePath(p.append), line);
    }
    if (target?.kind === "list") {
      await deps.writeFrontmatter(deps.dataPath, (fm) => {
        const list = fm[target.name];
        fm[target.name] = Array.isArray(list) ? [...list, saved] : [saved];
      });
    } else if (target?.kind === "folder") {
      path = await saveNote(p, target.folder, saved, ctx, deps);
      if (!path) return { ok: false };
      ctx.path = path;
    }
    if (p.notify) deps.notify(fillLine(p.notify, ctx));
    if (p.open) deps.openNote(fillLine(p.open, ctx), deps.appPath);
    return { ok: true, path };
  } catch (e) {
    deps.notify(`Couldn't save: ${(e as Error).message}`);
    return { ok: false };
  }
}
