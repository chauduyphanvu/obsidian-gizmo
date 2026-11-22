import { textOf } from "./text.ts";
import { refusal, type Expectation } from "./expect.ts";
import { textHash, type Change } from "./activity.ts";
import { fillTemplate, fillWith, formatValue, getPath, type Row } from "./data.ts";
import { stampOf, stampParts } from "./time.ts";
import { saveTarget, type Panel } from "./spec.ts";
import { appendPath, basename, withoutDefinition } from "./store.ts";
import { frontmatterStore, type DataStore } from "./datastore.ts";
import { startOf } from "./keys.ts";

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
  /** Where the app's lists are written; without one, rows go straight into the data note's properties. */
  store?: DataStore;
  /** The id a row this run saves gets, so the same run made twice (a then that fires on two devices) saves it once. */
  rowId?: string;
  /** When what the run saves is logged for, when that isn't now: a line's `@yday`, a link's `at=`. */
  at?: Date;
  /** The app's rules under `expect:`; a row that breaks a value rule isn't saved. */
  expect?: readonly Expectation[];
  /** Adds a line at the end of a note, creating it when there's none; true when it created it. */
  appendLine(path: string, line: string): Promise<boolean | void>;
  /** Creates a note; its text (or true), or false, writing nothing, when one is already at that path. */
  createNote(path: string, frontmatter: Record<string, unknown>, body: string): Promise<string | boolean>;
  /** The text after the frontmatter of the note a link or path names. */
  readBody(path: string): Promise<string>;
  notify(message: string): void;
  openNote(path: string, fromPath: string): void;
  /** Keeps what a run changed in the activity log, named as the panel is; may give the entry's id once kept. */
  log?(what: string, changes: Change[]): Promise<string | undefined> | void;
  /** Runs the panel's `then` once its own actions are done, with the row they ran with; never rejects. */
  then?(p: Panel, ctx: Row): Promise<void>;
  /** The caller tells the panel's `notify` itself, so it gets the text back (see ActionResult.told). */
  inPlace?: boolean;
  /** The panel's `notify` isn't also sent to `notify`. */
  quiet?: boolean;
  /** The caller says why a run failed itself, from ActionResult.error, so it isn't also sent to `notify`. */
  tellsFailure?: boolean;
}

/** What an app gives runActions to write and tell with. */
export type ActionIO = Pick<ActionDeps, "now" | "writeFrontmatter" | "appendLine" | "createNote" | "readBody" | "notify" | "openNote"> & {
  /** Where an app's lists are kept, by its data note. */
  store?(dataPath: string, appPath: string): DataStore;
  /** Changes an existing note's frontmatter; false, writing nothing, when the note is gone. */
  updateFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<boolean>;
  /** Ticks or unticks a task; false, writing nothing, when it can't be found for sure. */
  setTaskDone(path: string, line: number, text: string, done: boolean): Promise<boolean>;
};

/** The deps an app's actions run with, through `io`; the caller adds `log` and `then`. */
export function actionDepsOf(io: ActionIO, appPath: string, dataPath: string): ActionDeps {
  return {
    now: () => io.now(), dataPath, appPath,
    store: io.store?.(dataPath, appPath),
    writeFrontmatter: (path, fn) => io.writeFrontmatter(path, fn),
    appendLine: (path, line) => io.appendLine(path, line),
    createNote: (path, fm, body) => io.createNote(path, fm, body),
    readBody: (path) => io.readBody(path),
    notify: (message) => io.notify(message),
    openNote: (path, from) => io.openNote(path, from),
  };
}

/** How a run went: `ok` is false, with its `error`, when it stopped. */
export interface ActionResult {
  ok: boolean;
  /** The note a save to a folder created. */
  path?: string;
  /** The activity log's entry for what it changed, once kept; undefined when it changed nothing. */
  logged?: Promise<string | undefined>;
  /** A checklist item that was already ticked, so nothing changed. */
  already?: boolean;
  /** Why it stopped: a value rule refused the row, the note it would make already exists, or a write failed. */
  error?: string;
  /**
   * When it stopped after writing part of what it does: what it wrote and what it then couldn't do
   * ("Added the line to Daily, but couldn't save the row"). What it wrote is in `logged`, to undo.
   */
  partly?: string;
  /** With `inPlace`, the panel's `notify`, filled from the run, for the caller to tell. */
  told?: string;
}

/** Where a run writes the app's lists: its store, else the data note's properties. */
export function storeOf(deps: ActionDeps): DataStore {
  return deps.store ?? frontmatterStore(deps.dataPath, (path, fn) => deps.writeFrontmatter(path, fn), () => undefined);
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

const filled = (v: unknown) => v !== undefined && v !== null && textOf(v).trim() !== "";

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
 * text. A note that already exists is never overwritten: that is the error instead.
 */
async function saveNote(p: Panel, folder: string, saved: Row, ctx: Row, deps: ActionDeps, changes: Change[]): Promise<{ path: string } | { error: string }> {
  const template = p.name ?? (filled(ctx.name) ? "{name}" : filled(ctx.title) ? "{title}" : "");
  const name = fileName(template ? fillLine(template, ctx) : "") || `${textOf(ctx.date)} ${textOf(ctx.time).replace(":", ".")}`;
  // A row's name that only names the file isn't kept as a property too; nor is anything that would make the note run.
  const frontmatter = withoutDefinition(template === "{name}" ? Object.fromEntries(Object.entries(saved).filter(([k]) => k !== "name")) : saved);
  const body = p.template ? fillBody(await deps.readBody(p.template), ctx) : "";
  const path = `${folder ? `${folder}/` : ""}${name}.md`;
  const made = await deps.createNote(path, frontmatter, body);
  if (made === false) return { error: `“${name}” already exists` };
  if (typeof made === "string") changes.push({ kind: "note-created", path, hash: textHash(made) });
  return { path };
}

/** A run that stopped, said in a notice unless the caller says it. */
function stopped(deps: ActionDeps, error: string, notice = error): ActionResult {
  if (!deps.tellsFailure) deps.notify(notice);
  return { ok: false, error };
}

/** What a run wrote before it stopped, then what it was `doing`: "Added the line to Daily, but couldn't save the row". */
function partlyDone(changes: readonly Change[], doing: string): string {
  const wrote = changes.map((c) =>
    c.kind === "line-added" ? `added the line to ${basename(c.path)}`
    : c.kind === "row-added" ? `saved the row to ${c.list}`
    : `created ${basename(c.path)}`).join(" and ");
  return `${wrote.charAt(0).toUpperCase()}${wrote.slice(1)}, but couldn't ${doing}`;
}

/**
 * Ticks one item of a checklist panel in the app's data note, as ticking its box does; an item
 * already ticked stays so and nothing is kept in the activity log.
 */
export async function tickItem(p: Panel, item: string, deps: ActionDeps): Promise<ActionResult> {
  const list = p.save ?? "checked";
  let ticked: { event?: string } | undefined;
  try {
    ticked = await storeOf(deps).tick(list, item);
  } catch (e) {
    const message = (e as Error).message;
    return stopped(deps, message, `Couldn't save: ${message}`);
  }
  if (!ticked) return { ok: true, already: true };
  const logged = deps.log?.(p.title ?? p.label ?? list, [{ kind: "checklist", path: deps.dataPath, list, item, checked: true, ...(ticked.event && { event: ticked.event }) }]);
  return { ok: true, ...(logged && { logged }) };
}

/**
 * Runs a panel's actions with one row (a form's values, a list's row, a button's empty row): append
 * a line, save the row (to a list, or as a new note), notify, then open a note. `{placeholders}` in
 * them read the row, the saved row and `date`, `time`, `at` (now, or `deps.at`, which the row is
 * stamped with too); after a save to a folder, `{path}` is the new note. A failure is given as the
 * result's error and notified (unless `tellsFailure`), never thrown.
 */
export async function runActions(p: Panel, input: Row, deps: ActionDeps): Promise<ActionResult> {
  const when = deps.at ?? deps.now();
  // `date` and `time` as typed in notes; `at`, what the row is stamped with, carries its offset.
  const stamp = { ...stampParts(when), at: stampOf(when) };
  const unshown = p.view === "form" ? defaultsBeyond(p, when) : {};
  const given = p.row ? fillRow(p.row, { ...stamp, ...unshown, ...input }) : input;
  // What `row` (or the form) gives wins key by key; the defaults come after it.
  const row = { ...given, ...Object.fromEntries(Object.entries(unshown).filter(([k]) => !Object.hasOwn(given, k))) };
  const saved: Row = { ...Object.fromEntries(Object.entries(row)), at: stamp.at };
  const ctx: Row = { ...stamp, ...input, ...row };
  const target = p.target ?? (p.save ? saveTarget(p.save) : undefined);
  let path: string | undefined;
  const changes: Change[] = [];
  let logged: Promise<string | undefined> | undefined;
  let kept = false;
  const log = () => {
    if (kept || !changes.length) return;
    kept = true;
    // A form's title says what it's for better than its button's label; a button has only its label.
    logged = deps.log?.(p.title ?? p.label ?? p.view, changes) ?? undefined;
  };
  // The step under way, for saying what was left undone when a run stops after writing something.
  let doing = "finish";
  /** Stops the run; after a write, says what it wrote, which is logged to undo, and what it couldn't do. */
  const stop = (error: string, notice: string): ActionResult => {
    if (!changes.length) return stopped(deps, error, notice);
    const partly = partlyDone(changes, doing);
    log();
    if (!deps.tellsFailure) deps.notify(`${partly}: ${error}`);
    return { ok: false, error, partly, ...(logged && { logged }) };
  };
  try {
    // A row its rules refuse is refused before anything is written, the line it appends included.
    if (target?.kind === "list") {
      const refused = refusal(deps.expect ?? [], target.name, saved, deps.now());
      if (refused) return stop(refused, `Not saved: ${refused}`);
    }
    if (p.append) {
      // The row's values are added after filling, so they are never read as placeholders themselves.
      const fields = Object.entries(row).map(([k, v]) => `${k}: ${oneLine(String(v))}`).join(", ");
      const line = p.line !== undefined ? fillLine(p.line, ctx) : `${fillLine("- {date} {time}", ctx)}${fields ? ` ${fields}` : ""}`;
      const into = appendPath(p.append);
      const created = await deps.appendLine(into, line);
      changes.push({ kind: "line-added", path: into, line, created: created === true });
    }
    if (target?.kind === "list") {
      doing = "save the row";
      const { event, already } = await storeOf(deps).add(target.name, saved, deps.rowId ? { id: deps.rowId } : undefined);
      // Another runner already saved this very row: nothing was written here.
      if (!already) changes.push({ kind: "row-added", path: deps.dataPath, list: target.name, row: saved, ...(event && { event }) });
    } else if (target?.kind === "folder") {
      doing = "create the note";
      const made = await saveNote(p, target.folder, saved, ctx, deps, changes);
      if ("error" in made) return stop(made.error, made.error);
      path = made.path;
      ctx.path = path;
    }
    doing = "finish";
    const told = p.notify === undefined ? undefined : fillLine(p.notify, ctx);
    if (told !== undefined && !deps.quiet) deps.notify(told);
    const tell = deps.inPlace && told !== undefined ? { told } : {};
    if (p.open) deps.openNote(fillLine(p.open, ctx), deps.appPath);
    // Kept before what `then` runs is, in the order they happened.
    log();
    if (p.then) await deps.then?.(p, ctx);
    return { ok: true, path, ...(logged && { logged }), ...tell };
  } catch (e) {
    const message = (e as Error).message;
    return stop(message, `Couldn't save: ${message}`);
  } finally {
    // What was written before a failure is kept too, so it can be undone.
    log();
  }
}
