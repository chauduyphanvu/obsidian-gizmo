import { toNumber, toTime } from "../data.ts";
import type { SourceDef } from "./types.ts";

/** What a base's filters read of one note: its properties, its path and its tags (`#a/b`). */
export interface BaseNote {
  props: Record<string, unknown>;
  path: string;
  tags: string[];
}

type Test = (n: BaseNote) => boolean;

interface Literal {
  value: string | number | boolean;
  /** Set for `date("…")`. */
  time?: number;
}

type Operand =
  | { kind: "ref"; text: string; get: (n: BaseNote) => unknown }
  | ({ kind: "literal"; text: string } & Literal)
  | { kind: "test"; text: string; test: Test };

/** The file a base source names: `[[Books.base]]` or a path such as `Bases/Books.base`. */
export function baseTarget(source: string): string | undefined {
  const link = source.match(/^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/);
  const target = (link ? link[1] : source).trim();
  return /\.base$/i.test(target) && !/[[\]]/.test(target) ? target : undefined;
}

const fileName = (n: BaseNote) => n.path.slice(n.path.lastIndexOf("/") + 1);

/** The `file.` properties a filter may compare, as the Bases docs name them. */
const FILE_PROPS: Record<string, (n: BaseNote) => string> = {
  "file.name": fileName,
  "file.basename": (n) => fileName(n).replace(/\.[^.]*$/, ""),
  "file.path": (n) => n.path,
  "file.folder": (n) => (n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "/"),
  "file.ext": (n) => /\.([^.]*)$/.exec(fileName(n))?.[1] ?? "",
};

const COMPARE = ["==", "!=", ">", ">=", "<", "<="];
const FLIP: Record<string, string> = { "==": "==", "!=": "!=", ">": "<", ">=": "<=", "<": ">", "<=": ">=" };

interface Token { kind: "name" | "text" | "number" | "op"; text: string }

const TOKEN = /\s*(?:([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\d+(?:\.\d+)?)|(==|!=|>=|<=|&&|\|\||\S))/uy;

function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  for (let at = 0; ;) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(expr);
    if (!m) return out;
    at = TOKEN.lastIndex;
    const kind = m[1] !== undefined ? "name" : m[2] !== undefined ? "text" : m[3] !== undefined ? "number" : "op";
    out.push({ kind, text: m[1] ?? m[2] ?? m[3] ?? m[4] });
  }
}

const unquote = (s: string) => s.slice(1, -1).replace(/\\(.)/gu, "$1");

function truthy(v: unknown): boolean {
  return !(v === undefined || v === null || v === false || v === 0 || v === "" || Number.isNaN(v) || (Array.isArray(v) && v.length === 0));
}

/**
 * How a value sits against a literal: -1, 0 or 1, or undefined when they can't be compared. A date
 * compares as a time, a number as a number (numeric text included), a boolean only for equality,
 * text as text.
 */
function order(v: unknown, lit: Literal): number | undefined {
  if (lit.time !== undefined) {
    const t = toTime(v);
    return t === undefined ? undefined : Math.sign(t - lit.time);
  }
  if (typeof lit.value === "number") {
    const n = typeof v === "number" || typeof v === "string" ? toNumber(v) : undefined;
    return n === undefined ? undefined : Math.sign(n - lit.value);
  }
  if (typeof lit.value === "boolean") return v === lit.value ? 0 : undefined;
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v);
  return s === lit.value ? 0 : s < lit.value ? -1 : 1;
}

function compare(v: unknown, op: string, lit: Literal): boolean {
  if (op === "!=") return !compare(v, "==", lit);
  const c = order(v, lit);
  if (c === undefined) return false;
  return op === "==" ? c === 0 : op === ">" ? c > 0 : op === ">=" ? c >= 0 : op === "<" ? c < 0 : c <= 0;
}

const bare = (tag: string) => tag.replace(/^#/, "").toLowerCase();

/** Parses one filter string into a test, or throws naming what Gizmo doesn't read. */
function compileLeaf(leaf: string, source: string): Test {
  const unreadable = (what: string) => new Error(`${source} uses ${what}, which Gizmo can't read`);
  const odd = () => new Error(`${source} has a filter Gizmo can't read: ${leaf}`);
  const tokens = tokenize(leaf);
  let i = 0;
  const peek = () => tokens[i];
  const expect = (text: string) => {
    if (peek()?.text !== text) throw odd();
    i++;
  };
  const named = (t: Token) => (t.kind === "op" ? `"${t.text}"` : t.text);

  const property = (name: string): ((n: BaseNote) => unknown) => {
    if (name in FILE_PROPS) return FILE_PROPS[name];
    const parts = name.split(".");
    if (parts.length === 1 && !["file", "formula", "note", "this"].includes(name)) return (n) => n.props[name];
    if (parts.length === 2 && parts[0] === "note") return (n) => n.props[parts[1]];
    throw unreadable(name);
  };

  const call = (name: string): Operand => {
    if (!["file.hasTag", "file.inFolder", "date"].includes(name)) throw unreadable(name);
    expect("(");
    const args: string[] = [];
    while (peek()?.text !== ")") {
      const a = operand();
      if (a.kind !== "literal" || typeof a.value !== "string" || a.time !== undefined) throw odd();
      args.push(a.value);
      if (peek()?.text !== ",") break;
      i++;
    }
    expect(")");
    const text = `${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    if (name === "file.hasTag") {
      if (args.length === 0) throw odd();
      const wanted = args.map(bare);
      return { kind: "test", text, test: (n) => n.tags.map(bare).some((t) => wanted.some((w) => t === w || t.startsWith(`${w}/`))) };
    }
    if (args.length !== 1) throw odd();
    if (name === "date") {
      const time = toTime(args[0].trim().replace(" ", "T"));
      if (time === undefined) throw odd();
      return { kind: "literal", text, value: args[0], time };
    }
    const folder = args[0].replace(/^\/+|\/+$/g, "");
    return { kind: "test", text, test: (n) => folder === "" || n.path.startsWith(`${folder}/`) };
  };

  const operand = (): Operand => {
    const t = tokens[i++];
    if (!t) throw odd();
    if (t.kind === "text") return { kind: "literal", text: t.text, value: unquote(t.text) };
    if (t.kind === "number") return { kind: "literal", text: t.text, value: Number(t.text) };
    if (t.text === "-" && peek()?.kind === "number") {
      const n = tokens[i++];
      return { kind: "literal", text: `-${n.text}`, value: -Number(n.text) };
    }
    if (t.kind === "op") throw unreadable(named(t));
    if (peek()?.text === "(") return call(t.text);
    if (peek()?.text === "[") throw unreadable(`${t.text}[…]`);
    if (t.text === "true" || t.text === "false") return { kind: "literal", text: t.text, value: t.text === "true" };
    return { kind: "ref", text: t.text, get: property(t.text) };
  };

  /** An operand read as true or false, or `!` before one. */
  const term = (): Test => {
    if (peek()?.text === "!") {
      i++;
      const inner = term();
      return (n) => !inner(n);
    }
    const o = operand();
    if (o.kind === "test") return o.test;
    if (o.kind === "ref") return (n) => truthy(o.get(n));
    throw odd();
  };

  const end = <T>(value: T): T => {
    if (i < tokens.length) throw unreadable(named(tokens[i]));
    return value;
  };

  if (tokens.length === 0) throw odd();
  if (peek().text === "!") return end(term());
  const start = i;
  const left = operand();
  const op = peek();
  if (!op || !COMPARE.includes(op.text)) {
    i = start;
    return end(term());
  }
  i++;
  const right = operand();
  end(undefined);
  if (left.kind === "ref" && right.kind === "literal") return (n) => compare(left.get(n), op.text, right);
  if (left.kind === "literal" && right.kind === "ref") return (n) => compare(right.get(n), FLIP[op.text], left);
  throw unreadable(`${left.text} ${op.text} ${right.text}`);
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A filter string, or a group holding one of `and` (all hold), `or` (any holds), `not` (none holds). */
function compileFilter(f: unknown, source: string): Test {
  if (typeof f === "string") return compileLeaf(f, source);
  if (isMap(f)) {
    const keys = Object.keys(f);
    const key = keys[0];
    if (keys.length !== 1 || !["and", "or", "not"].includes(key)) {
      throw new Error(`${source} has a filter group with ${keys.join(", ") || "nothing"} in it; a group holds one of and, or, not`);
    }
    const list = f[key];
    if (!Array.isArray(list)) throw new Error(`${source} has "${key}" without a list of filters under it`);
    const tests = list.map((x) => compileFilter(x, source));
    if (key === "and") return (n) => tests.every((t) => t(n));
    if (key === "or") return (n) => tests.some((t) => t(n));
    return (n) => !tests.some((t) => t(n));
  }
  throw new Error(`${source} has a filter Gizmo can't read: ${JSON.stringify(f)}`);
}

/**
 * Which notes a base (its YAML, read as data) matches: those its global `filters` let through,
 * every note when it has none. `source` names the base in errors.
 *
 * Only the global `filters` are read: a filter string, or nested `and` / `or` / `not` lists whose
 * leaves are `file.hasTag("a", …)` (nested tags count; case doesn't), `file.inFolder("x")` (sub-folders count),
 * a property compared with a literal (`==`, `!=`, `>`, `>=`, `<`, `<=`), or a property alone or
 * after `!`, read as true or false. A property is a note property, bare (`status`) or as
 * `note.status`, or one of `file.name`, `file.basename`, `file.path`, `file.folder`, `file.ext`; a
 * literal is quoted text, a number, true, false or `date("2026-01-31")`. Anything else in them is
 * an error naming it. A view with filters of its own is an error too: what it shows is narrower
 * than the base, and reading it as every note would let an edit reach notes it never showed. The
 * base's formulas, properties and summaries, and each view's order, grouping and limit, are not
 * read: the panel's own where, sort, limit and columns do that.
 */
export function compileBase(config: unknown, source: string): Test {
  if (config === null || config === undefined) return () => true;
  if (!isMap(config)) throw new Error(`${source} isn't a base: it should hold keys such as filters and views`);
  const filters = config.filters;
  const test = filters === null || filters === undefined ? () => true : compileFilter(filters, source);
  (Array.isArray(config.views) ? config.views : []).forEach((view, i) => {
    if (!isMap(view) || view.filters === undefined || view.filters === null) return;
    const name = typeof view.name === "string" && view.name.trim() ? view.name : `view ${i + 1}`;
    throw new Error(`${source} filters its view "${name}"; Gizmo reads only the base's own filters`);
  });
  return test;
}

/**
 * `source: "[[Books.base]]"` or `source: Bases/Books.base`: the notes an Obsidian base matches, as
 * the same rows `source: notes` gives. What it reads of the base is in compileBase.
 */
export const base: SourceDef = {
  id: "base",
  matches: (source) => baseTarget(source) !== undefined,
  validate: (p) => (p.from ? ['"from" doesn\'t apply to a base; its filters choose the notes'] : []),
  // A base's filters can change what it matches at any time, so it may read any note.
  permissions: () => [["read:*", "source"]],
  // The link can't be resolved here, so the base file is heard by name.
  deps: (p) => [`name:${baseTarget(p.source!)!.split("/").pop()}`, "notes:*"],
  async load(p, files, layer) {
    const source = p.source!;
    const path = layer.host.resolveFile(baseTarget(source)!, files.appPath);
    if (!path) throw new Error(`can't find ${source}`);
    let config: unknown;
    try {
      config = layer.host.parseYaml(await layer.host.readFile(path));
    } catch (e) {
      throw new Error(`can't read ${source}: ${(e as Error).message}`);
    }
    const keep = compileBase(config, source);
    return layer.allNotes().filter((r) => {
      const notePath = String(r.path);
      return keep({ path: notePath, tags: Array.isArray(r.tags) ? r.tags.map(String) : [], props: layer.host.frontmatter(notePath) ?? {} });
    });
  },
};
