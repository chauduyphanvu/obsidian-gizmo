import { textHash, type Change } from "./activity.ts";
import { fillTemplate, fillWith, formatValue, getPath, stampParts, type Row } from "./data.ts";
import { saveTarget, type Panel } from "./spec.ts";
import { notePath, withoutDefinition } from "./store.ts";
import { startOf } from "./keys.ts";

/**
 * What running a panel's actions needs, and nothing more: an open app passes its env; something
 * running a panel without opening its app (a shortcut) passes its own.
 */
export interface ActionDeps {
  now(): Date;
  /** The app's data note, where lists are saved; with `devices: split`, this device's own note. */
  dataPath: string;
  /** Properties the note rows are saved to must carry: a device's note says which device it is. */
  stamp?: Record<string, unknown>;
  /** The app note: links in `open` resolve from it. */
  appPath: string;
  writeFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  /** Adds a line at the end of a note, creating it when there's none; true when it created it. */
  appendLine(path: string, line: string): Promise<boolean | void>;
  /** Creates a note; its text (or true), or false, writing nothing, when one is already at that path. */
  createNote(path: string, frontmatter: Record<string, unknown>, body: string): Promise<string | boolean>;
  /** The text after the frontmatter of the note a link or path names. */
  readBody(path: string): Promise<string>;
  notify(message: string): void;
  openNote(path: string, fromPath: string): void;
  /** Keeps what a run changed in the activity log, named as the panel is. */
  log?(what: string, changes: Change[]): void;
  /** Runs the panel's `then` once its own actions are done, with the row they ran with; never rejects. */
  then?(p: Panel, ctx: Row): Promise<void>;
}

/** What an app gives runActions to write and tell with. */
export type ActionIO = Pick<ActionDeps, "now" | "writeFrontmatter" | "appendLine" | "createNote" | "readBody" | "notify" | "openNote">;

/** The deps an app's actions run with, through `io`; the caller adds `log` and `then`. */
export function actionDepsOf(io: ActionIO, appPath: string, dataPath: string): ActionDeps {
  return {
    now: () => io.now(), dataPath, appPath,
    writeFrontmatter: (path, fn) => io.writeFrontmatter(path, fn),
    appendLine: (path, line) => io.appendLine(path, line),
    createNote: (path, fm, body) => io.createNote(path, fm, body),
    readBody: (path) => io.readBody(path),
    notify: (message) => io.notify(message),
    openNote: (path, from) => io.openNote(path, from),
  };
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
export function fillLine(template: string, ctx: Row): string {
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

/** The schema's fields with a `default` that a form doesn't show, each with its value now: saved beside the form's own. */
function defaultsBeyond(p: Panel, now: Date): Row {
  const shown = p.fields ?? p.schema ?? {};
  return Object.fromEntries(Object.entries(p.fieldInfo ?? {})
    .filter(([name, info]) => info.default !== undefined && Object.hasOwn(p.schema ?? {}, name) && !Object.hasOwn(shown, name))
    .map(([name, info]) => [name, startOf(info, now)]));
}

/**
 * Creates one note in `folder` for a saved row: named by `name:` (else the row's name, its title,
 * or the time), with the row as its frontmatter and the `template:` note's body, filled, as its
 * text. Undefined when the note already exists, which is never overwritten.
 */
async function saveNote(p: Panel, folder: string, saved: Row, ctx: Row, deps: ActionDeps, changes: Change[]): Promise<string | undefined> {
  const template = p.name ?? (filled(ctx.name) ? "{name}" : filled(ctx.title) ? "{title}" : "");
  const at = String(saved.at);
  const name = fileName(template ? fillLine(template, ctx) : "") || at.replace("T", " ").replace(":", ".");
  // A row's name that only names the file isn't kept as a property too; nor is anything that would make the note run.
  const frontmatter = withoutDefinition(template === "{name}" ? Object.fromEntries(Object.entries(saved).filter(([k]) => k !== "name")) : saved);
  const body = p.template ? fillBody(await deps.readBody(p.template), ctx) : "";
  const path = `${folder ? `${folder}/` : ""}${name}.md`;
  const made = await deps.createNote(path, frontmatter, body);
  if (made !== false) {
    if (typeof made === "string") changes.push({ kind: "note-created", path, hash: textHash(made) });
    return path;
  }
  deps.notify(`“${name}” already exists`);
  return undefined;
}

/**
 * Ticks one item of a checklist panel in the app's data note, as ticking its box does; an item
 * already ticked stays so and nothing is kept in the activity log.
 */
export async function tickItem(p: Panel, item: string, deps: ActionDeps): Promise<ActionResult> {
  const list = p.save ?? "checked";
  let ticked = false;
  try {
    await deps.writeFrontmatter(deps.dataPath, (fm) => {
      const had = Array.isArray(fm[list]) ? (fm[list] as unknown[]).map(String) : [];
      if (had.includes(item)) return;
      ticked = true;
      fm[list] = [...had, item];
    });
  } catch (e) {
    deps.notify(`Couldn't save: ${(e as Error).message}`);
    return { ok: false };
  }
  if (ticked) deps.log?.(p.title ?? p.label ?? list, [{ kind: "checklist", path: deps.dataPath, list, item, checked: true }]);
  return { ok: true };
}

/**
 * Runs a panel's actions with one row (a form's values, a list's row, a button's empty row): append
 * a line, save the row (to a list, or as a new note), notify, then open a note. `{placeholders}` in
 * them read the row, the saved row and `date`, `time`, `at`; after a save to a folder, `{path}` is
 * the new note. Failures are notified, never thrown.
 */
export async function runActions(p: Panel, input: Row, deps: ActionDeps): Promise<ActionResult> {
  const now = deps.now();
  const stamp = stampParts(now);
  const unshown = p.view === "form" ? defaultsBeyond(p, now) : {};
  const given = p.row ? fillRow(p.row, { ...stamp, ...unshown, ...input }) : input;
  // What `row` (or the form) gives wins key by key; the defaults come after it.
  const row = { ...given, ...Object.fromEntries(Object.entries(unshown).filter(([k]) => !Object.hasOwn(given, k))) };
  const saved: Row = { ...Object.fromEntries(Object.entries(row)), at: stamp.at };
  const ctx: Row = { ...stamp, ...input, ...row };
  const target = p.target ?? (p.save ? saveTarget(p.save) : undefined);
  let path: string | undefined;
  const changes: Change[] = [];
  let logged = false;
  const log = () => {
    if (logged || !changes.length) return;
    logged = true;
    // A form's title says what it's for better than its button's label; a button has only its label.
    deps.log?.(p.title ?? p.label ?? p.view, changes);
  };
  try {
    if (p.append) {
      // The row's values are added after filling, so they are never read as placeholders themselves.
      const fields = Object.entries(row).map(([k, v]) => `${k}: ${oneLine(String(v))}`).join(", ");
      const line = p.line !== undefined ? fillLine(p.line, ctx) : `${fillLine("- {date} {time}", ctx)}${fields ? ` ${fields}` : ""}`;
      const into = notePath(p.append);
      const created = await deps.appendLine(into, line);
      changes.push({ kind: "line-added", path: into, line, created: created === true });
    }
    if (target?.kind === "list") {
      await deps.writeFrontmatter(deps.dataPath, (fm) => {
        for (const [k, v] of Object.entries(deps.stamp ?? {})) fm[k] = v;
        const list = fm[target.name];
        fm[target.name] = Array.isArray(list) ? [...list, saved] : [saved];
      });
      changes.push({ kind: "row-added", path: deps.dataPath, list: target.name, row: saved });
    } else if (target?.kind === "folder") {
      path = await saveNote(p, target.folder, saved, ctx, deps, changes);
      if (!path) return { ok: false };
      ctx.path = path;
    }
    if (p.notify) deps.notify(fillLine(p.notify, ctx));
    if (p.open) deps.openNote(fillLine(p.open, ctx), deps.appPath);
    // Kept before what `then` runs is, in the order they happened.
    log();
    if (p.then) await deps.then?.(p, ctx);
    return { ok: true, path };
  } catch (e) {
    deps.notify(`Couldn't save: ${(e as Error).message}`);
    return { ok: false };
  } finally {
    // What was written before a failure is kept too, so it can be undone.
    log();
  }
}
