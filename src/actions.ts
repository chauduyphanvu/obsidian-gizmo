import { fillTemplate, getPath, stampParts, type Row } from "./data.ts";
import { notePath, saveTarget, type Panel } from "./spec.ts";

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

/** A note's text after its frontmatter block. */
export function bodyOf(text: string): string {
  const m = text.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/);
  return m ? text.slice(m[0].length) : text;
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
  const name = fileName(template ? fillTemplate(template, ctx) : "") || at.replace("T", " ").replace(":", ".");
  // A row's name that only names the file isn't kept as a property too.
  const frontmatter = template === "{name}" ? Object.fromEntries(Object.entries(saved).filter(([k]) => k !== "name")) : saved;
  const body = p.template ? fillTemplate(await deps.readBody(p.template), ctx) : "";
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
      const fields = Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(", ");
      const line = fillTemplate(p.line ?? `- {date} {time}${fields ? ` ${fields}` : ""}`, ctx);
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
    if (p.notify) deps.notify(fillTemplate(p.notify, ctx));
    if (p.open) deps.openNote(fillTemplate(p.open, ctx), deps.appPath);
    return { ok: true, path };
  } catch (e) {
    deps.notify(`Couldn't save: ${(e as Error).message}`);
    return { ok: false };
  }
}
