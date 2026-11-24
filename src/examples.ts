/**
 * Apps from examples: lines a person already has, as they would say them, become a kind (its
 * fields worked out from how the lines line up), its rows, and an app over it. An answer the person
 * knows ("food this week = 62.30") picks the panel: every question the ask grammar can put to those
 * rows is tried, and the ones that give that number are offered, shortest first. Nothing is guessed
 * by a model, and nothing is kept until the person has read the keys.
 */
import { panelLines, parseAsk, type AskKind } from "./ask.ts";
import { MONTHS, pastDate, tokenize, type Token } from "./capture.ts";
import { toNumber, valueOf, type Row } from "./data.ts";
import { yamlInline } from "./kind-convert.ts";
import { kindProblem } from "./kind.ts";
import { compilePipeline } from "./pipeline.ts";
import { checkPanel, type Panel } from "./spec.ts";
import { textOf } from "./text.ts";
import { stampOf, stampParts } from "./time.ts";
import { unitDef, type UnitDef } from "./units.ts";

/** The most lines read at once, and the most a choice field lists. */
export const MAX_LINES = 2000;
const MAX_CHOICES = 12;

/** One typed value as its line gives it. */
type Cell = { kind: "number"; n: number; unit?: UnitDef; decimals: number } | { kind: "words"; words: string[] };

/** What the lines say when read together. */
export interface Inferred {
  /** Each field in the order the lines give it, with its type as a `fields:` map takes it. */
  fields: [string, string | string[]][];
  rows: Row[];
  /** For a plain number field whose lines write decimals: the format that shows as many, so a total reads as the lines do (`310.40`, not `310`). */
  formats: Record<string, string>;
  /** Whether the lines say when: a date at their start or end, read into each row's `at`. */
  dated: boolean;
  /** Lines that don't have the shape most lines have, each with its number among the lines given (from 1) and why. */
  skipped: { line: number; text: string; why: string }[];
}

const MONEY_SIGNS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };
const NUMBER = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^[+-]?\.\d+$/;

/** A word as a number: `62.10`, `1,250`, `$4.50`, `81.2kg`; with the unit its sign or ending names. */
function numberIn(word: string): { n: number; unit?: UnitDef; decimals: number } | undefined {
  const sign = MONEY_SIGNS[word[0]] ?? MONEY_SIGNS[word.at(-1) ?? ""];
  const bare = sign ? (MONEY_SIGNS[word[0]] ? word.slice(1) : word.slice(0, -1)) : word;
  const decimals = (digits: string) => (digits.includes(".") ? digits.length - digits.indexOf(".") - 1 : 0);
  if (NUMBER.test(bare)) return { n: Number(bare.replace(/,/g, "")), decimals: decimals(bare), ...(sign && { unit: unitDef(sign) }) };
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([A-Za-z]{1,5})$/.exec(word);
  const unit = m ? unitDef(m[2]) : undefined;
  return m && unit ? { n: Number(m[1]), unit, decimals: decimals(m[1]) } : undefined;
}

const MONTH_WORDS = MONTHS.map((m) => m.toLowerCase());
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthOf = (word: string) => {
  const w = word.toLowerCase().replace(/[.,]$/, "");
  const i = MONTH_WORDS.indexOf(w);
  return i >= 0 ? i : FULL_MONTHS.indexOf(w);
};

function dayOf(y: number, m: number, d: number): string | undefined {
  const at = new Date(y, m, d);
  return at.getFullYear() === y && at.getMonth() === m && at.getDate() === d ? stampParts(at).date : undefined;
}

/** A month and day with no year is the latest one, today included: what is listed has happened. */
function latest(m: number, d: number, now: Date): string | undefined {
  const today = stampParts(now).date;
  const this_ = dayOf(now.getFullYear(), m, d);
  return this_ !== undefined && this_ <= today ? this_ : dayOf(now.getFullYear() - 1, m, d) ?? this_;
}

/**
 * A date at the start of some words, as `YYYY-MM-DD`, and how many words it took: `2026-03-03`,
 * `3/14/2026`, `3/14`, `mar 3`, `3 mar`, `march 3 2026`, and the words a capture line reads
 * (`yday`, `fri`, `last mon`).
 */
export function dateAt(words: readonly string[], now: Date): { date: string; used: number } | undefined {
  const [a, b, c] = words;
  if (a === undefined) return undefined;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(a);
  if (iso) {
    const date = dayOf(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return date ? { date, used: 1 } : undefined;
  }
  const us = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(a);
  if (us) {
    const y = us[3] === undefined ? undefined : Number(us[3].length === 2 ? `20${us[3]}` : us[3]);
    const date = y === undefined ? latest(Number(us[1]) - 1, Number(us[2]), now) : dayOf(y, Number(us[1]) - 1, Number(us[2]));
    return date ? { date, used: 1 } : undefined;
  }
  const dayNumber = (w: string | undefined) => (w !== undefined && /^\d{1,2}(st|nd|rd|th)?,?$/.test(w) ? parseInt(w, 10) : undefined);
  // `mar 3 1500 rent` is an amount: a year is one a list of things that happened could be in.
  const year = (w: string | undefined) => (w !== undefined && /^\d{4}$/.test(w) && Number(w) <= now.getFullYear() && Number(w) >= now.getFullYear() - 30 ? Number(w) : undefined);
  const [m1, d1] = [monthOf(a), dayNumber(b)];
  const [d2, m2] = [dayNumber(a), b === undefined ? -1 : monthOf(b)];
  const md = m1 >= 0 && d1 !== undefined ? [m1, d1] : d2 !== undefined && m2 >= 0 ? [m2, d2] : undefined;
  if (md) {
    const y = year(c);
    const date = y === undefined ? latest(md[0], md[1], now) : dayOf(y, md[0], md[1]);
    return date ? { date, used: y === undefined ? 2 : 3 } : undefined;
  }
  // A bare number is an amount, not the day `11-03` or a time; only words say a day here.
  if (/\d/.test(a)) return undefined;
  const said = pastDate(a, b, now);
  return said ? { date: said.value, used: said.used } : undefined;
}

/** A line without the mark of a list or a task in front. */
const unmarked = (line: string) => line.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "").trim();

interface Read {
  line: number;
  text: string;
  date?: string;
  cells: Cell[];
}

/** A line's words as cells: each number alone, each run of other words together. */
function cellsOf(tokens: readonly Token[]): Cell[] {
  const out: Cell[] = [];
  for (const t of tokens) {
    const n = t.quoted ? undefined : numberIn(t.text);
    const last = out.at(-1);
    if (n) out.push({ kind: "number", ...n });
    else if (t.quoted || last?.kind !== "words") out.push({ kind: "words", words: [t.text] });
    else last.words.push(t.text);
  }
  return out;
}

const shapeOf = (cells: readonly Cell[]) => cells.map((c) => (c.kind === "number" ? "N" : "W")).join("");

/**
 * The shape most lines have (numbers and runs of words, in order); the first met wins a tie. Words
 * at the end that only some lines have (a note) are part of it: `coffee 4.50` and
 * `coffee 5.00 with sam` are one shape, the first with no note.
 */
function commonShape(reads: readonly Read[]): string {
  const counts = new Map<string, number>();
  for (const r of reads) counts.set(shapeOf(r.cells), (counts.get(shapeOf(r.cells)) ?? 0) + 1);
  const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return most.endsWith("N") && counts.has(`${most}W`) ? `${most}W` : most;
}

/** A line's cells as the common shape has them, with no words where it leaves its last words out; undefined when it has another shape. */
function fitted(cells: Cell[], shape: string): Cell[] | undefined {
  const own = shapeOf(cells);
  if (own === shape) return cells;
  return shape === `${own}W` ? [...cells, { kind: "words", words: [] }] : undefined;
}

const WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Whether the first word of a run of words is a choice: a few different words, each a plain word,
 * at least one of them said on more than one line.
 */
function isChoice(firsts: readonly string[]): boolean {
  const distinct = new Set(firsts.map((w) => w.toLowerCase()));
  return firsts.length >= 3 && distinct.size <= MAX_CHOICES && distinct.size < firsts.length && firsts.every((w) => WORD.test(w));
}

/**
 * Reads lines into fields and rows. A date at the start or end of most lines is when each row
 * happened. What is left is read by shape: each number is a number field (money or a measure when
 * its sign or ending says so), and each run of words is a choice when its first word is one of a
 * few said again and again, with the words after it a text field, else a text field. The fields
 * keep the order the lines give them, so the capture line reads the same lines afterwards.
 */
export function inferRows(text: string, now: Date): Inferred {
  const skipped: Inferred["skipped"] = [];
  const reads: Read[] = [];
  const lines = text.split(/\r?\n/).map(unmarked).filter((l) => l !== "").slice(0, MAX_LINES);
  // Where the date is, by the first lines: at the start, at the end, or nowhere.
  const dateAtStart = (tokens: readonly Token[]) => dateAt(tokens.map((t) => t.text), now);
  const dateAtEnd = (tokens: readonly Token[]) => {
    for (const n of [3, 2, 1]) {
      const tail = tokens.slice(-n);
      const d = tail.length === n && tail.every((t) => !t.quoted) ? dateAt(tail.map((t) => t.text), now) : undefined;
      if (d && d.used === n) return d;
    }
    return undefined;
  };
  const tokenized = lines.map((l) => tokenize(l));
  const ok = tokenized.filter((t): t is Token[] => Array.isArray(t));
  const share = (find: (t: readonly Token[]) => unknown) => (ok.length ? ok.filter((t) => find(t)).length / ok.length : 0);
  const where = share(dateAtStart) >= 0.6 ? "start" : share(dateAtEnd) >= 0.6 ? "end" : undefined;
  lines.forEach((line, i) => {
    const tokens = tokenized[i];
    if (!Array.isArray(tokens)) return void skipped.push({ line: i + 1, text: line, why: tokens.error });
    const d = where === "start" ? dateAtStart(tokens) : where === "end" ? dateAtEnd(tokens) : undefined;
    if (where && !d) return void skipped.push({ line: i + 1, text: line, why: `no date at its ${where}, as the other lines have` });
    const rest = d ? (where === "start" ? tokens.slice(d.used) : tokens.slice(0, -d.used)) : tokens;
    reads.push({ line: i + 1, text: line, ...(d && { date: d.date }), cells: cellsOf(rest) });
  });
  const shape = commonShape(reads);
  const shaped = reads.flatMap((r) => {
    const cells = fitted(r.cells, shape);
    if (cells) return [{ ...r, cells }];
    skipped.push({ line: r.line, text: r.text, why: "its numbers and words aren't in the places the other lines have them" });
    return [];
  });
  // A column holds one unit: ¥1500 kept beside $4 would add up as 1504 of nothing.
  const unitIn = (cell: Cell) => (cell.kind === "number" ? cell.unit?.id : undefined);
  const usual = [...shape].map((_, c) => {
    const counts = new Map<string, number>();
    for (const r of shaped) {
      const unit = unitIn(r.cells[c]);
      if (unit !== undefined) counts.set(unit, (counts.get(unit) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  });
  const kept = shaped.filter((r) => {
    const c = r.cells.findIndex((cell, i) => unitIn(cell) !== undefined && unitIn(cell) !== usual[i]);
    if (c < 0) return true;
    skipped.push({ line: r.line, text: r.text, why: `it is in ${unitIn(r.cells[c])}, and the other lines are in ${usual[c]}` });
    return false;
  });
  skipped.sort((a, b) => a.line - b.line);
  const fields: [string, string | string[]][] = [];
  const formats: Record<string, string> = {};
  const names = new Set<string>();
  const name = (base: string) => {
    let n = base;
    for (let i = 2; names.has(n); i++) n = `${base}${i}`;
    names.add(n);
    return n;
  };
  /** For each cell of the shape, the fields it fills and how a line's cell becomes their values. */
  const columns: ((cell: Cell, row: Row) => void)[] = [];
  [...shape].forEach((letter, c) => {
    const cells = kept.map((r) => r.cells[c]);
    if (letter === "N") {
      const units = cells.flatMap((x) => (x.kind === "number" && x.unit ? [x.unit] : []));
      const unit = units.length > 0 && units.length >= cells.length / 2 ? units[0] : undefined;
      const field = name(unit?.dim === "money" ? "amount" : unit ? unit.dim.replace(/^mass$/, "weight") : fields.some(([, t]) => t === "number") ? "number" : "amount");
      fields.push([field, unit ? unit.id : "number"]);
      // A unit shows itself; a plain number shows the decimals its lines write, two for cents, three at most.
      const most = Math.min(3, Math.max(0, ...cells.map((x) => (x.kind === "number" ? x.decimals : 0))));
      if (!unit && most > 0) formats[field] = `0,0.${"0".repeat(most)}`;
      columns.push((cell, row) => { if (cell.kind === "number") row[field] = cell.n; });
      return;
    }
    const runs = cells.map((x) => (x.kind === "words" ? x.words : []));
    const firsts = runs.map((w) => w[0]);
    const more = runs.some((w) => w.length > 1);
    if (runs.every((w) => w.length > 0) && isChoice(firsts)) {
      const options = [...new Map(firsts.map((w) => [w.toLowerCase(), w])).values()];
      const choice = name("category");
      fields.push([choice, options]);
      const note = more ? name("note") : undefined;
      if (note) fields.push([note, "text"]);
      columns.push((cell, row) => {
        if (cell.kind !== "words") return;
        row[choice] = options.find((o) => o.toLowerCase() === cell.words[0].toLowerCase()) ?? cell.words[0];
        if (note) row[note] = cell.words.slice(1).join(" ");
      });
      return;
    }
    const field = name("note");
    fields.push([field, "text"]);
    columns.push((cell, row) => { if (cell.kind === "words") row[field] = cell.words.join(" "); });
  });
  const rows = kept.map((r) => {
    // Noon of its day: a row with only a date still sorts and counts on that day in every zone nearby.
    const at = r.date === undefined ? stampOf(now) : stampOf(new Date(`${r.date}T12:00`));
    const row: Row = { at };
    r.cells.forEach((cell, c) => columns[c](cell, row));
    return row;
  });
  return { fields, formats, rows, dated: where !== undefined, skipped };
}

// ---- The answer ------------------------------------------------------------------------------------

/** A question the ask grammar reads that gives the number the person stated. */
export interface Candidate {
  /** The ask line, after `?` and the kind's name. */
  ask: string;
  /** The panel it stands for, reading the kind by its link. */
  panel: Record<string, unknown>;
  value: number;
  /** How many of the rows it counts. */
  rows: number;
  /** Among candidates that give the same number: a row this one counts and the first one doesn't, or the other way, in words. */
  differs?: string;
}

/** What a stated answer says: the number, and the words before `=`, which narrow the search. */
export function readAnswer(text: string): { value: number; words: string[] } | { error: string } {
  const at = text.lastIndexOf("=");
  if (at < 0) return { error: "write what you know as words = number, e.g. food this week = 62.30" };
  const value = toNumber(text.slice(at + 1).replace(/[^0-9.,+-]/g, ""));
  if (value === undefined) return { error: "after = goes the number you know" };
  return { value, words: text.slice(0, at).trim().split(/\s+/).filter(Boolean) };
}

const WINDOWS = ["", "today", "yesterday", "this week", "this month", "this year", "last 7 days", "last 30 days", "last 3 months", "last 12 months"];
const AGGS = ["sum", "avg", "count", "min", "max", "last"];
const FILLER = new Set(["in", "on", "of", "for", "the", "total", "spent", "is", "was", "my", "all"]);

/** The rows a panel's steps keep, and the one number it shows for them. */
function runPanel(panel: Record<string, unknown>, rows: readonly Row[], now: Date): { value: number; kept: Row[] } | undefined {
  const { lines: _lines, ...keys } = panel;
  const checked = checkPanel({ ...keys, source: "rows" }, true);
  if (!checked.panel || checked.errors.length) return undefined;
  const p: Panel = checked.panel;
  const kept = compilePipeline(p, now)(rows);
  const value = toNumber(valueOf(p, kept, now));
  return value === undefined || !Array.isArray(kept) ? undefined : { value, kept: kept as Row[] };
}

/**
 * Every ask over these rows that gives the stated number, to half a cent: an aggregate, of each
 * number field, over each value of a choice field or none, in each window or none. Words before `=`
 * that the grammar knows (an aggregate, a field, a value, a window) must be in the ask; the others
 * are given back as not used. The shortest ask comes first, a sum before the others.
 */
export function findPanels(kind: AskKind, rows: readonly Row[], answer: { value: number; words: string[] }, now: Date): { candidates: Candidate[]; unused: string[] } {
  const numbers = Object.entries(kind.fields).filter(([, t]) => t === "number").map(([f]) => f);
  const values = Object.entries(kind.fields).flatMap(([f, t]) => (Array.isArray(t) ? t.map((v) => ({ field: f, value: String(v) })) : []));
  const said = answer.words.map((w) => w.toLowerCase());
  const phrase = said.join(" ");
  const wantAgg = AGGS.filter((a) => said.includes(a) || (a === "avg" && said.includes("average")));
  const wantField = numbers.filter((f) => said.includes(f.toLowerCase()));
  const wantValues = values.filter((v) => said.includes(v.value.toLowerCase()));
  const wantWindow = WINDOWS.filter((w) => w && phrase.includes(w));
  const known = new Set([...wantAgg, "average", ...wantField.map((f) => f.toLowerCase()), ...wantValues.map((v) => v.value.toLowerCase()), ...wantWindow.flatMap((w) => w.split(" "))]);
  const unused = answer.words.filter((w) => !known.has(w.toLowerCase()) && !FILLER.has(w.toLowerCase()));
  const aggs = wantAgg.length ? wantAgg : AGGS;
  const windows = wantWindow.length ? wantWindow : WINDOWS;
  const filters = wantValues.length ? [wantValues] : [[], ...values.map((v) => [v])];
  const found: (Candidate & { kept: Set<Row> })[] = [];
  const seen = new Set<string>();
  for (const agg of aggs) {
    for (const field of agg === "count" ? [undefined] : wantField.length ? wantField : numbers) {
      for (const filter of filters) {
        for (const window of windows) {
          // The first number field and a sum are what an ask means without saying.
          const words = [agg === "sum" ? "" : agg, field !== undefined && field !== numbers[0] ? field : "", ...filter.map((v) => v.value), window].filter(Boolean);
          const ask = words.join(" ");
          const asked = parseAsk(`${kind.name} ${ask}`, [kind], now);
          if (!asked.ok || asked.panel.view !== "number") continue;
          const run = runPanel(asked.panel, rows, now);
          if (!run || Math.abs(run.value - answer.value) >= 0.005) continue;
          // Two asks that count the same rows the same way are one answer: the shorter is kept.
          const same = `${agg}|${field}|${run.kept.map((r) => rows.indexOf(r)).join(",")}`;
          if (seen.has(same)) continue;
          seen.add(same);
          found.push({ ask, panel: asked.panel, value: run.value, rows: run.kept.length, kept: new Set(run.kept) });
        }
      }
    }
  }
  found.sort((a, b) => a.ask.split(" ").filter(Boolean).length - b.ask.split(" ").filter(Boolean).length || AGGS.indexOf(textOf(a.panel.agg ?? "sum")) - AGGS.indexOf(textOf(b.panel.agg ?? "sum")));
  const first = found[0];
  const words = (r: Row) => Object.entries(r).filter(([k]) => k !== "at").map(([, v]) => textOf(v ?? "")).filter(Boolean).join(" ");
  const candidates = found.slice(0, 8).map(({ kept, ...c }, i): Candidate => {
    if (i === 0 || !first) return c;
    const only = [...kept].find((r) => !first.kept.has(r));
    const missing = [...first.kept].find((r) => !kept.has(r));
    return { ...c, ...(only ? { differs: `also counts “${words(only)}”` } : missing ? { differs: `leaves out “${words(missing)}”` } : { differs: "counts the same rows another way" }) };
  });
  return { candidates, unused };
}

// ---- The notes -------------------------------------------------------------------------------------

/** A kind as an ask reads it, from inferred fields and rows. */
export function askKindOf(name: string, path: string, inferred: Inferred): AskKind {
  const fields = Object.fromEntries(inferred.fields.map(([f, t]) => [f, unitDef(typeof t === "string" ? t : "") ? "number" : t]));
  const seen: Record<string, string[]> = {};
  for (const [f, t] of inferred.fields) {
    if (Array.isArray(t)) seen[f] = t.map(String);
    else if (t === "text") seen[f] = [...new Set(inferred.rows.map((r) => textOf(r[f] ?? "")).filter(Boolean))];
  }
  return { path, name, shortcut: name, fields, seen };
}

/** Why a name can't be the kind's, or undefined: letters, digits and `_`, as `kind:` takes. */
export function exampleNameProblem(name: string): string | undefined {
  if (!name.trim()) return "Give the rows a name, e.g. spend";
  return kindProblem(name);
}

/** The kind note's text: its name, the word that adds a row from a capture line, and its fields. */
export function kindNoteText(name: string, inferred: Inferred): string {
  const typed = (f: string, t: string | string[]) => (inferred.formats[f] === undefined ? t : { type: t, format: inferred.formats[f] });
  return ["---", `kind: ${name}`, `shortcut: ${name}`, "fields:", ...inferred.fields.map(([f, t]) => `  ${f}: ${yamlInline(typed(f, t))}`), "---", ""].join("\n");
}

/** The app note's text: a line to add a row, each panel kept, and the rows, newest first. */
export function appNoteText(purpose: string, kindLink: string, panels: readonly Record<string, unknown>[]): string {
  const item = (panel: Record<string, unknown>) => panelLines(panel).map((l, i) => `${i ? "    " : "  - "}${l}`);
  return [
    "---",
    `app: ${yamlInline(purpose)}`,
    "panels:",
    ...item({ view: "form", title: "Add", save: kindLink }),
    ...panels.flatMap(item),
    ...item({ view: "table", title: "Rows", source: kindLink, sort: "-at" }),
    "---",
    "",
  ].join("\n");
}
