import { stampParts } from "./time.ts";
import type { PanelSpec } from "./spec.ts";

/** A shortcut a capture line can run: a form, button or checklist with a name to type. */
export interface CaptureTarget {
  /** The name typed first on the line, in lowercase: the panel's alias (which may be several words), else its shortcut. */
  name: string;
  path: string;
  app: string;
  shortcut: string;
  label: string;
  view: "form" | "button" | "checklist";
  /** A form's fields in the order they are declared, each with its type; a checklist's items. */
  fields: [string, string | string[]][];
  items: string[];
}

/** Every name a capture line can start with, and the names that point at more than one shortcut. */
export interface CaptureIndex {
  names: Map<string, CaptureTarget>;
  clashes: Map<string, CaptureTarget[]>;
}

/** An app as the capture line sees it: its note, its name and its shortcuts' checked panels. */
export interface CaptureApp {
  path: string;
  name: string;
  shortcuts: ReadonlyMap<string, PanelSpec>;
}

const VIEWS = new Set(["form", "button", "checklist"]);

/**
 * The names a capture line can start with. A panel's alias is its name, and so is its shortcut
 * when no other shortcut in the vault has that name. A name that would point at two shortcuts
 * points at neither; the line says which apps share it.
 */
export function captureTargets(apps: Iterable<CaptureApp>): CaptureIndex {
  const byName = new Map<string, CaptureTarget[]>();
  const shortcutCount = new Map<string, number>();
  const all: { target: CaptureTarget; alias?: string }[] = [];
  for (const app of apps) {
    for (const [shortcut, ps] of app.shortcuts) {
      const p = ps.panel;
      if (!VIEWS.has(p.view)) continue;
      const fields = p.view === "form" ? Object.entries(p.fields ?? p.schema ?? {}) : [];
      const target: CaptureTarget = {
        name: (p.alias ?? shortcut).toLowerCase(), path: app.path, app: app.name, shortcut,
        // A form's title says what it's for better than its button's label, as the activity log names it.
        label: p.title ?? p.label ?? shortcut, view: p.view as CaptureTarget["view"],
        fields, items: (p.items ?? []).map(String),
      };
      all.push({ target, alias: p.alias });
      shortcutCount.set(shortcut, (shortcutCount.get(shortcut) ?? 0) + 1);
    }
  }
  const add = (name: string, target: CaptureTarget) => {
    const list = byName.get(name) ?? [];
    if (!list.includes(target)) list.push(target);
    byName.set(name, list);
  };
  for (const { target, alias } of all) {
    if (alias !== undefined) add(alias.toLowerCase(), target);
    // A shortcut's own name only reaches it while no other app has a shortcut by that name.
    if (shortcutCount.get(target.shortcut) === 1 || alias === undefined) add(target.shortcut, target);
  }
  const names = new Map<string, CaptureTarget>();
  const clashes = new Map<string, CaptureTarget[]>();
  for (const [name, list] of byName) {
    if (list.length === 1) names.set(name, list[0].name === name ? list[0] : { ...list[0], name });
    else clashes.set(name, list);
  }
  return { names, clashes };
}

/** What a capture line would run, or why it can't, with what could come next. */
export type Parsed =
  | { ok: true; target: CaptureTarget; params?: Record<string, string>; next?: string }
  | { ok: false; error: string; target?: CaptureTarget; completions: string[]; next?: string };

/** One word of a line, or one `"…"` value. */
export interface Token {
  text: string;
  /** `name=` before the value, for a value given by its field's name. */
  name?: string;
  quoted: boolean;
}

/** The words of a line; `"…"` keeps spaces in one value, also after `name=`. */
export function tokenize(line: string): Token[] | { error: string } {
  const out: Token[] = [];
  const re = /\s*(?:([a-z0-9_-]+)=)?(?:"([^"]*)("?)|(\S+))/giy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < line.length && (m = re.exec(line))) {
    if (m[2] !== undefined && m[3] !== '"') return { error: "a quote isn't closed" };
    if (m[2] === undefined && m[4] === undefined) break;
    out.push({ text: m[2] ?? m[4], name: m[1]?.toLowerCase(), quoted: m[2] !== undefined });
    if (!/\S/.test(line.slice(re.lastIndex))) break;
  }
  return out;
}

const WEEKDAYS: [string, string[]][] = [
  ["sun", ["sun", "sunday"]], ["mon", ["mon", "monday"]], ["tue", ["tue", "tues", "tuesday"]],
  ["wed", ["wed", "wednesday"]], ["thu", ["thu", "thur", "thurs", "thursday"]], ["fri", ["fri", "friday"]],
  ["sat", ["sat", "saturday"]],
];

function weekday(word: string): number | undefined {
  const i = WEEKDAYS.findIndex(([, names]) => names.includes(word));
  return i < 0 ? undefined : i;
}

function shifted(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
}

/** A real calendar day as `YYYY-MM-DD`, or undefined for one like 02-30. */
function day(y: number, m: number, d: number): string | undefined {
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? stampParts(date).date : undefined;
}

/**
 * A date typed on a capture line, as `YYYY-MM-DD`: today, yesterday (yday), tomorrow, +3d or -2d,
 * a weekday (the next one after today), `last` and a weekday (the one before today), MM-DD in
 * this year, or YYYY-MM-DD. `following` is the word after it, read for `last <weekday>`; `used`
 * says how many words it took.
 */
export function captureDate(word: string, following: string | undefined, now: Date): { value: string; used: number } | undefined {
  const w = word.toLowerCase();
  const rel: Record<string, number> = { today: 0, yesterday: -1, yday: -1, tomorrow: 1 };
  if (Object.hasOwn(rel, w)) return { value: stampParts(shifted(now, rel[w])).date, used: 1 };
  const offset = w.match(/^([+-])(\d{1,4})d$/);
  if (offset) return { value: stampParts(shifted(now, (offset[1] === "-" ? -1 : 1) * Number(offset[2]))).date, used: 1 };
  const wd = weekday(w);
  if (wd !== undefined) return { value: stampParts(shifted(now, ((wd - now.getDay() + 6) % 7) + 1)).date, used: 1 };
  if (w === "last" && following !== undefined) {
    const back = weekday(following.toLowerCase());
    if (back !== undefined) return { value: stampParts(shifted(now, -(((now.getDay() - back + 6) % 7) + 1))).date, used: 2 };
  }
  const md = w.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    const value = day(now.getFullYear(), Number(md[1]), Number(md[2]));
    return value ? { value, used: 1 } : undefined;
  }
  const ymd = w.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const value = day(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    return value ? { value, used: 1 } : undefined;
  }
  return undefined;
}

/** A time typed on a capture line as `HH:MM`: 8:15, 08:15, 8am, 8:15pm, 12am is midnight. */
export function captureTime(word: string): string | undefined {
  const m = word.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m || (m[2] === undefined && m[3] === undefined)) return undefined;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return undefined;
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (h > 23) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** A number as a capture line takes it: digits, a point, a sign; no thousands separators. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const YES = ["yes", "y", "true"];
const NO = ["no", "n", "false"];

/** A choice from the list: the one written so, else the only one starting with what was typed, case aside. */
function choiceOf(options: string[], word: string): { value: string } | { error: string } {
  const w = word.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === w);
  if (exact !== undefined) return { value: exact };
  const starting = options.filter((o) => o.toLowerCase().startsWith(w));
  if (starting.length === 1) return { value: starting[0] };
  return { error: starting.length ? `“${word}” could be ${starting.join(" or ")}` : `must be one of ${options.join(", ")}` };
}

/** What a field takes, as the line's hint says it. */
function describe(name: string, type: string | string[]): string {
  if (Array.isArray(type)) return `${name}: ${type.map(String).join(", ")}`;
  const words: Record<string, string> = {
    number: "a number", date: "a date (today, yday, fri, 11-03)", time: "a time (8:15, 8am)",
    checkbox: "yes or no", text: "text", textarea: "text",
  };
  return `${name}: ${words[type] ?? type}`;
}

/** Completions for a field from what has been typed of its value. */
function completionsFor(type: string | string[], typed: string): string[] {
  const w = typed.toLowerCase();
  const pool = Array.isArray(type) ? type.map(String) : type === "checkbox" ? ["yes", "no"] : type === "date" ? ["today", "yesterday", "tomorrow"] : [];
  return pool.filter((o) => o.toLowerCase().startsWith(w));
}

/** One value typed for a field, as the link text its type reads; or why it doesn't fit. */
function readValue(name: string, type: string | string[], words: string[], now: Date): { value: string; used: number } | { error: string } {
  const word = words[0];
  if (Array.isArray(type)) {
    const c = choiceOf(type.map(String), word);
    return "value" in c ? { value: c.value, used: 1 } : { error: `${name} ${c.error}` };
  }
  switch (type) {
    case "number":
      return NUMBER.test(word) ? { value: String(Number(word)), used: 1 } : { error: `${name} must be a number, not “${word}”` };
    case "date": {
      const d = captureDate(word, words[1], now);
      return d ?? { error: `${name} must be a date (today, yday, fri, last mon, 11-03, 2026-11-03), not “${word}”` };
    }
    case "time": {
      const t = captureTime(word);
      return t ? { value: t, used: 1 } : { error: `${name} must be a time (8:15, 8am, 8:15pm), not “${word}”` };
    }
    case "checkbox": {
      const w = word.toLowerCase();
      return YES.includes(w) ? { value: "true", used: 1 } : NO.includes(w) ? { value: "false", used: 1 } : { error: `${name} must be yes or no, not “${word}”` };
    }
    default:
      return { value: word, used: 1 };
  }
}

/**
 * Reads a capture line: the name of a shortcut, then its values. A form's values fill its fields
 * in the order they are declared, each read as its type; a text field takes one word, or the rest
 * of the line when it is the last field left; `name=value` fills a field by its name and `"…"`
 * keeps spaces in a value. A checklist takes the item to tick, a button nothing. Nothing is
 * guessed: anything unclear is an error, with what could be typed instead.
 */
export function parseLine(line: string, index: CaptureIndex, now: Date): Parsed {
  // A link or a phone's shortcut could carry more than one line; like any link's value, that is refused whole.
  if (/[\r\n]/.test(line)) return { ok: false, error: "a capture line is one line", completions: [] };
  const text = line.trim();
  const all = [...index.names.keys()].sort();
  if (!text || /^[^\s"=]+=/.test(text)) return { ok: false, error: "type the name of a shortcut", completions: all };
  // The longest name the line starts with, as a whole word or words: an alias may be several.
  const lower = text.toLowerCase();
  const names = [...index.names.keys(), ...index.clashes.keys()].sort((a, b) => b.length - a.length);
  const word = names.find((n) => lower === n || lower.startsWith(`${n} `)) ?? lower.split(/\s/)[0];
  const clash = index.clashes.get(word);
  if (clash) {
    return { ok: false, error: `“${word}” is a shortcut in ${clash.map((t) => t.app).join(" and ")}; give one of them an alias:`, completions: [] };
  }
  const target = index.names.get(word);
  if (!target) {
    // Names are offered while the name is being typed (all of it, as an alias may be several words).
    const completions = all.filter((n) => n.startsWith(lower));
    return { ok: false, error: `no shortcut called “${text.split(/\s/)[0]}”`, completions };
  }
  // The name as typed, in whatever case, is cut off the line's start; the values follow it.
  const typed = new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "iu").exec(text)?.[0] ?? word;
  const tokens = tokenize(text.slice(typed.length));
  if ("error" in tokens) return { ok: false, error: tokens.error, target, completions: [] };
  const rest = tokens;
  if (target.view === "button") {
    if (rest.length) return { ok: false, error: `${word} takes no values`, target, completions: [] };
    return { ok: true, target };
  }
  if (target.view === "checklist") {
    const named = rest.find((t) => t.name !== undefined);
    if (named && named.name !== "item") return { ok: false, error: `${word} takes only an item to tick`, target, completions: [] };
    const item = (named ? [named] : rest).map((t) => t.text).join(" ");
    if (!item) return { ok: false, error: `say which item to tick`, target, completions: target.items, next: `item: ${target.items.join(", ")}` };
    const c = choiceOf(target.items, item);
    if ("error" in c) return { ok: false, error: `item ${c.error}`, target, completions: completionsFor(target.items, item) };
    return { ok: true, target, params: { item: c.value } };
  }
  return parseForm(target, rest, now);
}

function parseForm(target: CaptureTarget, tokens: Token[], now: Date): Parsed {
  const read = parseFields(tokens, target.fields, now, { name: target.name });
  const fail = (error: string, completions: string[] = [], next?: string): Parsed => ({ ok: false, error, target, completions, next });
  if (read.errors.length) return fail(read.errors[0], read.completions, read.next);
  // A form saved with nothing typed would be an empty row made by a slip of the Enter key.
  if (!Object.keys(read.params).length && target.fields.length) {
    const [name, type] = target.fields[0];
    return fail(`type what ${target.name} saves, starting with ${name}`, completionsFor(type, ""), describe(name, type));
  }
  const nextField = target.fields.find(([n]) => n === read.missing[0]);
  return { ok: true, target, params: read.params, next: nextField ? describe(nextField[0], nextField[1]) : undefined };
}

/** What the values on a line give a form's fields. */
export interface FieldValues {
  /**
   * Each field given a value, as the link text its type reads: a number's digits, `YYYY-MM-DD`,
   * `HH:MM`, `true` or `false`, a choice as the form lists it.
   */
  params: Record<string, string>;
  /** The fields given nothing, in the order they are declared. */
  missing: string[];
  /** Why the line can't be read as it stands; a strict read stops at the first. */
  errors: string[];
  /** What could be typed in place of the word the first error is about. */
  completions: string[];
  /** What the field the first error is about takes. */
  next?: string;
}

type FieldList = readonly (readonly [string, string | string[]])[];

const isText = (type: string | string[]) => type === "text" || type === "textarea";

/**
 * Reads a line's values into a form's fields; `name` is what the form is called in messages.
 * `name=value` fills a field by its name, in any case, and `"…"` keeps spaces in a value.
 *
 * Strict, as the Do… command reads: the other values fill the fields in the order they are
 * declared, each read as its type; a text field takes one word, or the rest of the line when it is
 * the last field left. Nothing is guessed.
 *
 * Loose, as an add line reads: each value goes to the first open field it fits, wherever it is on
 * the line. A choice (written in full, or 3 letters or more of only one), a number, a date or a
 * time finds its field; a quoted value goes to the next text field; the words left over go to the
 * first text field, together.
 */
export function parseFields(input: string | readonly Token[], fields: FieldList, now: Date, how: { name: string; loose?: boolean }): FieldValues {
  const out: FieldValues = { params: {}, missing: [], errors: [], completions: [] };
  const tokens = typeof input === "string" ? tokenize(input) : input;
  if ("error" in tokens) {
    out.errors.push(tokens.error);
    out.missing = fields.map(([n]) => n);
    return out;
  }
  const types = new Map(fields);
  const params = out.params;
  const fail = (error: string, completions: string[] = [], next?: string) => {
    if (!out.errors.length) Object.assign(out, { completions, next });
    out.errors.push(error);
  };
  for (const t of tokens) {
    if (t.name === undefined) continue;
    // Typed in any case; kept as the form spells it.
    const field = fields.find(([n]) => n.toLowerCase() === t.name)?.[0];
    if (field === undefined) fail(`${how.name} has no field “${t.name}”; its fields are ${fields.map(([n]) => n).join(", ")}`);
    else if (Object.hasOwn(params, field)) fail(`${field} is given twice`);
    else {
      const v = readValue(field, types.get(field)!, [t.text], now);
      if ("error" in v) fail(v.error, completionsFor(types.get(field)!, t.text));
      else params[field] = v.value;
    }
    if (out.errors.length && !how.loose) return done(out, fields);
  }
  const words = tokens.filter((t) => t.name === undefined);
  if (how.loose) looseValues(words, fields, now, params, fail);
  else strictValues(words, fields, now, params, fail);
  return done(out, fields);
}

function done(out: FieldValues, fields: FieldList): FieldValues {
  out.missing = fields.map(([n]) => n).filter((n) => !Object.hasOwn(out.params, n));
  return out;
}

type Fail = (error: string, completions?: string[], next?: string) => void;

/** The words fill the open fields in the order they are declared. */
function strictValues(words: Token[], fields: FieldList, now: Date, params: Record<string, string>, fail: Fail): void {
  const open = fields.filter(([n]) => !Object.hasOwn(params, n));
  let w = 0;
  for (let f = 0; f < open.length && w < words.length; f++) {
    const [name, type] = open[f];
    if (isText(type) && f === open.length - 1 && !words[w].quoted) {
      params[name] = words.slice(w).map((t) => t.text).join(" ");
      w = words.length;
      break;
    }
    const v = readValue(name, type, words.slice(w).map((t) => t.text), now);
    if ("error" in v) return fail(v.error, completionsFor(type, words[w].text), describe(name, type));
    params[name] = v.value;
    w += v.used;
  }
  if (w < words.length) fail(`too many values: ${words.slice(w).map((t) => t.text).join(" ")}`);
}

/** Each word goes to the first open field it fits; the rest go to the first text field. */
function looseValues(words: Token[], fields: FieldList, now: Date, params: Record<string, string>, fail: Fail): void {
  const open = (fits: (type: string | string[]) => boolean) => fields.find(([n, type]) => !Object.hasOwn(params, n) && fits(type))?.[0];
  const choice = (word: string, least: number) => {
    const w = word.toLowerCase();
    for (const [n, type] of fields) {
      if (Object.hasOwn(params, n) || !Array.isArray(type)) continue;
      const options = type.map(String);
      const exact = options.find((o) => o.toLowerCase() === w);
      const starting = w.length >= least ? options.filter((o) => o.toLowerCase().startsWith(w)) : [];
      const value = exact ?? (starting.length === 1 ? starting[0] : undefined);
      if (value !== undefined) return { field: n, value };
    }
    return undefined;
  };
  const left: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = words[i];
    const exact = choice(t.text, Infinity);
    if (exact) {
      params[exact.field] = exact.value;
      continue;
    }
    if (t.quoted) {
      const text = open(isText);
      if (text !== undefined) params[text] = t.text;
      else left.push(t);
      continue;
    }
    const number = open((type) => type === "number");
    if (number !== undefined && NUMBER.test(t.text)) {
      params[number] = String(Number(t.text));
      continue;
    }
    const date = open((type) => type === "date");
    const following = words[i + 1]?.quoted === false ? words[i + 1].text : undefined;
    const d = date === undefined ? undefined : captureDate(t.text, following, now);
    if (date !== undefined && d) {
      params[date] = d.value;
      i += d.used - 1;
      continue;
    }
    const time = open((type) => type === "time");
    const at = time === undefined ? undefined : captureTime(t.text);
    if (time !== undefined && at) {
      params[time] = at;
      continue;
    }
    const prefix = choice(t.text, 3);
    if (prefix) {
      params[prefix.field] = prefix.value;
      continue;
    }
    const box = open((type) => type === "checkbox");
    const yes = YES.includes(t.text.toLowerCase()), no = NO.includes(t.text.toLowerCase());
    if (box !== undefined && (yes || no)) {
      params[box] = String(yes);
      continue;
    }
    left.push(t);
  }
  if (!left.length) return;
  const text = open(isText);
  if (text !== undefined) {
    params[text] = left.map((t) => t.text).join(" ");
    return;
  }
  // No text field to take them: each word may still be the short start of a choice.
  for (const [k, t] of left.entries()) {
    const rest = fields.filter(([n]) => !Object.hasOwn(params, n));
    if (!rest.length) return fail(`too many values: ${left.slice(k).map((x) => x.text).join(" ")}`);
    const tries = rest.map(([n, type]) => [n, type, readValue(n, type, [t.text], now)] as const);
    const fits = tries.find(([, , v]) => "value" in v);
    if (fits && "value" in fits[2]) {
      params[fits[0]] = fits[2].value;
      continue;
    }
    const [n, type, v] = tries[0];
    return fail("error" in v ? v.error : `${n} can't take “${t.text}”`, completionsFor(type, t.text), describe(n, type));
  }
}

/**
 * A line with a completion taken, and a space after it to type the next value: a name replaces
 * all that was typed of it (an alias may be several words), a value replaces the last word.
 */
export function completed(line: string, completion: string): string {
  if (completion.toLowerCase().startsWith(line.trim().toLowerCase())) return `${completion} `;
  const at = /\S*$/.exec(line)!.index;
  const word = /\s/.test(completion) ? `"${completion}"` : completion;
  return `${line.slice(0, at)}${word} `;
}

/** A capture line in a note: the text after a leading `;;`, or undefined for any other line. */
export function captureLine(text: string): string | undefined {
  const m = /^\s*;;(.*)$/.exec(text);
  return m ? m[1] : undefined;
}

/**
 * What a capture line becomes once it ran: a tick, the line, the app and the time, and a link to
 * what it changed in the activity log. It no longer starts with `;;`, so it never runs again.
 */
export function receipt(line: string, app: string, now: Date, entryId: string | undefined): string {
  const time = stampParts(now).time;
  const details = entryId ? ` · [details](obsidian://gizmo?activity=${encodeURIComponent(entryId)})` : "";
  return `✓ ${line} · ${app} · ${time}${details}`;
}
