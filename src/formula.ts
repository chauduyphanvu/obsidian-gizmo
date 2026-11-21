import { copyRow, getPath, toNumber, type Row } from "./data.ts";
import { stampParts, toTime, wallTime } from "./time.ts";

/**
 * Formulas for `compute`: a small, pure expression language over one row. Text is tokenized,
 * parsed to a tree and compiled to a closure once; running it never throws (a failure is null).
 * `$name` reads a value from `env.vars`; values are never parsed as formula text.
 */

/** What a formula reads besides its row. */
export interface FormulaEnv {
  /** The row before, with its own computed columns; undefined on the first row. */
  prev: Row | undefined;
  /** The values `$name` reads: app inputs, component params. */
  vars: Readonly<Record<string, unknown>>;
  now: Date;
}

export type Formula = (row: Row, env: FormulaEnv) => unknown;

/** Every function a formula may call, with the fewest and most arguments it takes. */
export const FORMULA_FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = {
  round: [1, 2], floor: [1, 1], ceil: [1, 1], abs: [1, 1], min: [1, Infinity], max: [1, Infinity],
  if: [3, 3], coalesce: [1, Infinity], number: [1, 1], text: [1, 1], lower: [1, 1], upper: [1, 1],
  trim: [1, 1], len: [1, 1], contains: [2, 2], startswith: [2, 2], endswith: [2, 2], replace: [3, 3],
  date: [1, 1], year: [1, 1], month: [1, 1], day: [1, 1], weekday: [1, 1], hour: [1, 1], days: [2, 2],
  today: [0, 0], now: [0, 0], prev: [1, 1], field: [1, 1],
};

/** Hand-typed formulas are short; these bounds keep a pathological one from hanging or overflowing. */
const MAX_LENGTH = 2000;
const MAX_NESTING = 32;
/**
 * The longest text a formula makes. Chained `replace` or `+` grow text exponentially (three
 * replaces of ten letters make 100 million characters), so longer text is missing instead.
 */
export const MAX_TEXT = 100_000;

// ---- Tokens ----------------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "name"; v: string; at: number }
  | { t: "var"; v: string; path: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

class FormulaError extends Error {}

const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const PATH = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/y;
const VAR = /\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)/y;
const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", ","];
const ESCAPES: Record<string, string> = { n: "\n", t: "\t" };

function sticky(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const at = i + 1;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = sticky(NUMBER, text, i);
      if (!m) throw new FormulaError(`can't read "${ch}" at character ${at}`);
      out.push({ t: "num", v: Number(m[0]), at });
      i += m[0].length;
    } else if (ch === '"' || ch === "'") {
      let v = "";
      let j = i + 1;
      for (; j < text.length && text[j] !== ch; j++) {
        if (text[j] === "\\" && j + 1 < text.length) v += ESCAPES[text[++j]] ?? text[j];
        else v += text[j];
      }
      if (j >= text.length) throw new FormulaError(`the text starting at character ${at} needs a closing ${ch}`);
      out.push({ t: "str", v, at });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = sticky(PATH, text, i)!;
      out.push({ t: "name", v: m[0], at });
      i += m[0].length;
    } else if (ch === "$") {
      const m = sticky(VAR, text, i);
      if (!m) throw new FormulaError(`"$" at character ${at} needs a name after it, e.g. $symbol`);
      out.push({ t: "var", v: m[1], path: m[2].slice(1), at });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => text.startsWith(o, i));
      if (!op) {
        const hint = ch === "=" ? "; compare with ==" : ch === "&" ? "; use && for and" : ch === "|" ? "; use || for or" : "";
        throw new FormulaError(`can't read "${ch}" at character ${at}${hint}`);
      }
      out.push({ t: "op", v: op, at });
      i += op.length;
    }
  }
  out.push({ t: "end", at: text.length + 1 });
  return out;
}

// ---- Tree --------------------------------------------------------------------------------------

type Node =
  | { k: "lit"; v: unknown }
  | { k: "field"; path: string }
  | { k: "var"; name: string; path: string }
  | { k: "unary"; op: string; a: Node }
  | { k: "binary"; op: string; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[] };

/** Binary operators from loosest to tightest; each level is left-associative. */
const LEVELS = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];
const LITERALS: Record<string, unknown> = { true: true, false: false, null: null };

function plural(n: number): string {
  return `${n} argument${n === 1 ? "" : "s"}`;
}

function arity(fn: string, [min, max]: readonly [number, number]): string {
  if (max === Infinity) return `"${fn}" takes at least ${plural(min)}`;
  if (min === max) return min === 0 ? `"${fn}" takes no arguments` : `"${fn}" takes ${plural(min)}`;
  return `"${fn}" takes ${min} or ${plural(max)}`;
}

function parse(tokens: Token[]): Node {
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek().t === "op" && (peek() as { v: string }).v === v;
  const describe = (tok: Token) => (tok.t === "end" ? "the end" : `character ${tok.at}`);
  const nest = <T>(f: () => T): T => {
    if (++depth > MAX_NESTING) throw new FormulaError(`the formula nests more than ${MAX_NESTING} levels deep`);
    const out = f();
    depth--;
    return out;
  };

  const binary = (level: number): Node => {
    if (level === LEVELS.length) return unary();
    let a = binary(level + 1);
    while (peek().t === "op" && LEVELS[level].includes((peek() as { v: string }).v)) {
      const op = (tokens[pos++] as { v: string }).v;
      a = { k: "binary", op, a, b: binary(level + 1) };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp("-") || isOp("!")) {
      const op = (tokens[pos++] as { v: string }).v;
      return nest(() => ({ k: "unary", op, a: unary() }));
    }
    return primary();
  };
  const primary = (): Node => {
    const tok = tokens[pos];
    if (tok.t === "num" || tok.t === "str") { pos++; return { k: "lit", v: tok.v }; }
    if (tok.t === "var") { pos++; return { k: "var", name: tok.v, path: tok.path }; }
    if (tok.t === "name") {
      pos++;
      if (isOp("(")) return call(tok.v, tok.at);
      if (Object.hasOwn(LITERALS, tok.v)) return { k: "lit", v: LITERALS[tok.v] };
      return { k: "field", path: tok.v };
    }
    if (tok.t === "op" && tok.v === "(") {
      pos++;
      const inner = nest(() => binary(0));
      if (!isOp(")")) throw new FormulaError(`expected ")" at ${describe(peek())}`);
      pos++;
      return inner;
    }
    if (tok.t === "end") throw new FormulaError("the formula ends where a value should be");
    throw new FormulaError(`expected a value at character ${tok.at}, not "${tok.v}"`);
  };
  const call = (fn: string, at: number): Node => {
    if (!Object.hasOwn(FORMULA_FUNCTIONS, fn)) throw new FormulaError(`unknown function "${fn}"`);
    pos++;
    const args = nest(() => {
      const list: Node[] = [];
      if (isOp(")")) return list;
      for (;;) {
        list.push(binary(0));
        if (!isOp(",")) return list;
        pos++;
      }
    });
    if (!isOp(")")) throw new FormulaError(`expected ")" to close ${fn}( from character ${at}, at ${describe(peek())}`);
    pos++;
    const range = FORMULA_FUNCTIONS[fn];
    if (args.length < range[0] || args.length > range[1]) throw new FormulaError(`${arity(fn, range)}, not ${args.length}`);
    return { k: "call", fn, args };
  };

  if (tokens[0].t === "end") throw new FormulaError("the formula is empty");
  const tree = binary(0);
  const rest = peek();
  if (rest.t !== "end") throw new FormulaError(`unexpected ${rest.t === "op" ? `"${rest.v}"` : "value"} at character ${rest.at}`);
  return tree;
}

function callsPrev(n: Node): boolean {
  if (n.k === "call") return n.fn === "prev" || n.args.some(callsPrev);
  if (n.k === "unary") return callsPrev(n.a);
  if (n.k === "binary") return callsPrev(n.a) || callsPrev(n.b);
  return false;
}

/**
 * Whether a `compute` map's formulas read only their own row, so computing a row doesn't depend
 * on which rows come before it: none calls prev. One that can't be read counts as not.
 */
export function computesRowByRow(compute: Record<string, string | number>): boolean {
  return Object.values(compute).every((text) => {
    try {
      return !callsPrev(parse(tokenize(String(text))));
    } catch {
      return false;
    }
  });
}

/** The row fields a tree reads, by their first name, and the `$names` it reads; fields are "*" when `field()` names one only as it runs. */
function readsOf(n: Node, out: { fields: Set<string> | "*"; vars: Map<string, { name: string; path: string }> }): void {
  if (n.k === "field" && out.fields !== "*") out.fields.add(n.path.split(".")[0]);
  if (n.k === "var") out.vars.set(`${n.name}.${n.path}`, { name: n.name, path: n.path });
  if (n.k === "call" && n.fn === "field") out.fields = "*";
  const kids = n.k === "unary" ? [n.a] : n.k === "binary" ? [n.a, n.b] : n.k === "call" ? n.args : [];
  for (const k of kids) readsOf(k, out);
}

/**
 * What a formula reads, for working out what its result is made of: the row fields (or "*" when it
 * may read any, through `field()` with a name it works out) and the `$names` with the path read in
 * each; undefined when it can't be read.
 */
export function formulaReads(text: string): { fields: string[] | "*"; vars: { name: string; path: string }[] } | undefined {
  try {
    const out = { fields: new Set<string>() as Set<string> | "*", vars: new Map<string, { name: string; path: string }>() };
    readsOf(parse(tokenize(text)), out);
    return { fields: out.fields === "*" ? "*" : [...out.fields], vars: [...out.vars.values()] };
  } catch {
    return undefined;
  }
}

function varsIn(n: Node, out: Set<string>): Set<string> {
  if (n.k === "var") out.add(n.name);
  else if (n.k === "unary") varsIn(n.a, out);
  else if (n.k === "binary") { varsIn(n.a, out); varsIn(n.b, out); }
  else if (n.k === "call") for (const a of n.args) varsIn(a, out);
  return out;
}

// ---- Values ------------------------------------------------------------------------------------

/** A number for arithmetic: numbers and numeric text; true/false and anything else aren't. */
function num(v: unknown): number | undefined {
  return typeof v === "boolean" ? undefined : toNumber(v);
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return stampParts(v).date;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false && v !== 0 && v !== "" && !Number.isNaN(v);
}

const missing = (v: unknown) => v === null || v === undefined;

function arithmetic(f: (a: number, b: number) => number): (a: unknown, b: unknown) => unknown {
  return (a, b) => {
    const x = num(a), y = num(b);
    if (x === undefined || y === undefined) return null;
    const r = f(x, y);
    return Number.isFinite(r) ? r : null;
  };
}

/** Numbers compare as numbers, dates as times (a stamp's offset counts), text as text; anything else, or a missing value, doesn't compare. */
function compare(a: unknown, b: unknown): number | undefined {
  if (missing(a) || missing(b)) return undefined;
  const x = num(a), y = num(b);
  if (x !== undefined && y !== undefined) return x - y;
  if (typeof a === "string" && typeof b === "string") {
    const ta = toTime(a), tb = toTime(b);
    if (ta !== undefined && tb !== undefined) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return undefined;
}

function equal(a: unknown, b: unknown): boolean {
  if (missing(a) || missing(b)) return missing(a) && missing(b);
  const x = num(a), y = num(b);
  return x !== undefined && y !== undefined ? x === y : str(a) === str(b);
}

const ordered = (test: (c: number) => boolean) => (a: unknown, b: unknown) => {
  const c = compare(a, b);
  return c === undefined ? null : test(c);
};

const BINARY: Record<string, (a: unknown, b: unknown) => unknown> = {
  "+": (a, b) => {
    if (typeof a !== "string" && typeof b !== "string") return arithmetic((x, y) => x + y)(a, b);
    if (missing(a) || missing(b)) return null;
    const x = str(a), y = str(b);
    return x.length + y.length > MAX_TEXT ? null : x + y;
  },
  "-": arithmetic((x, y) => x - y),
  "*": arithmetic((x, y) => x * y),
  "/": arithmetic((x, y) => x / y),
  "%": arithmetic((x, y) => x % y),
  "==": equal,
  "!=": (a, b) => !equal(a, b),
  "<": ordered((c) => c < 0),
  "<=": ordered((c) => c <= 0),
  ">": ordered((c) => c > 0),
  ">=": ordered((c) => c >= 0),
};

const DAY = 86_400_000;

function onNumber(f: (n: number) => number) {
  return ([x]: unknown[]) => {
    const n = num(x);
    return n === undefined ? null : f(n);
  };
}

function onText(f: (s: string, ...rest: string[]) => unknown) {
  return (args: unknown[]) => (args.some(missing) ? null : f(...(args.map(str) as [string, ...string[]])));
}

/** A date's parts as lived: a stamp saved abroad has the date and hour it had there. */
function onTime(f: (d: Date) => unknown) {
  return ([x]: unknown[]) => {
    const t = wallTime(x);
    return t === undefined ? null : f(new Date(t));
  };
}

function round([x, digits]: unknown[]): unknown {
  const n = num(x);
  const d = digits === undefined ? 0 : num(digits);
  if (n === undefined || d === undefined) return null;
  const f = 10 ** Math.trunc(d);
  // toPrecision drops binary noise first, so 1.005 rounds to 1.01 as typed.
  const r = Math.round(Number((Math.abs(n) * f).toPrecision(15))) / f;
  return n < 0 ? -r || 0 : r;
}

function numbersIn(args: unknown[]): number[] {
  return args.map(num).filter((n): n is number => n !== undefined);
}

/** Functions that take their arguments' values; if, coalesce, prev, field, today and now are compiled specially. */
const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  round,
  floor: onNumber(Math.floor),
  ceil: onNumber(Math.ceil),
  abs: onNumber(Math.abs),
  // min and max skip missing values, as a spreadsheet does, so a first row's prev() doesn't blank them.
  min: (args) => { const ns = numbersIn(args); return ns.length ? Math.min(...ns) : null; },
  max: (args) => { const ns = numbersIn(args); return ns.length ? Math.max(...ns) : null; },
  number: ([x]) => toNumber(x) ?? null,
  text: ([x]) => (missing(x) ? null : str(x)),
  lower: onText((s) => s.toLowerCase()),
  upper: onText((s) => s.toUpperCase()),
  trim: onText((s) => s.trim()),
  len: ([x]) => (missing(x) ? null : Array.isArray(x) ? x.length : str(x).length),
  contains: ([t, part]) => {
    if (missing(t) || missing(part)) return null;
    return Array.isArray(t) ? t.some((v) => equal(v, part)) : str(t).includes(str(part));
  },
  startswith: onText((s, part) => s.startsWith(part)),
  endswith: onText((s, part) => s.endsWith(part)),
  replace: onText((s, from, to) => {
    if (from === "") return s;
    const parts = s.split(from);
    // Known before the text is made, so it is never made when it would be too long.
    return s.length + (parts.length - 1) * (to.length - from.length) > MAX_TEXT ? null : parts.join(to);
  }),
  date: onTime((d) => stampParts(d).date),
  year: onTime((d) => d.getFullYear()),
  month: onTime((d) => d.getMonth() + 1),
  day: onTime((d) => d.getDate()),
  weekday: onTime((d) => ((d.getDay() + 6) % 7) + 1),
  hour: onTime((d) => d.getHours()),
  days: ([a, b]) => {
    const ta = wallTime(a), tb = wallTime(b);
    if (ta === undefined || tb === undefined) return null;
    const start = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    return Math.round((start(tb) - start(ta)) / DAY);
  },
};

// ---- Compiling ---------------------------------------------------------------------------------

function compile(n: Node): Formula {
  switch (n.k) {
    case "lit": { const v = n.v; return () => v; }
    case "field": { const path = n.path; return (row) => getPath(row, path); }
    case "var": {
      const { name, path } = n;
      return (_row, env) => getPath(Object.hasOwn(env.vars, name) ? env.vars[name] : undefined, path);
    }
    case "unary": {
      const a = compile(n.a);
      if (n.op === "!") return (row, env) => !truthy(a(row, env));
      return (row, env) => { const x = num(a(row, env)); return x === undefined ? null : -x || 0; };
    }
    case "binary": {
      const a = compile(n.a), b = compile(n.b);
      if (n.op === "&&") return (row, env) => truthy(a(row, env)) && truthy(b(row, env));
      if (n.op === "||") return (row, env) => truthy(a(row, env)) || truthy(b(row, env));
      const f = BINARY[n.op];
      return (row, env) => f(a(row, env), b(row, env));
    }
    case "call": return compileCall(n.fn, n.args.map(compile));
  }
}

function compileCall(fn: string, args: Formula[]): Formula {
  switch (fn) {
    case "if": { const [c, t, e] = args; return (row, env) => (truthy(c(row, env)) ? t(row, env) : e(row, env)); }
    case "coalesce":
      return (row, env) => {
        for (const a of args) {
          const v = a(row, env);
          if (!missing(v)) return v;
        }
        return null;
      };
    case "prev": {
      const [a] = args;
      return (_row, env) => (env.prev ? a(env.prev, { ...env, prev: undefined }) : null);
    }
    case "field": {
      const [a] = args;
      return (row, env) => { const k = a(row, env); return missing(k) ? null : getPath(row, str(k)); };
    }
    case "today": return (_row, env) => stampParts(env.now).date;
    case "now": return (_row, env) => stampParts(env.now).at;
  }
  const f = FUNCTIONS[fn];
  return (row, env) => f(args.map((a) => a(row, env)));
}

/** What a run gives back: null for missing and non-finite values, and for text longer than MAX_TEXT. */
function settle(v: unknown): unknown {
  if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) return null;
  if (typeof v === "string" && v.length > MAX_TEXT) return null;
  return v;
}

/**
 * Compiles one formula. With `knownVars`, a `$name` outside it is an error. `vars` lists the
 * `$names` the formula reads. Messages have no location prefix.
 */
export function compileFormula(text: string, knownVars?: ReadonlySet<string>): { run: Formula; vars: string[] } | { error: string } {
  if (text.length > MAX_LENGTH) return { error: `the formula is longer than ${MAX_LENGTH} characters` };
  let tree: Node;
  try {
    tree = parse(tokenize(text));
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.message };
    throw e;
  }
  const vars = [...varsIn(tree, new Set())];
  const unknown = knownVars && vars.find((v) => !knownVars.has(v));
  if (unknown) return { error: `$${unknown} isn't an input or param` };
  const f = compile(tree);
  const run: Formula = (row, env) => {
    try {
      return settle(f(row, env));
    } catch {
      return null;
    }
  };
  return { run, vars };
}

/** Check-time problems with a `compute` map, as `compute.<name>: <problem>`. */
export function computeErrors(compute: Record<string, string | number>, knownVars?: ReadonlySet<string>): string[] {
  return Object.entries(compute).flatMap(([name, text]) => {
    const f = compileFormula(String(text), knownVars);
    return "error" in f ? [`compute.${name}: ${f.error}`] : [];
  });
}

const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/**
 * `compute` as one step: each row is copied (cached responses are shared) and gets a column per
 * formula, in the order typed, so later formulas see earlier columns. A single object is one row;
 * anything else passes through. Formulas that don't compile were reported at check time and are skipped.
 */
export function compileCompute(compute: Record<string, string | number>, vars: Readonly<Record<string, unknown>>, now: Date): (data: unknown) => unknown {
  const columns: [string, Formula][] = [];
  for (const [name, text] of Object.entries(compute)) {
    const f = compileFormula(String(text));
    if ("run" in f) columns.push([name, f.run]);
  }
  const add = (source: Row, prev: Row | undefined): Row => {
    const row = copyRow(source);
    const env: FormulaEnv = { prev, vars, now };
    for (const [name, run] of columns) row[name] = run(row, env);
    return row;
  };
  return (data) => {
    if (isRow(data)) return add(data, undefined);
    if (!Array.isArray(data)) return data;
    let prev: Row | undefined;
    return (data as unknown[]).map((r) => (isRow(r) ? (prev = add(r, prev)) : r));
  };
}
