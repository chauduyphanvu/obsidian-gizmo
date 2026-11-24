/**
 * Lines are rows: a capture line run in a note (`;; spend 14.5 food lunch`) stays in the note as
 * the row it saved, `✓ spend 14.5 food lunch ^gz-<row id>`. The sentence and the row are one thing
 * from then on. Editing the sentence sets the row's fields, deleting it takes the row out, and a
 * change to the row made anywhere else writes the sentence again. The block id at the end of the
 * line is the row's id, so the pairing rides with the note through any sync.
 */
import { parseLine, tokenize, type CaptureIndex, type CaptureTarget } from "./capture.ts";
import type { Row } from "./data.ts";
import { rowIdOf } from "./ledger-store.ts";
import { formRow } from "./links.ts";
import type { Panel } from "./spec.ts";
import { textOf } from "./text.ts";
import { stampOf, stampParts, wallTime } from "./time.ts";
import { asField } from "./units.ts";

const ROW_LINE = /^(\s*)([✓✗]) (.+?)\s+\^gz-([0-9a-f]{16})\s*$/;

/** A row's line in a note: its indent, whether its row is still there (✓) or was taken out (✗), the capture line, and the row's id. */
export interface RowLine {
  indent: string;
  live: boolean;
  line: string;
  id: string;
}

export function readRowLine(text: string): RowLine | undefined {
  const m = ROW_LINE.exec(text);
  return m ? { indent: m[1], live: m[2] === "✓", line: m[3], id: m[4] } : undefined;
}

export function rowLineText(r: RowLine): string {
  return `${r.indent}${r.live ? "✓" : "✗"} ${r.line} ^gz-${r.id}`;
}

/** Every row line in a note's text, with the number of the line it is on (from 0). Lines in a code block aren't rows. */
export function rowLinesIn(text: string): (RowLine & { at: number })[] {
  const out: (RowLine & { at: number })[] = [];
  let fence = false;
  text.split("\n").forEach((line, at) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const r = fence ? undefined : readRowLine(line);
    if (r) out.push({ ...r, at });
  });
  return out;
}

/** A capture line whose `@when` is said in words (`@yday`) with the time it meant when it ran, so reading it on another day gives the same time. */
export function frozen(line: string, at: Date | undefined): string {
  const tokens = tokenize(line);
  if (at === undefined || !Array.isArray(tokens)) return line;
  const i = tokens.findLastIndex((t) => !t.quoted && t.name === undefined && t.text.startsWith("@"));
  if (i < 0) return line;
  // The text up to the last word that starts with @, then the time as a date and a clock.
  const cut = line.lastIndexOf(tokens[i].text);
  const p = stampParts(at);
  return `${line.slice(0, cut).trimEnd()} @${p.date} ${p.time}`;
}

const quoted = (v: string) => (/\s/.test(v) || v === "" ? `"${v.replace(/"/g, "'")}"` : v);

/**
 * A row as the capture line that would save it: the name, then each field's value in the order the
 * form has them. The last text field is written as it is; a value with a space elsewhere is in
 * quotes; once a field is empty, the fields after it are given by name.
 */
export function lineOfRow(target: Pick<CaptureTarget, "name" | "fields">, row: Row, when?: string): string {
  const words = [target.name];
  let byName = false;
  const filled = target.fields.map(([name]) => [name, row[name]] as const);
  filled.forEach(([name, v], i) => {
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      byName = true;
      return;
    }
    const text = typeof v === "boolean" ? (v ? "yes" : "no") : textOf(v);
    const last = i === filled.length - 1 || filled.slice(i + 1).every(([, later]) => later === undefined || later === null || later === "");
    const type = target.fields[i][1];
    if (byName) words.push(`${name}=${quoted(text)}`);
    else words.push(last && (type === "text" || type === "textarea") && !text.startsWith("@") ? text : quoted(text));
  });
  return `${words.join(" ")}${when ? ` @${when}` : ""}`;
}

/** Where the rows a form's shortcut saves are kept, and what its fields say besides their types. */
export interface RowHome {
  dataPath: string;
  list: string;
  /** The note that owns the rows: the kind's, or the app's. */
  owner: string;
  info?: Panel["fieldInfo"];
}

/** What a row line's text says its row should hold: the fields it gives, as their types read them, and its time when it says one. */
export type LineRead =
  | { ok: true; target: CaptureTarget; values: Row; at?: string }
  | { ok: false; error: string };

export function readLine(line: string, index: CaptureIndex, home: (t: CaptureTarget) => RowHome | undefined, now: Date): LineRead {
  const parsed = parseLine(line, index, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.target.view !== "form") return { ok: false, error: `${parsed.target.name} saves no row with fields` };
  if (parsed.plan && parsed.plan.length > 1) return { ok: false, error: "a line that plans several rows isn't one row" };
  const { at: _at, ...params } = parsed.params ?? {};
  const given = parsed.target.fields.filter(([n]) => Object.hasOwn(params, n));
  const read = formRow(Object.fromEntries(given), home(parsed.target)?.info, params, now);
  if ("error" in read) return { ok: false, error: read.error };
  return { ok: true, target: parsed.target, values: read.row, ...(parsed.at && { at: stampOf(parsed.at) }) };
}

/** Whether a line's value is what its row holds: nothing typed is an empty field, and a number typed is the number kept. */
const same = (a: unknown, b: unknown) => a === b || textOf(a ?? "") === textOf(b ?? "");

/** A time's minute by the clock where it was saved, which is what a line says, wherever it is read. */
const minuteOf = (t: unknown) => {
  const wall = wallTime(t);
  return wall === undefined ? undefined : Math.floor(wall / 60_000);
};

/** The fields a line gives that its row holds differently: each with the value the line gives. A time counts when it names another minute. */
export function lineChanges(read: Extract<LineRead, { ok: true }>, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // The line still says the quantity its row was typed as: the row keeps the rate of that day.
  const asTyped = (f: string) => {
    const [line, kept] = [read.values[asField(f)], row[asField(f)]];
    return typeof line === "string" && typeof kept === "string" && line.split(" @")[0] === kept.split(" @")[0];
  };
  for (const [f, v] of Object.entries(read.values)) {
    if (asTyped(f) || (f.endsWith("_as") && asTyped(f.slice(0, -3)))) continue;
    if (!same(v, row[f])) out[f] = v;
  }
  // A new number with no unit: what the old one was typed as no longer describes it.
  for (const f of Object.keys(out)) if (!Object.hasOwn(read.values, asField(f)) && row[asField(f)] !== undefined) out[asField(f)] = undefined;
  if (read.at !== undefined && minuteOf(read.at) !== minuteOf(row.at)) out.at = read.at;
  return out;
}

/**
 * What an edit of a line sets in its row: what the line gives differently from the row and says
 * differently from before. A line can be behind its row, which changed while the note wasn't open,
 * and the words the edit didn't touch mustn't put the row back.
 */
export function lineEdits(was: LineRead, read: Extract<LineRead, { ok: true }>, row: Row): Record<string, unknown> {
  const changes = lineChanges(read, row);
  if (!was.ok) return changes;
  const moved = (f: string) => !same(was.values[f], read.values[f]);
  return Object.fromEntries(Object.entries(changes).filter(([f]) => (
    f === "at" ? minuteOf(was.at) !== minuteOf(read.at) : moved(f) || (f.endsWith("_as") && moved(f.slice(0, -3)))
  )));
}

/** What the sync needs of the vault and the ledger. */
export interface RowLinesDeps {
  now(): Date;
  index(): CaptureIndex;
  home(path: string, shortcut: string): RowHome | undefined;
  /** A list's rows as they are now, each with its id. */
  rows(dataPath: string, list: string): Promise<Row[]>;
  /** Sets fields of a row, as one change in the activity, said to come from the note. */
  set(home: RowHome, row: Row, changes: Record<string, unknown>, note: string): Promise<void>;
  /** Takes a row out, as one change in the activity; gives how to put it back. */
  remove(home: RowHome, row: Row, note: string): Promise<(() => Promise<void>) | undefined>;
  /** Whether a note other than this one holds this row's line. */
  heldElsewhere(id: string, path: string): boolean;
}

/** What an edit of a note did to rows, for a notice. */
export interface Synced {
  set: { line: string; fields: string[] }[];
  removed: string[];
  /** Lines edited into something that can't be read: their rows are left as they are. */
  unread: { line: string; error: string }[];
  /** Lines that came back, here or in another note, and brought back the row they took out. */
  restored?: string[];
}

/**
 * Keeps what each open note's row lines said last, and tells an edit from a row that changed
 * elsewhere by which side moved: after an edit in a note, the note's lines are right and their rows
 * follow; after a change to the rows, the rows are right and the lines follow.
 */
export class RowLines {
  private deps: RowLinesDeps;
  /** By note: each row line as last seen, by row id. */
  private known = new Map<string, Map<string, RowLine>>();
  /** Rows taken out with their line, and how to put each back: a line cut from one note can land in another later. */
  private taken = new Map<string, () => Promise<void>>();

  constructor(deps: RowLinesDeps) {
    this.deps = deps;
  }

  /** A note was opened, or written by Gizmo: its lines are taken as they are, with nothing done about them. */
  seen(path: string, text: string): void {
    const lines = rowLinesIn(text);
    if (lines.length) this.known.set(path, new Map(lines.map((l) => [l.id, l])));
    else this.known.delete(path);
  }

  renamed(from: string, to: string): void {
    const lines = this.known.get(from);
    if (!lines) return;
    this.known.delete(from);
    this.known.set(to, lines);
  }

  /** The notes with row lines among those seen, and the data notes their rows are in. */
  notes(): string[] {
    return [...this.known.keys()];
  }

  private homeOf(target: CaptureTarget): RowHome | undefined {
    return this.deps.home(target.path, target.shortcut);
  }

  /** The line a row should have where what it says differs from the row; undefined where they agree. */
  private lineFor(read: Extract<LineRead, { ok: true }>, row: Row): string | undefined {
    if (!Object.keys(lineChanges(read, row)).length) return undefined;
    // A line that says a time keeps saying one, as the row has it now, by the clock where it was saved.
    const t = wallTime(row.at);
    const when = read.at !== undefined && t !== undefined ? `${stampParts(new Date(t)).date} ${stampParts(new Date(t)).time}` : undefined;
    const line = lineOfRow(read.target, row, when);
    // A value with a line break can't be said on one line: written, it would split the row line in two.
    return /[\r\n]/.test(line) ? undefined : line;
  }

  private async rowOf(home: RowHome, id: string): Promise<Row | undefined> {
    return (await this.deps.rows(home.dataPath, home.list)).find((r) => rowIdOf(r) === id);
  }

  /**
   * A note was edited by the person: each row line whose text changed sets its row's fields to what
   * it says now; each one that is gone takes its row out, unless another note holds it. A line that
   * was never seen (pasted in, or the note wasn't open before) is only taken note of, or puts back the
   * row it took out when it left. A line that can't be read leaves its row alone.
   */
  async edited(path: string, text: string): Promise<Synced> {
    const out: Synced = { set: [], removed: [], unread: [] };
    const before = this.known.get(path);
    const now = rowLinesIn(text);
    this.seen(path, text);
    for (const l of now) {
      const back = l.live && !before?.has(l.id) ? this.taken.get(l.id) : undefined;
      if (!back) continue;
      this.taken.delete(l.id);
      await back();
      (out.restored ??= []).push(l.line);
    }
    if (!before) return out;
    const here = new Map(now.map((l) => [l.id, l]));
    const read = (line: string) => readLine(line, this.deps.index(), (t) => this.homeOf(t), this.deps.now());
    for (const [id, was] of before) {
      const l = here.get(id);
      if (l && (l.line === was.line || !l.live)) continue;
      // The home of a line that is gone is read from what it said last.
      const r = read((l ?? was).line);
      if (!r.ok) {
        if (l) out.unread.push({ line: l.line, error: r.error });
        continue;
      }
      const home = this.homeOf(r.target);
      const row = home && (await this.rowOf(home, id));
      if (!home || !row) continue;
      if (!l) {
        if (was.live && !this.deps.heldElsewhere(id, path)) {
          const back = await this.deps.remove(home, row, path);
          if (back) this.taken.set(id, back);
          out.removed.push(was.line);
        }
        continue;
      }
      const changes = lineEdits(read(was.line), r, row);
      if (!Object.keys(changes).length) continue;
      await this.deps.set(home, row, changes, path);
      out.set.push({ line: l.line, fields: Object.keys(changes) });
    }
    return out;
  }

  /**
   * Rows changed somewhere else (an app, another line): a note's text with each row line written
   * again from its row where the two differ, a line whose row is gone marked ✗, and one whose row
   * came back marked ✓. Undefined when nothing in the note needs to change. `only`: the data notes
   * whose rows changed; lines of other rows are left.
   */
  async rewritten(path: string, text: string, only?: ReadonlySet<string>): Promise<string | undefined> {
    const lines = text.split("\n");
    let changed = false;
    for (const l of rowLinesIn(text)) {
      const r = readLine(l.line, this.deps.index(), (t) => this.homeOf(t), this.deps.now());
      if (!r.ok) continue;
      const home = this.homeOf(r.target);
      if (!home || (only && !only.has(home.dataPath))) continue;
      const row = await this.rowOf(home, l.id);
      const written = rowLineText(row ? { ...l, live: true, line: this.lineFor(r, row) ?? l.line } : { ...l, live: false });
      if (written === lines[l.at]) continue;
      lines[l.at] = written;
      changed = true;
    }
    if (!changed) return undefined;
    const out = lines.join("\n");
    this.seen(path, out);
    return out;
  }
}
