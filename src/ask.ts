/**
 * The ask line: `? spend food per week since sep` in Do… asks a question of the vault's kinds and
 * of nothing else. A closed grammar reads it, guessing nothing, into the panel a person would type
 * to answer it; that panel is checked as any app's is, on a made-up app that only reads the kind.
 */
import { frontmatterOf } from "./bundle.ts";
import { MONTHS, pastDate, tokenize, type Token } from "./capture.ts";
import type { Row } from "./data.ts";
import type { NoteReader } from "./expand.ts";
import { withPanels } from "./insert.ts";
import { LINES } from "./kind.ts";
import { yamlInline } from "./kind-convert.ts";
import { permissionsOf } from "./permissions.ts";
import { readSpec, type AppSpec } from "./spec.ts";
import { basename, isApp } from "./store.ts";
import type { AppEnv } from "./app.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { nearMiss } from "./template.ts";
import { listed, textOf } from "./text.ts";
import { dateWindow, PERIODS, type Per } from "./time.ts";

/** A kind as an ask reads it: its note, its name and shortcut, its fields, and the values its rows hold. */
export interface AskKind {
  path: string;
  name: string;
  shortcut?: string;
  fields: Record<string, string | string[]>;
  /** For each choice and text field, the values its rows hold (a choice's own options besides). */
  seen: Record<string, string[]>;
  /** What `source` names it by, from where the answer is checked; `[[<note name>]]` unless that finds another note. */
  link?: string;
}

/** What an ask line gives: the panel that answers it, the grammar and the kinds (a bare `?`), or why it can't be read. */
export type Asked =
  | { ok: true; kind: AskKind; panel: Record<string, unknown> }
  | { ok: false; error: string; completions: string[]; help?: true };

const AGGS = ["sum", "avg", "count", "min", "max", "last"] as const;
type AskAgg = (typeof AGGS)[number];
const WHOLE_LINES = [...LINES, "all"];
/** Words the grammar owns, in that place: a value spelled the same is given as field=value. */
const GRAMMAR = [...AGGS, "per", "by", "since", "list", "this", "next", "today", "yesterday", "past", "upcoming", ...WHOLE_LINES, ...PERIODS];
const MONTH_WORDS = MONTHS.map((m) => m.toLowerCase());
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** A Do… line that starts with `?`: the question after it, or undefined for any other line. */
export function askLine(line: string): string | undefined {
  const m = /^\s*\?(.*)$/s.exec(line);
  return m ? m[1] : undefined;
}

export const NO_KINDS = "No kinds in this vault yet. A kind is a note with kind: and fields: (see Kinds in the reference); an ask reads its rows";

/** The grammar, in a few lines, and the kinds there are to ask about with their fields. */
export function askHelp(kinds: readonly AskKind[]): string[] {
  return [
    "? and a kind, then any of these:",
    "sum, avg, count, min, max or last, and a number field; or list for the rows",
    "a value to keep (food), or field=value",
    "per day, week, month or year; or by a field",
    "today, this week, this month, last 30 days, since sep, since 2026-09-01",
    "planned for the planned rows, all for every line",
    kinds.length ? `Kinds: ${kinds.map((k) => `${k.shortcut && k.shortcut !== k.name ? `${k.name} or ${k.shortcut}` : k.name} (${Object.keys(k.fields).join(", ")})`).join("; ")}` : NO_KINDS,
  ];
}

/** The values a kind's rows hold in each of its choice and text fields, each once, in the order they first come. */
export function seenValues(fields: Record<string, string | string[]>, rows: readonly Row[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [f, type] of Object.entries(fields)) {
    if (!Array.isArray(type) && type !== "text" && type !== "textarea") continue;
    const values = new Set<string>();
    for (const r of rows) {
      const v = r[f];
      if (typeof v === "string" ? v.trim() !== "" : typeof v === "number" || typeof v === "boolean") values.add(textOf(v));
    }
    if (values.size) out[f] = [...values];
  }
  return out;
}

/** Each name an ask can start with (a kind's name and its shortcut, in lowercase), with the kinds it names. */
function kindNames(kinds: readonly AskKind[]): Map<string, AskKind[]> {
  const out = new Map<string, AskKind[]>();
  for (const k of kinds) {
    for (const n of new Set([k.name, k.shortcut].filter((s): s is string => !!s).map((s) => s.toLowerCase()))) out.set(n, [...(out.get(n) ?? []), k]);
  }
  return out;
}

const fail = (error: string, completions: string[] = []): Asked => ({ ok: false, error, completions });
/** What could replace the last word typed: the words starting with it, else the one a typo away. Only offered for the last word, which Tab replaces. */
function offered(typed: string, words: readonly string[]): string[] {
  const w = typed.toLowerCase();
  const unique = [...new Set(words)];
  const starting = unique.filter((x) => x.toLowerCase().startsWith(w) && x.toLowerCase() !== w);
  if (starting.length) return starting.slice(0, 12);
  const close = nearMiss(w, unique.map((x) => x.toLowerCase()));
  return close === undefined ? [] : [unique.find((x) => x.toLowerCase() === close)!];
}
const didYouMean = (word: string, names: Iterable<string>) => nearMiss(word.toLowerCase(), names);

/** A day as a title says it: `Sep 1`, with its year when not this one's. */
function shortDay(date: string, now: Date): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${y === now.getFullYear() ? "" : `, ${y}`}`;
}

/** A window `dateWindow` knows, of up to three words from `i`: `this month`, `last 30 days`, `today`. */
function windowAt(tokens: readonly Token[], i: number, now: Date): { cond: string; used: number } | undefined {
  for (let n = 3; n >= 1; n--) {
    const words = tokens.slice(i, i + n);
    if (words.length !== n || words.some((t) => t.quoted || t.name !== undefined)) continue;
    const phrase = words.map((t) => t.text.toLowerCase()).join(" ");
    if (dateWindow(phrase, now)) return { cond: phrase, used: n };
  }
  return undefined;
}

/** What `since` is followed by: a month (the latest first of it, this one included) or a day, as `YYYY-MM-DD`. */
function sinceAt(tokens: readonly Token[], i: number, now: Date): { date: string; used: number } | undefined {
  const t = tokens[i];
  if (!t || t.quoted || t.name !== undefined) return undefined;
  const w = t.text.toLowerCase();
  const month = MONTH_WORDS.findIndex((m, k) => w === m || w === FULL[k] || (w === "sept" && k === 8));
  const next = tokens[i + 1];
  if (month >= 0) {
    const mm = String(month + 1).padStart(2, "0");
    // `since nov 5` is that day, the last one, today included; `since nov` the first of the month.
    const d = next && !next.quoted && next.name === undefined && /^\d{1,2}$/.test(next.text) ? Number(next.text) : undefined;
    if (d !== undefined) {
      const dd = String(d).padStart(2, "0");
      const real = (y: number) => new Date(y, month, d).getDate() === d;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const year = `${now.getFullYear()}-${mm}-${dd}` <= today ? now.getFullYear() : now.getFullYear() - 1;
      if (real(year)) return { date: `${year}-${mm}-${dd}`, used: 2 };
    }
    const year = month <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1;
    return { date: `${year}-${mm}-01`, used: 1 };
  }
  const d = pastDate(t.text, next && !next.quoted && next.name === undefined ? next.text : undefined, now);
  return d ? { date: d.value, used: d.used } : undefined;
}

const FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The values a field of the kind can be kept to: a choice's options and what its rows hold. */
function valuesOf(kind: AskKind, field: string): string[] {
  const type = kind.fields[field];
  return [...new Set([...(Array.isArray(type) ? type.map(String) : []), ...(kind.seen[field] ?? [])])];
}

/** The value of a field written so, case aside: one, several spelled differently, or none. */
function valueIn(kind: AskKind, field: string, text: string): string[] {
  const values = valuesOf(kind, field);
  const exact = values.find((v) => v === text);
  return exact !== undefined ? [exact] : values.filter((v) => v.toLowerCase() === text.toLowerCase());
}

/**
 * Reads an ask line (the text after `?`) against the vault's kinds. First a kind, by its name or
 * shortcut; then, in any order: an aggregate (`sum avg count min max last`, the sum of the kind's
 * first number field when none is said, a count when it has none), a number field, `list`, a value
 * of a field to keep (`food`) or `field=value`, `per <day|week|month|year>` or `by <field>`, a window
 * `dateWindow` knows or `since <date|month>`, and `planned` or `all` for those lines. Each word is
 * one thing or an error that names it; a word that could be two things says how to write each.
 */
export function parseAsk(text: string, kinds: readonly AskKind[], now: Date): Asked {
  const tokens = tokenize(text);
  if ("error" in tokens) return fail(tokens.error);
  const names = kindNames(kinds);
  const all = [...names.keys()].sort();
  if (!tokens.length) return { ok: false, error: "", completions: all, help: true };
  if (!kinds.length) return fail(NO_KINDS);
  const [head, ...rest] = tokens;
  const typed = head.text.toLowerCase();
  const found = head.quoted || head.name !== undefined ? undefined : names.get(typed);
  if (!found) {
    const close = didYouMean(typed, all);
    const starting = all.filter((n) => n.startsWith(typed));
    // Names are offered only while the name is the one word typed, as Tab replaces the last word.
    const offer = rest.length ? [] : starting.length ? starting : close ? [close] : all;
    return fail(`no kind called “${head.text}”${close ? ` (did you mean ${close}?)` : ""}; ask one of ${listed(all)}`, offer);
  }
  if (found.length > 1) return fail(`“${typed}” names ${found.length} kinds (${listed(found.map((k) => k.path))}), so it reaches none of them; rename one`);
  const kind = found[0];
  const label = basename(kind.path);
  const fieldNames = Object.keys(kind.fields);
  const numbers = fieldNames.filter((f) => kind.fields[f] === "number");
  const fieldOf = (word: string) => fieldNames.find((f) => f.toLowerCase() === word.toLowerCase());

  let agg: AskAgg | undefined;
  let field: string | undefined;
  let list = false;
  let per: Per | undefined;
  let by: string | undefined;
  let when: { cond: string; said: string } | undefined;
  const where: Record<string, string | number | boolean> = {};
  const lines: string[] = [];
  const keep = (f: string, value: string | number | boolean): Asked | undefined => {
    if (Object.hasOwn(where, f) && where[f] !== value) return fail(`${f} is given twice (${where[f]} and ${value}); an ask keeps the rows with one value of each field`);
    where[f] = value;
    return undefined;
  };
  const setWhen = (cond: string, said: string): Asked | undefined => {
    if (when) return fail(`say one time: “${when.said}” or “${said}”`);
    when = { cond, said };
    return undefined;
  };
  const setField = (f: string): Asked | undefined => {
    if (field !== undefined && field !== f) return fail(`say one number field: ${field} or ${f}`);
    field = f;
    return undefined;
  };

  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const next = rest[i + 1];
    const nextWord = next && !next.quoted && next.name === undefined ? next.text.toLowerCase() : undefined;
    let stop: Asked | undefined;
    if (t.name !== undefined) {
      const f = fieldOf(t.name);
      if (f === undefined) return fail(`${label} has no field “${t.name}”; its fields are ${listed(fieldNames)}`);
      const type = kind.fields[f];
      if (type === "number") {
        if (!NUMBER.test(t.text)) return fail(`${f} must be a number, not “${t.text}”`);
        stop = keep(f, Number(t.text));
      } else if (type === "checkbox") {
        const yes = ["yes", "true"].includes(t.text.toLowerCase()), no = ["no", "false"].includes(t.text.toLowerCase());
        if (!yes && !no) return fail(`${f} must be yes or no, not “${t.text}”`);
        stop = keep(f, yes);
      } else {
        const hits = valueIn(kind, f, t.text);
        if (Array.isArray(type) && hits.length === 0) return fail(`${f} must be one of ${type.join(", ")}`);
        if (hits.length > 1) return fail(`${f} holds ${listed(hits.map((h) => `“${h}”`))}; write the one you mean as it is written`);
        stop = keep(f, hits[0] ?? t.text);
      }
      if (stop) return stop;
      continue;
    }
    const w = t.text.toLowerCase();
    if (!t.quoted) {
      const win = windowAt(rest, i, now);
      if (win) {
        if ((stop = setWhen(win.cond, win.cond))) return stop;
        i += win.used - 1;
        continue;
      }
      if ((AGGS as readonly string[]).includes(w)) {
        if (agg !== undefined && agg !== w) return fail(`say one of ${AGGS.join(", ")}: ${agg} or ${w}`);
        agg = w as AskAgg;
        continue;
      }
      if (w === "per") {
        if (!nextWord || !(PERIODS as readonly string[]).includes(nextWord)) {
          return fail(`per takes day, week, month or year${next ? `, not “${next.text}”` : ""}`, i + 1 === rest.length - 1 ? offered(next.text, PERIODS) : []);
        }
        per = nextWord as Per;
        i++;
        continue;
      }
      if (w === "by") {
        const f = nextWord === undefined ? undefined : fieldOf(nextWord);
        if (f === undefined) {
          const close = next && didYouMean(next.text, fieldNames.map((n) => n.toLowerCase()));
          return fail(`by takes a field of ${label}: ${listed(fieldNames)}${next ? `, not “${next.text}”${close ? ` (did you mean ${close}?)` : ""}` : ""}`, i + 1 === rest.length - 1 ? offered(next.text, fieldNames) : []);
        }
        by = f;
        i++;
        continue;
      }
      if (w === "since") {
        const s = sinceAt(rest, i + 1, now);
        if (!s) return fail(`since takes a month or a day: since sep, since 2026-09-01, since last mon${next ? `, not “${next.text}”` : ""}`);
        if ((stop = setWhen(`>= ${s.date}`, `since ${shortDay(s.date, now)}`))) return stop;
        i += s.used;
        continue;
      }
      if (w === "list") {
        list = true;
        continue;
      }
      if (WHOLE_LINES.includes(w)) {
        if (!lines.includes(w)) lines.push(w);
        continue;
      }
      if (w === "this") return fail("say this week, this month or this year");
      if (w === "next") return fail("say next and a number of days, e.g. next 7 days");
    }
    // A word of the vault: a field's name, or a value one of its fields holds.
    const asField = t.quoted ? undefined : fieldOf(t.text);
    const asValue = fieldNames.flatMap((f) => {
      const hits = valueIn(kind, f, t.text);
      return hits.length ? [{ f, hits }] : [];
    });
    if (asField === undefined && !asValue.length) {
      const words = [...GRAMMAR, ...fieldNames, ...fieldNames.flatMap((f) => valuesOf(kind, f))];
      const close = didYouMean(w, words.map((x) => x.toLowerCase()));
      const said = close === undefined ? undefined : words.find((x) => x.toLowerCase() === close);
      return fail(`“${t.text}” isn't a field of ${label}, a value its rows hold, or a word an ask knows${said ? ` (did you mean ${said}?)` : ""}`, i === rest.length - 1 ? offered(t.text, words) : []);
    }
    if (asField !== undefined && asValue.length) {
      const how = kind.fields[asField] === "number" ? `sum ${asField}` : `by ${asField}`;
      return fail(`“${t.text}” is a field of ${label} and a value of ${listed(asValue.map((v) => v.f))}: write ${how} for the field, or ${asValue.map((v) => `${v.f}=${t.text}`).join(" or ")} for the value`);
    }
    if (asValue.length > 1) return fail(`“${t.text}” is a value of ${listed(asValue.map((v) => v.f))}: write ${asValue.map((v) => `${v.f}=${t.text}`).join(" or ")}`);
    if (asField !== undefined) {
      if (kind.fields[asField] !== "number") return fail(`${asField} is a field of ${label}: write by ${asField} to group by it, or ${asField}=… to keep some rows`);
      if ((stop = setField(asField))) return stop;
      continue;
    }
    const [{ f, hits }] = asValue;
    if (hits.length > 1) return fail(`${f} holds ${listed(hits.map((h) => `“${h}”`))}; write the one you mean as it is written`);
    if ((stop = keep(f, hits[0]))) return stop;
  }

  if (list) {
    const extra = agg ?? (per ? "per" : by ? "by" : field);
    if (extra !== undefined) return fail(`list shows the rows themselves; leave out “${extra}”`);
  }
  if (per && by) return fail("an ask groups per a time or by a field, not both");
  const how: AskAgg = agg ?? (numbers.length ? "sum" : "count");
  if (how === "count" && field !== undefined) return fail(`count counts the rows; leave out ${field}`);
  const of = how === "count" ? undefined : field ?? numbers[0];
  if (how !== "count" && of === undefined) return fail(`${label} has no number field to ${how}; ask count instead`);

  // Planned without logged is what is still to settle: a settled one stands as the row that settled
  // it, which isn't asked for. With logged, the kind's rows leave the settled one out themselves.
  const unsettled = lines.includes("planned") && !lines.includes("logged") && !lines.includes("all");
  const kept = { ...where, ...(when && { at: when.cond }), ...(unsettled && { matched: "" }) };
  const shownLines = lines.includes("all") ? "all" : lines.length === 1 ? lines[0] : lines.length ? lines : undefined;
  const what = list ? "rows" : how === "count" ? "count" : `${how} of ${of}`;
  const grouped = per ? ` per ${per}` : by ? ` by ${by}` : "";
  const title = [
    `${what}${grouped}`,
    ...Object.entries(where).map(([f, v]) => (typeof v === "string" ? v : `${f}=${v}`)),
    ...(when ? [when.said] : []),
    ...(shownLines === undefined ? [] : [shownLines === "all" ? "every line" : `${[shownLines].flat().join(" and ")} rows`]),
  ].join(", ");
  const base = {
    title: `${label}: ${title}`, source: kind.link ?? `[[${label}]]`,
    ...(shownLines !== undefined && { lines: shownLines }),
    ...(Object.keys(kept).length && { where: kept }),
  };
  const lastFirst = how === "last" ? { sort: "at" } : {};
  if (list) return { ok: true, kind, panel: { view: "table", ...base, sort: "-at", columns: ["at", ...fieldNames] } };
  if (per || by) {
    const view = per && (how === "avg" || how === "last") ? "line" : "bar";
    const totals = how === "count" ? {} : { y: of, agg: how };
    return { ok: true, kind, panel: { view, ...base, ...lastFirst, group: per ? "at" : by, ...(per && { per }), ...totals } };
  }
  return { ok: true, kind, panel: { view: "number", ...base, ...lastFirst, ...(of !== undefined && { field: of }), agg: how } };
}

/** A panel's keys as YAML lines, the way a person types them: one key a line, a list or set on one. */
export function panelLines(panel: Record<string, unknown>): string[] {
  return Object.entries(panel).map(([k, v]) => `${k}: ${yamlInline(v)}`);
}

/** The YAML an answer stands for, as an item of an app's `panels:`. */
export function panelYaml(panel: Record<string, unknown>): string {
  return panelLines(panel).map((l, i) => `${i ? "  " : "- "}${l}`).join("\n");
}

/** A `gizmo` block that draws the answer in any note, asking for the kind as any embed does. */
export function panelEmbed(panel: Record<string, unknown>): string {
  return ["```gizmo", ...panelLines(panel), "```"].join("\n");
}

/**
 * An app note's text with the answer added as its last panel, as Insert panel adds one (see
 * insertPanel), or why not: Insert panel's refusals, and any problem the app would have then that
 * it hasn't now (a note whose panels come from one component, say), since it would no longer run.
 */
export function addToApp(text: string, panel: Record<string, unknown>, opts: { path: string; notes: NoteReader; parse: (yaml: string) => unknown; now: Date }): { text: string } | { refusal: string } {
  const found = withPanels(text, [panelLines(panel)]);
  if ("refusal" in found) return found;
  const read = (t: string) => readSpec(frontmatterOf(t, opts.parse), { now: opts.now, notes: opts.notes, path: opts.path });
  const was = new Set(read(text)?.errors ?? []);
  const fresh = (read(found.text)?.errors ?? ["it would no longer be an app"]).filter((e) => !was.has(e));
  return fresh.length ? { refusal: fresh[0] } : { text: found.text };
}

/** Where an ask's made-up app sits: beside the kind, so the kind's link finds it, under a name no note is read for. */
export function askPath(kind: AskKind): string {
  return kind.path.replace(/\.md$/i, " (ask).md");
}

/** An answer checked as an app: the made-up app's keys and spec, what it would ask for, and its problems. */
export interface Compiled {
  path: string;
  fm: Record<string, unknown>;
  spec?: AppSpec;
  wanted: string[];
  errors: string[];
}

/**
 * Checks an answer's panel through readSpec, as a made-up app holding only it. It may only read
 * the kind: anything else it would ask for (a write, a fetch, another note) is an error, and the
 * answer isn't drawn, so it runs with no grant prompt.
 */
export function compileAsk(kind: AskKind, panel: Record<string, unknown>, opts: { notes: NoteReader; now: Date }): Compiled {
  const path = askPath(kind);
  const fm = { app: "", panels: [panel] };
  const read = readSpec(fm, { now: opts.now, notes: opts.notes, path })!;
  const errors = read.errors.map((e) => e.replace(/^panel 1: /, ""));
  const wanted = read.spec ? permissionsOf(read.spec, path) : [];
  const only = `kind:${kind.path}`;
  const more = wanted.filter((p) => p !== only);
  if (more.length || (read.spec && !wanted.includes(only))) errors.push(`an ask only reads ${basename(kind.path)}, and this one would need ${listed(more.length ? more : ["nothing of it"])}`);
  const spec = !errors.length && read.spec?.panels.length === 1 ? read.spec : undefined;
  return { path, fm, spec, wanted, errors: spec || errors.length ? errors : ["the answer has nothing to draw"] };
}

const READ_ONLY = "an ask only reads";

/**
 * The app an answer is drawn in: the kind's rows through the data layer, and nothing else. It runs
 * without a grant prompt only while all it asks for is reading that kind (`reads`); it can't write a
 * note, keep a row, log, run another app or reach out (pictures are drawn as their address).
 */
export function askEnvOf(base: AppEnv, reads: string): AppEnv {
  const refuse = () => Promise.reject(new Error(READ_ONLY));
  return {
    ...base,
    isGranted: (_key, wanted) => wanted.length === 1 && wanted[0] === reads,
    granted: () => undefined,
    grant: refuse,
    writeFrontmatter: refuse,
    updateFrontmatter: refuse,
    appendLine: refuse,
    createNote: refuse,
    setTaskDone: refuse,
    store: undefined,
    addPanels: undefined,
    log: undefined,
    undo: undefined,
    trigger: undefined,
    opened: undefined,
    tryFirst: undefined,
    asks: undefined,
    headline: undefined,
    preview: true,
  };
}

/** The vault's apps an answer can be kept in, by path. */
export function appsToAddTo(rt: GizmoRuntime): string[] {
  const host = rt.dataLayer.host;
  return host.markdownFiles().filter((f) => isApp(host.frontmatter(f.path))).map((f) => f.path).sort((a, b) => a.localeCompare(b));
}

/**
 * Keeps an answer as an app's last panel, as Insert panel adds one; the app then asks to read the
 * kind. The kind is named as the app finds it from where it is: by name when that reaches it.
 */
export async function addAnswer(rt: GizmoRuntime, appPath: string, kindPath: string, panel: Record<string, unknown>): Promise<{ refusal?: string }> {
  const name = basename(kindPath);
  const source = rt.host.notes.resolve(name, appPath) === kindPath ? `[[${name}]]` : `[[${kindPath.replace(/\.md$/i, "")}]]`;
  let refusal: string | undefined;
  const there = await rt.host.writes.processText(appPath, (text) => {
    const found = addToApp(text, { ...panel, source }, { path: appPath, notes: rt.host.notes, parse: (yaml) => rt.dataLayer.host.parseYaml(yaml), now: new Date(rt.dataLayer.host.now()) });
    if ("refusal" in found) {
      refusal = found.refusal;
      return text;
    }
    return found.text;
  });
  return there ? { refusal } : { refusal: "it isn't there any more" };
}
