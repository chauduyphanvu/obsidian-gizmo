import { toNumber, type Row } from "./data.ts";
import { isPlainObject, readFields } from "./keys.ts";
import { rowIdOf } from "./ledger-store.ts";
import { lineOf } from "./kind.ts";
import { DAY, wallTime } from "./time.ts";
import { textOf } from "./text.ts";

/**
 * How two rows of a kind are told to be the same thing, field by field, as a kind's `match:` says:
 * the same value (`exact`), numbers at most `by` apart, numbers at most `pct` percent of the planned
 * or logged row's apart, dates at most `days` calendar days apart, or texts one of which holds the
 * other, case and spacing aside (`contains`).
 */
export type FieldRule =
  | { kind: "exact" }
  | { kind: "near"; by: number }
  | { kind: "percent"; pct: number }
  | { kind: "days"; days: number }
  | { kind: "contains" };
export type FieldRules = Record<string, FieldRule>;
/** One set of field rules, or several, any one of which pairs two rows: earlier ones first. */
export type MatchRule = FieldRules | FieldRules[];

const alternatives = (rule: MatchRule): FieldRules[] => (Array.isArray(rule) ? rule : [rule]);

/** Whether a rule pairs anything at all: one with no field pairs nothing. */
export function hasRule(rule: MatchRule): boolean {
  return alternatives(rule).some((r) => Object.keys(r).length > 0);
}

/**
 * The rule of a kind with no `match:`: each number field the same, and `at` at most 2 days apart.
 * A kind with no number field has none, since any two of its rows near in time would pair.
 */
function defaultRule(fields: Record<string, string | string[]>): MatchRule {
  const rule: FieldRules = Object.fromEntries(Object.entries(fields).filter(([, type]) => type === "number").map(([f]) => [f, { kind: "exact" }]));
  return Object.keys(rule).length ? { ...rule, at: { kind: "days", days: 2 } } : {};
}

const EXAMPLE = "e.g. match: {amount: exact, at: 2d}";

/** One set of field rules, each a field of the kind (or `at`); `at` names it in messages. What can't be used is told and left out. */
function readRules(value: Record<string, unknown>, fields: Record<string, string | string[]>, at: string, errors: string[]): FieldRules {
  const rule: FieldRules = {};
  for (const [field, how] of Object.entries(value)) {
    const type = field === "at" ? "at" : fields[field];
    if (type === undefined) {
      errors.push(`${at}: "${field}" isn't a field of the kind; its fields are ${["at", ...Object.keys(fields)].join(", ")}`);
      continue;
    }
    const text = typeof how === "string" ? how.trim() : undefined;
    const days = text === undefined ? null : /^(\d{1,3})d$/.exec(text);
    const pct = text === undefined ? null : /^(\d{1,3}(?:\.\d+)?)%$/.exec(text);
    const isText = type === "text" || type === "textarea";
    if (how === "exact") rule[field] = { kind: "exact" };
    else if (typeof how === "number" && how >= 0 && type === "number") rule[field] = { kind: "near", by: how };
    else if (pct && type === "number" && Number(pct[1]) <= 100) rule[field] = { kind: "percent", pct: Number(pct[1]) };
    else if (days && (type === "at" || type === "date")) rule[field] = { kind: "days", days: Number(days[1]) };
    else if (how === "contains" && isText) rule[field] = { kind: "contains" };
    else {
      const takes = type === "number" ? "exact, a number (e.g. 0.5) or a percent up to 100% (e.g. 20%)"
        : type === "at" || type === "date" ? "exact or a number of days, e.g. 2d"
        : isText ? "exact or contains" : "exact";
      errors.push(`${at}: ${field} takes ${takes}, not ${JSON.stringify(how)}`);
    }
  }
  return rule;
}

/**
 * A kind's `match:` against its fields: a set of field rules, or a list of them, any one of which
 * pairs two rows. Each field rule is `exact`; a number, or a percent, for a number field; `Nd` for a
 * date field or `at`; or `contains` for a text field. What can't be used is told and left out.
 * Without one, the default rule; one given replaces it whole.
 */
export function readMatch(value: unknown, fields: Record<string, string | string[]>): { rule: MatchRule; errors: string[] } {
  const errors: string[] = [];
  if (value === undefined || value === null) return { rule: defaultRule(fields), errors };
  if (Array.isArray(value)) {
    if (!value.length || !value.every(isPlainObject)) return { rule: {}, errors: [`match must be a set of field: how, or a list of them, ${EXAMPLE}`] };
    return { rule: value.map((v, i) => readRules(v, fields, `match ${i + 1}`, errors)), errors };
  }
  if (!isPlainObject(value)) return { rule: {}, errors: [`match must be a set of field: how, ${EXAMPLE}`] };
  return { rule: readRules(value, fields, "match", errors), errors };
}

/** A kind note's `match:` (or the default) as a rule, leaving out what it can't use; no rule for any other note. */
export function ruleOf(kindFm: Record<string, unknown> | undefined): MatchRule {
  const fields = kindFm?.fields;
  if (!isPlainObject(fields)) return {};
  return readMatch(kindFm!.match, readFields(fields).types).rule;
}

/** A date as a day number, from the clock where it was written, so every device counts the same days. */
function dayOf(v: unknown): number | undefined {
  const t = wallTime(v);
  if (t === undefined) return undefined;
  const d = new Date(t);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}

const same = (a: unknown, b: unknown) => {
  const x = toNumber(a), y = toNumber(b);
  if (x !== undefined && y !== undefined) return x === y;
  return (a ?? "") === (b ?? "") || textOf(a ?? "") === textOf(b ?? "");
};

const folded = (v: unknown) => textOf(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** One text holds the other, case and spacing aside; two empty ones agree, and an empty one holds nothing. */
function holds(a: unknown, b: unknown): boolean {
  const x = folded(a), y = folded(b);
  if (!x || !y) return x === y;
  return x.includes(y) || y.includes(x);
}

/**
 * Whether a row is the same thing as `base` (the planned row it may settle, or the logged row a
 * row from a file may pair with) under one set of field rules: every field it names agrees. A
 * percent is of `base`'s number, so every device reads it alike. One that names none pairs nothing.
 */
function fitsRules(row: Row, base: Row, rule: FieldRules): boolean {
  const entries = Object.entries(rule);
  if (!entries.length) return false;
  return entries.every(([field, how]) => {
    if (how.kind === "exact") return same(row[field], base[field]);
    if (how.kind === "contains") return holds(row[field], base[field]);
    if (how.kind === "near" || how.kind === "percent") {
      const x = toNumber(row[field]), y = toNumber(base[field]);
      if (x === undefined || y === undefined) return false;
      const by = how.kind === "near" ? how.by : (Math.abs(y) * how.pct) / 100;
      return Math.abs(x - y) <= by + 1e-9;
    }
    const x = dayOf(row[field]), y = dayOf(base[field]);
    return x !== undefined && y !== undefined && Math.abs(x - y) <= how.days;
  });
}

/** The first of a rule's sets that pairs `row` with `base`, by its place; undefined when none does. */
function fitting(row: Row, base: Row, rule: MatchRule): number | undefined {
  const i = alternatives(rule).findIndex((r) => fitsRules(row, base, r));
  return i < 0 ? undefined : i;
}

/** How far apart two rows are in time, by the date fields of the rule's set that pairs them: nearer pairs first. */
function apart(a: Row, b: Row, rule: FieldRules): number {
  let d = 0;
  for (const [field, how] of Object.entries(rule)) if (how.kind === "days") d += Math.abs((wallTime(a[field]) ?? 0) - (wallTime(b[field]) ?? 0));
  return d;
}

/**
 * The date field every set of a rule bounds, with the most days any of them allows; undefined when
 * a set bounds none, or they bound different fields, and then no day is out of reach.
 */
function reachOf(rule: MatchRule): { field: string; days: number } | undefined {
  let out: { field: string; days: number } | undefined;
  for (const r of alternatives(rule).filter((x) => Object.keys(x).length)) {
    const date = Object.entries(r).find(([, how]) => how.kind === "days") as [string, { days: number }] | undefined;
    if (!date || (out && out.field !== date[0])) return undefined;
    out = { field: date[0], days: Math.max(out?.days ?? 0, date[1].days) };
  }
  return out;
}

const idOf = (r: Row) => rowIdOf(r) ?? "";

/** What pairing a kind's imported rows with its logged rows found. */
export interface Matched {
  pairs: { attested: Row; logged: Row }[];
  /** Imported rows nothing logged pairs with. */
  attestedOnly: Row[];
  /** Logged rows, in the days the imported rows cover, that no imported row pairs with. */
  loggedOnly: Row[];
  /** Logged rows like one already paired with an imported row: the same thing logged twice. */
  loggedTwice: Row[];
}

/**
 * Pairs a kind's imported rows with its logged rows, one to one under `rule`: by the first of its
 * sets that pairs them, then the nearest in time, ties by the imported row's id, then the logged
 * row's, so every device finds the same pairs. A percent is of the logged row's number.
 * Imported rows already paired (`matched`) or set aside (dismissed) take no part, nor do the logged
 * rows they are paired with, nor rows accepted from a file (`imported`): two rows of one export are
 * two charges, so only rows logged by hand pair. With a date in the rule, logged rows outside the
 * days the imported rows cover are no part of it; with no rule, no logged row is.
 */
export function matchRows(attested: readonly Row[], logged: readonly Row[], rule: MatchRule): Matched {
  const taken = new Set(attested.flatMap((r) => (typeof r.matched === "string" ? [r.matched] : [])));
  const open = attested.filter((r) => lineOf(r) === "attested" && (r.matched === undefined || r.matched === null || r.matched === ""));
  const reach = reachOf(rule);
  const days = open.map((r) => (reach ? dayOf(r[reach.field]) : undefined)).filter((d): d is number => d !== undefined);
  const within = (r: Row) => {
    if (!reach || !days.length) return true;
    const d = dayOf(r[reach.field]);
    return d !== undefined && d >= Math.min(...days) - reach.days && d <= Math.max(...days) + reach.days;
  };
  const ruled = hasRule(rule);
  const byHand = (r: Row) => r.imported === undefined || r.imported === null || r.imported === "";
  const free = logged.filter((r) => ruled && lineOf(r) === "logged" && byHand(r) && !taken.has(idOf(r)) && within(r));
  const sets = alternatives(rule);
  const candidates: { a: Row; l: Row; k: number; d: number }[] = [];
  for (const a of open) {
    for (const l of free) {
      const k = fitting(a, l, rule);
      if (k !== undefined) candidates.push({ a, l, k, d: apart(a, l, sets[k]) });
    }
  }
  candidates.sort((x, y) => x.k - y.k || x.d - y.d || cmp(idOf(x.a), idOf(y.a)) || cmp(idOf(x.l), idOf(y.l)));
  const usedA = new Set<Row>();
  const usedL = new Set<Row>();
  const pairs: Matched["pairs"] = [];
  for (const { a, l } of candidates) {
    if (usedA.has(a) || usedL.has(l)) continue;
    usedA.add(a);
    usedL.add(l);
    pairs.push({ attested: a, logged: l });
  }
  const paired = pairs.map((p) => p.attested);
  const left = free.filter((l) => !usedL.has(l));
  const twice = left.filter((l) => paired.some((a) => fitting(a, l, rule) !== undefined));
  return {
    pairs,
    attestedOnly: open.filter((a) => !usedA.has(a)),
    loggedOnly: left.filter((l) => !twice.includes(l)),
    loggedTwice: twice,
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The planned row a newly logged row settles under `rule`: one not settled yet, by the first of the
 * rule's sets that pairs them, then the nearest in time, ties by id. A percent is of the planned
 * row's number.
 */
export function settledBy(row: Row, rows: readonly Row[], rule: MatchRule): Row | undefined {
  const sets = alternatives(rule);
  const open = rows.flatMap((r) => {
    const k = lineOf(r) === "planned" && (r.matched === undefined || r.matched === null || r.matched === "") ? fitting(row, r, rule) : undefined;
    return k === undefined ? [] : [{ r, k, d: apart(r, row, sets[k]) }];
  });
  return open.sort((x, y) => x.k - y.k || x.d - y.d || cmp(idOf(x.r), idOf(y.r)))[0]?.r;
}

/**
 * The planned rows that rows newly logged together settle under `rule` (see settledBy), one each:
 * the logged rows taken in the order of their ids, so every device that logs the same rows settles
 * the same planned rows. `rows` are the kind's rows before; each pair is the planned row and the
 * id of the row that settles it.
 */
export function settlements(logged: readonly { id: string; row: Row }[], rows: readonly Row[], rule: MatchRule): { plan: Row; id: string }[] {
  if (!hasRule(rule)) return [];
  const taken = new Set<Row>();
  const out: { plan: Row; id: string }[] = [];
  for (const { id, row } of [...logged].sort((a, b) => cmp(a.id, b.id))) {
    const plan = settledBy({ ...row, line: undefined }, rows.filter((r) => !taken.has(r)), rule);
    if (!plan || rowIdOf(plan) === undefined) continue;
    taken.add(plan);
    out.push({ plan, id });
  }
  return out;
}

/** What the reconcile card shows: how the kind's imported rows pair, and each one still open with the logged row it pairs with. */
export interface Reconcile {
  counts: { pairs: number; attestedOnly: number; loggedOnly: number; loggedTwice: number };
  open: { row: Row; pair?: Row }[];
}

/** The reconcile card of a kind's rows, every line of them; undefined while no imported row waits. */
export function reconcileOf(rows: readonly Row[], rule: MatchRule): Reconcile | undefined {
  // Rows from a writer of another vault, waiting for it to be accepted, are asked about with that writer, not here.
  const m = matchRows(rows.filter((r) => lineOf(r) === "attested" && r.writer === undefined), rows.filter((r) => lineOf(r) === "logged"), rule);
  const pairOf = new Map(m.pairs.map((p) => [p.attested, p.logged]));
  const open = [...m.pairs.map((p) => p.attested), ...m.attestedOnly].sort((a, b) => (wallTime(a.at) ?? 0) - (wallTime(b.at) ?? 0) || cmp(idOf(a), idOf(b)));
  if (!open.length) return undefined;
  return {
    counts: { pairs: m.pairs.length, attestedOnly: m.attestedOnly.length, loggedOnly: m.loggedOnly.length, loggedTwice: m.loggedTwice.length },
    open: open.map((row) => ({ row, ...(pairOf.has(row) && { pair: pairOf.get(row)! }) })),
  };
}
