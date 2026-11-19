import { isPlainObject } from "./views/common.ts";

/**
 * `$name` values. A name is replaced only where it is declared: an app's `inputs`, or a component's
 * `params`. Anything else that looks like one (`$filter` in an OData URL, `$5`) stays as typed.
 * Input references are kept as objects, never as `$` text, so substituted text is never scanned
 * again and a component's own `$words` can't pick up an app's inputs.
 */
const TOKEN = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type InputValue = string | number | boolean;

export class InputRef {
  input: string;
  constructor(name: string) {
    this.input = name;
  }
}

/** Text with input references inside; inside a URL the values are percent-encoded. */
export class InputText {
  parts: (string | InputRef)[];
  encode: boolean;
  constructor(parts: (string | InputRef)[], encode: boolean) {
    this.parts = parts;
    this.encode = encode;
  }
}

/** Declared names used in a value: its text, its list items and its map values (never map keys). */
export function namesIn(value: unknown, names: ReadonlySet<string>, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(TOKEN)) if (names.has(m[1])) out.add(m[1]);
  } else if (value instanceof InputRef) {
    out.add(value.input);
  } else if (value instanceof InputText) {
    for (const p of value.parts) if (p instanceof InputRef) out.add(p.input);
  } else if (Array.isArray(value)) {
    for (const v of value) namesIn(v, names, out);
  } else if (isPlainObject(value) && !(value instanceof Date)) {
    for (const v of Object.values(value)) namesIn(v, names, out);
  }
  return out;
}

function split(text: string, names: ReadonlySet<string>): (string | InputRef)[] {
  const parts: (string | InputRef)[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (!names.has(m[1])) continue;
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push(new InputRef(m[1]));
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * Formulas keep their text: a `$name` in one is a value the formula reads (bound by expansion as
 * the panel's `vars`), never text spliced into it.
 */
function formulas(key: string, k: string): boolean {
  return key === "" && k === "compute";
}

/** Replaces declared input names with references; `key` is the panel key the value belongs to. */
export function parseInputs(value: unknown, names: ReadonlySet<string>, key = ""): unknown {
  if (typeof value === "string") {
    const parts = split(value, names);
    if (parts.length === 1 && parts[0] instanceof InputRef) return parts[0];
    return parts.some((p) => p instanceof InputRef) ? new InputText(parts, key === "source") : value;
  }
  if (Array.isArray(value)) return value.map((v) => parseInputs(v, names, key));
  if (isPlainObject(value) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, formulas(key, k) ? v : parseInputs(v, names, key || k)]));
  }
  return value;
}

/** Fills input references with values. Nothing is scanned again, so a value can't add references. */
export function resolveInputs(value: unknown, values: Readonly<Record<string, InputValue>>): unknown {
  if (value instanceof InputRef) return values[value.input];
  if (value instanceof InputText) {
    return value.parts.map((p) => {
      if (!(p instanceof InputRef)) return p;
      const text = String(values[p.input]);
      return value.encode ? encodeURIComponent(text) : text;
    }).join("");
  }
  if (Array.isArray(value)) return value.map((v) => resolveInputs(v, values));
  if (isPlainObject(value) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveInputs(v, values)]));
  }
  return value;
}

/** Keys a `$name` can never fill: they decide how an app is laid out and what it reads and writes. */
const FIXED = [
  "view", "tab", "span", "from", "append", "store",
  "select", "shortcut", "pin", "template", "edit", "cells", "layout", "stack", "compare",
];

/**
 * Where a declared name may not go, so that what an app may touch (hosts, secrets, notes read and
 * written) is settled from the keys before anything runs. `kind` says which names these are:
 * params may name a list as a whole `source` or `save`; inputs may not.
 */
export function refusedPlaces(raw: Record<string, unknown>, names: ReadonlySet<string>, kind: "input" | "param"): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const used = [...namesIn(value, names)];
    if (used.length === 0) continue;
    const first = `$${used[0]}`;
    const whole = typeof value === "string" && value === first;
    if (FIXED.includes(key)) {
      errors.push(`${first} can't be used in "${key}"`);
    } else if (key === "source" && typeof value === "string" && /^https?:\/\//i.test(value)) {
      if (!/^https:\/\/[^/?#$]+[/?#]/.test(value.slice(0, value.indexOf("$")))) errors.push(`${first} can't be part of a URL's host`);
      else if (/\{secret:[^}]*\$/.test(value)) errors.push(`${first} can't name a secret`);
    } else if (key === "source" || key === "save") {
      if (kind === "input") errors.push(`${first} can't choose ${key === "save" ? "where data is saved" : "the source"}; use it in a URL's path or query, or in where`);
      else if (!whole) errors.push(`${first} can only be the whole ${key}, naming a list`);
    } else if (key === "headers" && JSON.stringify(value).match(/\{secret:[^}]*\$/)) {
      errors.push(`${first} can't name a secret`);
    }
  }
  return errors;
}

/** A value a param or input option may hold: no secrets and no line breaks, since headers take it raw. */
export function unsafeValue(v: unknown): boolean {
  const text = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return text.includes("{secret:") || /[\r\n]/.test(text);
}

/** One substitution, insertion, deletion or swap of neighbours apart. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length !== b.length) return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  if (a.slice(i + 1) === b.slice(i + 1)) return true;
  return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/** `$words` one typo away from a declared name, e.g. `$sybmol` beside `symbol`. */
export function nearMisses(raw: unknown, names: ReadonlySet<string>, kind: "input" | "param"): string[] {
  const words = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(TOKEN)) words.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v) && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) if (k !== "compute") walk(x);
  };
  walk(raw);
  const out: string[] = [];
  for (const w of words) {
    if (names.has(w)) continue;
    const close = [...names].find((n) => oneEditApart(w, n));
    if (close) out.push(`"$${w}" isn't ${kind === "input" ? "an input" : "a param"} (did you mean $${close}?)`);
  }
  return out;
}

export interface InputDef {
  name: string;
  /** A dropdown of choices (starting at the first), or a date bar (starting today). */
  kind: "choice" | "date";
  options: InputValue[];
}

export function readInputs(value: unknown, errors: string[]): InputDef[] {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value)) {
    errors.push("inputs must be named, e.g. inputs: {symbol: [SPY, QQQ]}");
    return [];
  }
  const defs: InputDef[] = [];
  for (const [name, def] of Object.entries(value)) {
    const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
    if (!NAME.test(name)) errors.push(`inputs: "${name}" can only use letters, digits and _`);
    else if (def === "date") defs.push({ name, kind: "date", options: [] });
    else if (!Array.isArray(def) || def.length === 0 || !def.every(scalar)) errors.push(`inputs.${name} must be a list of choices or date`);
    else if (def.some(unsafeValue)) errors.push(`inputs.${name}: a choice can't hold a secret or a line break`);
    else defs.push({ name, kind: "choice", options: def as InputValue[] });
  }
  return defs;
}

/** Input references in an already-parsed value (references only, never `$` text). */
export function refsIn(value: unknown): string[] {
  return [...namesIn(value, new Set())];
}

function asText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return undefined;
}

/**
 * Fills a component's declared params. A whole `$name` takes the value as given (a number stays a
 * number, a list a list, and an app input passed through `with` stays a reference); inside text it
 * becomes text, percent-encoded inside a URL. Inserted values are never scanned again.
 */
export function fillParams(value: unknown, params: ReadonlyMap<string, unknown>, errors: string[], key = ""): unknown {
  if (typeof value === "string") {
    const parts = split(value, new Set(params.keys()));
    if (!parts.some((p) => p instanceof InputRef)) return value;
    if (parts.length === 1) return params.get((parts[0] as InputRef).input);
    const encode = key === "source";
    const text = (t: string) => (encode ? encodeURIComponent(t) : t);
    const out: (string | InputRef)[] = [];
    for (const part of parts) {
      if (!(part instanceof InputRef)) {
        out.push(part);
        continue;
      }
      const v = params.get(part.input);
      if (v instanceof InputRef) {
        out.push(v);
      } else if (v instanceof InputText) {
        for (const q of v.parts) out.push(q instanceof InputRef ? q : text(q));
      } else {
        const t = asText(v);
        if (t === undefined) {
          errors.push(`$${part.input} holds a list or a set of keys, so it can only be a whole value`);
          return value;
        }
        out.push(text(t));
      }
    }
    if (!out.some((p) => p instanceof InputRef)) return out.join("");
    const merged: (string | InputRef)[] = [];
    for (const p of out) {
      const last = merged[merged.length - 1];
      if (typeof p === "string" && typeof last === "string") merged[merged.length - 1] = last + p;
      else merged.push(p);
    }
    return new InputText(merged, encode);
  }
  if (value instanceof InputRef || value instanceof InputText || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => fillParams(v, params, errors, key));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, formulas(key, k) ? v : fillParams(v, params, errors, key || k)]));
  }
  return value;
}
