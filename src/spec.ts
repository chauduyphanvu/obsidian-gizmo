import type { Agg } from "./data.ts";
import { storeTarget } from "./store.ts";
import { COMMON_KEYS, KEY_TYPES, type KeyType } from "./views/common.ts";
import { VIEW_DEFS, viewDef } from "./views/registry.ts";

export interface Panel {
  view: string;
  title?: string;
  source?: string;
  headers?: Record<string, string>;
  pick?: string;
  from?: string;
  where?: Record<string, string | number | boolean>;
  sort?: string;
  limit?: number;
  x?: string;
  y?: string;
  field?: string;
  agg?: Agg;
  label?: string;
  unit?: string;
  decimals?: number;
  text?: string;
  item?: string;
  columns?: string[];
  max?: number;
  to?: string;
  minutes?: number;
  fields?: Record<string, string | string[]>;
  items?: string[];
  save?: string;
  append?: string;
  line?: string;
  notify?: string;
}

export interface AppSpec {
  /** Link or path of the note that holds recorded data, when not the default `<App> data.md`. */
  store?: string;
  description: string;
  panels: Panel[];
  refreshMs?: number;
}

/** Top-level keys that define the app; recorded data may never be written under these names. */
const RESERVED = ["app", "panels", "refresh", "store"];

export interface SpecResult {
  spec?: AppSpec;
  errors: string[];
  /** The note has an `app:` description but no panel keys yet. */
  empty: boolean;
}

export function isUrl(source: string | undefined): source is string {
  return !!source && /^https?:\/\//i.test(source);
}

export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return value * 60_000;
  if (typeof value !== "string") return undefined;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "s"];
  return Number(m[1]) * unit;
}

function checkType(value: unknown, type: KeyType): boolean {
  const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
  switch (type) {
    case "string": return typeof value === "string" || typeof value === "number";
    case "number": return typeof value === "number";
    case "strings": return Array.isArray(value) && value.every(scalar);
    case "stringMap":
    case "where":
      return isPlainObject(value) && Object.values(value).every(scalar);
    case "fieldMap":
      return isPlainObject(value) && Object.values(value).every(
        (v) => typeof v === "string" || (Array.isArray(v) && v.every(scalar)),
      );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks one panel. `strict` (panels in a `panels` list) reports keys that are unknown or don't
 * apply to the view; a single panel written at the top level shares the frontmatter with ordinary
 * note properties, so those are ignored there. Key-level problems are reported but still let the
 * panel show; missing or contradictory keys stop it. Messages carry no location prefix.
 */
export function checkPanel(raw: Record<string, unknown>, strict: boolean): { panel?: Panel; errors: string[] } {
  const def = typeof raw.view === "string" ? viewDef(raw.view) : undefined;
  if (!def) return { errors: [`view must be one of ${VIEW_DEFS.map((d) => d.id).join(", ")}`] };
  const allowed = new Set<string>([...COMMON_KEYS, ...def.keys]);
  const errors: string[] = [];
  const panel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const type = KEY_TYPES[key as keyof Panel];
    if (!type || !allowed.has(key)) {
      if (strict) errors.push(type ? `"${key}" doesn't apply to ${def.id}` : `unknown key "${key}"`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (value instanceof Date && type === "string") {
      panel[key] = value.toISOString().slice(0, 10);
      continue;
    }
    if (!checkType(value, type)) {
      errors.push(`"${key}" has the wrong type (expected ${type})`);
      continue;
    }
    panel[key] = type === "string" ? String(value) : value;
  }
  const p = panel as unknown as Panel;
  const problems = [
    ...(def.needsSource && !p.source ? [`${def.id} needs a source`] : []),
    ...(def.validate?.(p) ?? []),
    ...(p.source === "notes" && !p.from ? ['source "notes" needs "from" (a #tag or folder)'] : []),
    ...(p.source && /^http:\/\//i.test(p.source) ? ["source must use https"] : []),
    ...(p.line && !p.append ? ['"line" needs "append"'] : []),
    ...(p.save && RESERVED.includes(p.save) ? [`save can't use "${p.save}", which names part of the app`] : []),
  ];
  return { panel: problems.length ? undefined : p, errors: [...errors, ...problems] };
}

/** Reads an app from a note's frontmatter. Returns undefined when the note isn't an app. */
export function readSpec(fm: Record<string, unknown> | undefined): SpecResult | undefined {
  if (!fm || fm.app === undefined || fm.app === null || fm.app === false) return undefined;
  const description = fm.app === true ? "" : String(fm.app);
  const errors: string[] = [];
  const panels: Panel[] = [];

  if (Array.isArray(fm.panels)) {
    fm.panels.forEach((raw, i) => {
      if (!isPlainObject(raw)) return errors.push(`panel ${i + 1}: must be a set of keys`);
      const r = checkPanel(raw, true);
      errors.push(...r.errors.map((e) => `panel ${i + 1}: ${e}`));
      if (r.panel) panels.push(r.panel);
    });
    if (fm.panels.length === 0) return { errors, empty: true };
  } else if (fm.view !== undefined) {
    const r = checkPanel(fm, false);
    errors.push(...r.errors);
    if (r.panel) panels.push(r.panel);
  } else {
    return { errors, empty: true };
  }

  let refreshMs: number | undefined;
  if (fm.refresh !== undefined) {
    refreshMs = parseDuration(fm.refresh);
    if (!refreshMs) errors.push(`refresh must look like 30s, 5m, 1h`);
    else if (refreshMs < 10_000) refreshMs = 10_000;
  }
  let store: string | undefined;
  if (fm.store !== undefined && fm.store !== null) {
    if (typeof fm.store === "string" && fm.store.trim()) store = fm.store;
    else errors.push(`store must be a note, e.g. store: "[[Weight log]]"`);
  }
  return { spec: { description, panels, refreshMs, store }, errors, empty: false };
}

export function secretsIn(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/\{secret:([a-z0-9-]+)\}/g)].map((m) => m[1]);
}

/** What an app is allowed to do, as stable strings. Writes to the note itself need no grant. */
export function permissionsOf(spec: AppSpec, selfPath: string): string[] {
  const out = new Set<string>();
  for (const p of spec.panels) {
    if (isUrl(p.source)) {
      try {
        out.add(`net:${new URL(p.source.replace(/\{secret:[a-z0-9-]+\}/g, "x")).host}`);
      } catch {
        out.add(`net:${p.source}`);
      }
    }
    for (const id of [...secretsIn(p.source), ...Object.values(p.headers ?? {}).flatMap(secretsIn)]) {
      out.add(`secret:${id}`);
    }
    if (p.source === "notes" && p.from) out.add(`read:${p.from}`);
    if (p.append && notePath(p.append) !== selfPath) out.add(`write:${notePath(p.append)}`);
  }
  if (spec.store) out.add(`store:${notePath(storeTarget(spec.store))}`);
  return [...out].sort();
}

export function notePath(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

export function describePermission(perm: string): string {
  const [kind, ...rest] = perm.split(":");
  const what = rest.join(":");
  switch (kind) {
    case "net": return `Fetch data from ${what}`;
    case "secret": return `Use your saved secret "${what}"`;
    case "read": return `Read notes in ${what}`;
    case "write": return `Add lines to ${what}`;
    case "store": return `Save its data in ${what}`;
    default: return perm;
  }
}
