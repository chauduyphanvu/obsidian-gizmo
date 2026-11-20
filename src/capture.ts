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

interface Token {
  text: string;
  /** `name=` before the value, for a value given by its field's name. */
  name?: string;
  quoted: boolean;
}

/** The words of a line; `"…"` keeps spaces in one value, also after `name=`. */
function tokenize(line: string): Token[] | { error: string } {
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
      return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? { value: String(Number(word)), used: 1 } : { error: `${name} must be a number, not “${word}”` };
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
  const types = new Map(target.fields);
  const params: Record<string, string> = {};
  const fail = (error: string, completions: string[] = [], next?: string): Parsed => ({ ok: false, error, target, completions, next });
  for (const t of tokens) {
    if (t.name === undefined) continue;
    // Typed in any case; kept as the form spells it.
    const field = target.fields.find(([n]) => n.toLowerCase() === t.name)?.[0];
    if (field === undefined) return fail(`${target.name} has no field “${t.name}”; its fields are ${target.fields.map(([n]) => n).join(", ")}`);
    if (Object.hasOwn(params, field)) return fail(`${field} is given twice`);
    const v = readValue(field, types.get(field)!, [t.text], now);
    if ("error" in v) return fail(v.error, completionsFor(types.get(field)!, t.text));
    params[field] = v.value;
  }
  const open = target.fields.filter(([n]) => !Object.hasOwn(params, n));
  const words = tokens.filter((t) => t.name === undefined);
  let w = 0;
  for (let f = 0; f < open.length && w < words.length; f++) {
    const [name, type] = open[f];
    const isText = type === "text" || type === "textarea";
    if (isText && f === open.length - 1 && !words[w].quoted) {
      params[name] = words.slice(w).map((t) => t.text).join(" ");
      w = words.length;
      break;
    }
    const v = readValue(name, type, words.slice(w).map((t) => t.text), now);
    if ("error" in v) return fail(v.error, completionsFor(type, words[w].text), describe(name, type));
    params[name] = v.value;
    w += v.used;
  }
  if (w < words.length) return fail(`too many values: ${words.slice(w).map((t) => t.text).join(" ")}`);
  // A form saved with nothing typed would be an empty row made by a slip of the Enter key.
  if (!Object.keys(params).length && target.fields.length) {
    const [name, type] = target.fields[0];
    return fail(`type what ${target.name} saves, starting with ${name}`, completionsFor(type, ""), describe(name, type));
  }
  const nextField = open.find(([n]) => !Object.hasOwn(params, n));
  return { ok: true, target, params, next: nextField ? describe(nextField[0], nextField[1]) : undefined };
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
