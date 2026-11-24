/**
 * What needs the person, across the vault, each answered with one key (the Next window, `source:
 * asks`): a rhythm's window that is open and not met yet, a window that was missed, a kind's planned
 * row whose time passed with nothing settling it, and a kind's rows read from a file that wait to be
 * checked. An ask lasts as long as its cause: a row in the window, the planned row settled or set
 * aside, the file's rows accepted, and it is gone.
 */
import { EXPECT_MISSED } from "./background-rhythms.ts";
import { MONTHS, dayText, logTime, parseLine, whenText, type CaptureIndex } from "./capture.ts";
import { matches, type Row } from "./data.ts";
import { metIn, plannedIn, windowAt, windowDay, type Rhythm, type Window } from "./expect.ts";
import { lineOf } from "./kind.ts";
import { rowIdOf } from "./ledger-store.ts";
import { reconcileOf, type MatchRule } from "./match.ts";
import type { Panel, PanelSpec } from "./spec.ts";
import { calendarOf, stampOf, stampParts, toTime } from "./time.ts";
import { textOf } from "./text.ts";

/** One thing that needs the person. */
export interface Ask {
  /** The same on every device and at every look while its cause lasts: what a skip is kept under. */
  id: string;
  /** The app or kind note it belongs to, and its name. */
  path: string;
  app: string;
  text: string;
  /** When it is or was due (ms): a window's deadline, a planned row's time. The queue goes oldest first. */
  due: number;
  answer: AskAnswer;
  /** What dismissing it for good changes; undefined when it can only be skipped. */
  dismiss?: RowChange;
  /** For a writer of a shared kind waiting to be accepted: dismissing refuses it. */
  refuse?: WriterDecision;
}

/**
 * How an ask is answered: a capture line to run (`cursor` is where typing goes, `ready` when it runs
 * as it stands), its note to open, or one change to a row.
 */
export type AskAnswer = { line: string; cursor: number; ready: boolean } | { open: true } | { change: RowChange } | { writer: WriterDecision };

/** Taking a writer's rows into a shared kind from now on (accept), or never again (refuse), with the rows it sent so far. */
export interface WriterDecision {
  writer: string;
  name: string;
  accept: boolean;
}

/** One field of a row in the ask's own data note set to a value (undefined takes it out), with what the activity log calls it. */
export interface RowChange {
  list: string;
  row: Row;
  field: string;
  value: unknown;
  what: string;
}

/** Where a list's rows are kept: the note that owns its data note, and the list's name. */
export interface Kept {
  owner: string;
  list: string;
}

/** The rows a rhythm counts, from the panel it is read as: a kind's, else the app's own list. */
export function countedIn(p: Panel, appPath: string): Kept | undefined {
  if (p.kind) return { owner: p.kind.path, list: p.kind.name };
  return p.source ? { owner: appPath, list: p.source } : undefined;
}

/** Where a form or button saves: a kind's rows, or a list of its own app's. */
function savedTo(p: Panel, appPath: string): Kept | undefined {
  return p.target?.kind === "list" ? { owner: p.target.at ?? appPath, list: p.target.name } : undefined;
}

/** The start of a capture line that answers a rhythm, with how the panel that saves is called. */
export interface RhythmLine {
  /** The name to type, and the values the rule's `where` gives. */
  words: string;
  /** A form with fields still to type. */
  more: boolean;
  /** A form with a field of its own called at, which `@` can't give a time to. */
  ownAt: boolean;
  label: string;
}

/**
 * The form or button with a name to type that saves rows a rhythm counts: one of its own app first,
 * then any other that saves to the same kind. Its row must be able to meet the rule's `where`: a
 * fixed `row` value that matches, or a choice, yes or no, or number typed as a value. Undefined when
 * none can, and the ask only opens the app.
 */
export function rhythmLine(
  rule: Rhythm, kept: Kept, self: string, apps: Iterable<{ path: string; shortcuts: ReadonlyMap<string, PanelSpec> }>, index: CaptureIndex, now: Date,
): RhythmLine | undefined {
  const ordered = [...apps].sort((a, b) => Number(b.path === self) - Number(a.path === self) || a.path.localeCompare(b.path));
  for (const app of ordered) {
    for (const [shortcut, ps] of app.shortcuts) {
      const p = ps.panel;
      const to = savedTo(p, app.path);
      if ((p.view !== "form" && p.view !== "button") || !to || to.owner !== kept.owner || to.list !== kept.list) continue;
      const values = valuesFor(rule.where, p, now);
      const name = values && nameOf(index, app.path, shortcut, p.alias);
      if (!values || name === undefined) continue;
      const fields = p.view === "form" ? p.fields ?? p.schema ?? {} : {};
      const given = new Set(Object.keys(rule.where ?? {}));
      return {
        words: [name, ...values].join(" "),
        more: Object.keys(fields).some((f) => !given.has(f) && !Object.hasOwn(p.row ?? {}, f)),
        ownAt: Object.hasOwn(fields, "at"),
        label: index.names.get(name)!.label,
      };
    }
  }
  return undefined;
}

/** The name a capture line types for a shortcut: its alias when that reaches it, else any name that does. */
function nameOf(index: CaptureIndex, path: string, shortcut: string, alias: string | undefined): string | undefined {
  const names = [...index.names].filter(([, t]) => t.path === path && t.shortcut === shortcut).map(([n]) => n);
  return names.find((n) => n === alias?.toLowerCase()) ?? names[0];
}

/**
 * The `name=value` words that make a panel's row meet a rule's `where`, or undefined when its row
 * can't: a condition is met by a fixed `row` value, or by a form's choice, yes or no, or number.
 */
function valuesFor(where: Rhythm["where"], p: Panel, now: Date): string[] | undefined {
  const fields = p.view === "form" ? p.fields ?? p.schema ?? {} : {};
  const out: string[] = [];
  for (const [field, cond] of Object.entries(where ?? {})) {
    if (p.row && Object.hasOwn(p.row, field)) {
      if (!matches(p.row[field], cond, now)) return undefined;
      continue;
    }
    const type = fields[field];
    const value = typeof cond === "boolean" && type === "checkbox" ? cond
      : typeof cond === "number" && type === "number" ? cond
      : typeof cond === "string" && Array.isArray(type) ? type.map(String).find((o) => o === cond)
      : undefined;
    if (value === undefined || !matches(value, cond, now)) return undefined;
    const text = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
    out.push(`${field}=${/\s/.test(text) ? `"${text}"` : text}`);
  }
  return out;
}

/**
 * The words after `@` that log a row inside a window, as the device reading them counts time: its
 * deadline, or the middle of the window when a clock change makes that moment read otherwise. A
 * date, not "yday", so the line means the same day whenever it runs.
 */
function whenIn(w: Window, now: Date): string | undefined {
  for (const t of [w.deadline, Math.floor((w.start + w.deadline) / 120_000) * 60_000]) {
    const { date, time } = stampParts(new Date(t));
    const read = logTime(`${date} ${time}`, now);
    if ("at" in read && read.at.getTime() >= w.start && read.at.getTime() <= w.deadline) return `${date} ${time}`;
  }
  return undefined;
}

/**
 * The capture line that answers a rhythm's window: the line's start, then for a window already past
 * a time inside it, so the row is counted there. Opening the app when no line can do that.
 */
export function rhythmAnswer(start: RhythmLine | undefined, w: Window | undefined, index: CaptureIndex, now: Date): AskAnswer {
  if (!start || (w && start.ownAt)) return { open: true };
  const when = w && whenIn(w, now);
  if (w && when === undefined) return { open: true };
  const gap = start.more ? " " : "";
  const line = `${start.words}${gap}${when ? ` @${when}` : ""}`;
  return { line, cursor: start.words.length + gap.length, ready: parseLine(line, index, now).ok };
}

/** A window as the misses name it, `2026-11-19`: the one starting that day where the person is. */
function windowOn(day: string, rule: Rhythm, zone: string | undefined): Window | undefined {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return windowAt(calendarOf(zone).at(y, m - 1, d, 12, 0), rule, zone);
}

/** A window in words: its day, its week, or its month. */
function windowText(day: string, rule: Rhythm, now: Date): string {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d, 12);
  if (rule.every === "month") return `${MONTHS[m - 1]} ${y}`;
  return rule.every === "week" ? `week of ${dayText(start, now)}` : dayText(start, now);
}

/** How many of a rule's latest misses are asked about, as the newest few are told. */
export const MISSES_ASKED = 3;

/**
 * A rhythm's asks: its window open now while nothing meets it, and each of its newest misses (kept in
 * `expect_missed`) that no row in its window met since and nobody acknowledged; none for a window a
 * planned row stands in for, whose own ask is the one asked (see plannedIn). `rows` are the rows it
 * counts and `planned` its kind's planned rows; `start` the capture line that saves one, if any.
 */
export function rhythmAsks(o: {
  path: string; app: string; rule: Rhythm; rows: readonly unknown[]; planned?: readonly unknown[]; missed: readonly Row[];
  start: RhythmLine | undefined; index: CaptureIndex; now: Date; zone?: string;
}): Ask[] {
  const { rule, now } = o;
  const doing = o.start?.label ?? rule.id;
  const id = (day: string) => `rhythm\n${o.path}\n${rule.id}\n${day}`;
  const out: Ask[] = [];
  const planned = o.planned ?? [];
  const open = windowAt(now.getTime(), rule, o.zone);
  if (now.getTime() < open.deadline && !metIn(o.rows, rule, open, now) && !plannedIn(planned, rule, open, now)) {
    const day = windowDay(open, o.zone);
    out.push({ id: id(day), path: o.path, app: o.app, text: `${doing}? by ${rule.byText}`, due: open.deadline, answer: rhythmAnswer(o.start, undefined, o.index, now) });
  }
  const days = [...new Set(o.missed.filter((r) => r.rule === rule.id && typeof r.window === "string").map((r) => r.window as string))].sort().reverse();
  for (const day of days.slice(0, MISSES_ASKED)) {
    const row = o.missed.find((r) => r.rule === rule.id && r.window === day)!;
    const w = windowOn(day, rule, o.zone);
    if (row.acknowledged === true || !w || metIn(o.rows, rule, w, now) || plannedIn(planned, rule, w, now)) continue;
    const said = rule.say ?? `${doing} wasn't done by ${rule.byText}`;
    out.push({
      id: id(day), path: o.path, app: o.app, text: `${said} (${windowText(day, rule, now)})`, due: w.deadline,
      answer: rhythmAnswer(o.start, w, o.index, now),
      dismiss: { list: EXPECT_MISSED, row, field: "acknowledged", value: true, what: `Acknowledged a miss of ${rule.id} (${day})` },
    });
  }
  return out;
}

/** A kind's row in a few words: its values in the order of its fields. */
function rowWords(row: Row, fields: readonly string[]): string {
  const words = fields.filter((f) => f !== "at").map((f) => row[f]).filter((v) => v !== undefined && v !== null && v !== "").map(textOf);
  return words.join(" ") || "a planned row";
}

const settled = (row: Row) => row.matched !== undefined && row.matched !== null && row.matched !== "";

/** A kind's planned rows whose time passed, none of them settled by a row logged since: did each happen? */
export function plannedAsks(o: { path: string; app: string; list: string; fields: readonly string[]; rows: readonly Row[]; now: Date }): Ask[] {
  return o.rows.flatMap((row): Ask[] => {
    const t = toTime(row.at);
    const id = rowIdOf(row);
    if (lineOf(row) !== "planned" || settled(row) || t === undefined || t > o.now.getTime() || id === undefined) return [];
    const words = rowWords(row, o.fields);
    return [{
      id: `planned\n${o.path}\n${id}`, path: o.path, app: o.app, due: t,
      text: `${words}, planned ${whenText(new Date(t), o.now)}: did it happen?`,
      answer: { change: { list: o.list, row, field: "line", value: undefined, what: `Marked as happened: ${words}` } },
      dismiss: { list: o.list, row, field: "line", value: "dismissed", what: `Set aside a planned row: ${words}` },
    }];
  });
}

/** A kind's rows read from a file that nobody accepted or set aside yet: one ask for all of them, answered in the kind's note. */
export function fileRowsAsks(o: { path: string; app: string; rows: readonly Row[]; rule: MatchRule }): Ask[] {
  const r = reconcileOf(o.rows, o.rule);
  if (!r) return [];
  const n = r.open.length;
  const times = r.open.map((x) => toTime(x.row.at)).filter((t): t is number => t !== undefined);
  return [{ id: `file\n${o.path}`, path: o.path, app: o.app, text: `${n} ${n === 1 ? "row" : "rows"} from a file to check in ${o.app}`, due: times.length ? Math.min(...times) : 0, answer: { open: true } }];
}

/** A name as it reads at a glance: case, accents, spaces and punctuation aside. */
const glance = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Letters of Latin together with Cyrillic or Greek, whose letters pass for Latin ones. */
const mixesAlphabets = (name: string) => /\p{Script=Latin}/u.test(name) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(name);

/**
 * What an ask says of a waiting writer's key: its first characters, always, and when its name
 * reads like one known here under another key, or mixes alphabets as a look-alike does, that too.
 */
function keyNote(name: string, writer: string, known: ReadonlySet<string> | undefined): string {
  const like = [...(known ?? [])].find((k) => glance(k) === glance(name) && glance(name) !== "");
  return `${like === undefined ? "" : `another key than the ${like} you know, `}key ${writer.slice(0, 4)}${mixesAlphabets(name) ? "; its name mixes alphabets" : ""}`;
}

/**
 * Rows from another vault that wait for their writer to be accepted: one ask for each writer this
 * vault hasn't decided about, which accepts it (its rows then count as logged) or refuses it.
 */
export function waitingWriterAsks(o: { path: string; app: string; rows: readonly Row[]; decided: (writer: string) => boolean; known?: ReadonlySet<string> }): Ask[] {
  const by = new Map<string, { name: string; n: number; due: number }>();
  for (const r of o.rows) {
    if (typeof r.writer !== "string" || lineOf(r) !== "attested" || o.decided(r.writer)) continue;
    const t = toTime(r.at) ?? 0;
    const w = by.get(r.writer) ?? { name: "", n: 0, due: t };
    w.n++;
    w.due = Math.min(w.due, t);
    w.name = r.by === undefined || r.by === null || r.by === "" ? w.name || "someone" : textOf(r.by);
    by.set(r.writer, w);
  }
  return [...by].map(([writer, w]): Ask => ({
    id: `writer\n${o.path}\n${writer}`, path: o.path, app: o.app, due: w.due,
    // A name is whatever the sender typed, so the key is always said; a name that reads like one known here, under another key, is said to be another key.
    text: `Accept rows from ${w.name} (${keyNote(w.name, writer, o.known)}) in ${o.app}? ${w.n} ${w.n === 1 ? "row waits" : "rows wait"}, and later ones will count as logged`,
    answer: { writer: { writer, name: w.name, accept: true } },
    refuse: { writer, name: w.name, accept: false },
  }));
}

/** Oldest first; asks due at once in a fixed order, so every device lists them alike. */
export function inOrder(asks: readonly Ask[]): Ask[] {
  return [...asks].sort((a, b) => a.due - b.due || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The asks as `source: asks` gives them: one row each. */
export function askRows(asks: readonly Ask[]): Row[] {
  return asks.map((a) => ({ app: a.app, text: a.text, due: stampOf(new Date(a.due)), ...("line" in a.answer && { line: a.answer.line }), path: a.path }));
}

/**
 * What a key does in the Next window: Enter answers the ask, s skips it and x dismisses it, but
 * only while no line is being typed in (the line's own Enter runs it) and with no modifier held.
 */
export function keyAction(e: { key: string; mod: boolean; typing: boolean }, ask: Ask): "answer" | "skip" | "dismiss" | undefined {
  if (e.typing || e.mod) return undefined;
  if (e.key === "Enter") return "answer";
  if (e.key === "s") return "skip";
  return e.key === "x" && (ask.dismiss || ask.refuse) ? "dismiss" : undefined;
}

/** Skipped until the start of the day after `now`, on this device's clock. */
export function tomorrow(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}
