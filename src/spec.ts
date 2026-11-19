export const VIEWS = [
  "number", "text", "line", "bar", "table", "list",
  "button", "form", "checklist", "countdown", "progress", "timer",
] as const;
export type ViewKind = (typeof VIEWS)[number];

export const AGGS = ["count", "sum", "avg", "min", "max", "first", "last"] as const;
export type Agg = (typeof AGGS)[number];

export interface Panel {
  view: ViewKind;
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
  description: string;
  panels: Panel[];
  refreshMs?: number;
}

type KeyType = "string" | "number" | "strings" | "stringMap" | "fieldMap" | "where";

const PANEL_KEYS: Record<keyof Panel, KeyType> = {
  view: "string", title: "string", source: "string", headers: "stringMap", pick: "string",
  from: "string", where: "where", sort: "string", limit: "number", x: "string", y: "string",
  field: "string", agg: "string", label: "string", unit: "string", decimals: "number",
  text: "string", item: "string", columns: "strings", max: "number", to: "string",
  minutes: "number", fields: "fieldMap", items: "strings", save: "string", append: "string",
  line: "string", notify: "string",
};

const NEEDS_SOURCE: ViewKind[] = ["number", "line", "bar", "table", "list", "progress"];
const ACTION_VIEWS: ViewKind[] = ["button", "form", "checklist", "timer"];
const FIELD_TYPES = ["text", "number", "date", "time", "checkbox", "textarea"];

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

function readPanel(raw: Record<string, unknown>, where: string, strict: boolean, errors: string[]): Panel | undefined {
  const at = where ? `${where}: ` : "";
  const panel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const type = PANEL_KEYS[key as keyof Panel];
    if (!type) {
      if (strict) errors.push(`${at}unknown key "${key}"`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (value instanceof Date && type === "string") {
      panel[key] = value.toISOString().slice(0, 10);
      continue;
    }
    if (!checkType(value, type)) {
      errors.push(`${at}"${key}" has the wrong type (expected ${type})`);
      continue;
    }
    panel[key] = type === "string" ? String(value) : value;
  }
  const p = panel as unknown as Panel;
  const before = errors.length;

  if (!VIEWS.includes(p.view)) {
    errors.push(`${at}view must be one of ${VIEWS.join(", ")}`);
    return undefined;
  }
  if (NEEDS_SOURCE.includes(p.view) && !p.source) errors.push(`${at}${p.view} needs a source`);
  if ((p.view === "line" || p.view === "bar") && (!p.x || !p.y)) errors.push(`${at}${p.view} needs x and y`);
  if (p.view === "text" && !p.text) errors.push(`${at}text needs a text template`);
  if (p.view === "countdown" && !p.to) errors.push(`${at}countdown needs "to" (a date)`);
  if (p.view === "countdown" && p.to && Number.isNaN(Date.parse(p.to))) errors.push(`${at}"to" is not a date`);
  if (p.view === "checklist" && !p.items?.length) errors.push(`${at}checklist needs items`);
  if (p.view === "timer" && !(p.minutes && p.minutes > 0)) errors.push(`${at}timer needs minutes`);
  if (p.view === "form" && !p.fields) errors.push(`${at}form needs fields`);
  if ((p.view === "button" || p.view === "form") && !p.save && !p.append && !p.notify) {
    errors.push(`${at}${p.view} needs at least one of save, append, notify`);
  }
  if (!ACTION_VIEWS.includes(p.view) && (p.append || p.notify || (p.save && p.view !== "checklist"))) {
    errors.push(`${at}save/append/notify only work on button, form, checklist, timer`);
  }
  if (p.line && !p.append) errors.push(`${at}"line" needs "append"`);
  if (p.source === "notes" && !p.from) errors.push(`${at}source "notes" needs "from" (a #tag or folder)`);
  if (p.source && /^http:\/\//i.test(p.source)) errors.push(`${at}source must use https`);
  if (p.agg && !AGGS.includes(p.agg)) errors.push(`${at}agg must be one of ${AGGS.join(", ")}`);
  for (const [name, type] of Object.entries(p.fields ?? {})) {
    if (typeof type === "string" && !FIELD_TYPES.includes(type)) {
      errors.push(`${at}field "${name}" type must be one of ${FIELD_TYPES.join(", ")} or a list of choices`);
    }
  }
  return errors.length === before ? p : undefined;
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
      const p = readPanel(raw, `panel ${i + 1}`, true, errors);
      if (p) panels.push(p);
    });
    if (fm.panels.length === 0) return { errors, empty: true };
  } else if (fm.view !== undefined) {
    const p = readPanel(fm, "", false, errors);
    if (p) panels.push(p);
  } else {
    return { errors, empty: true };
  }

  let refreshMs: number | undefined;
  if (fm.refresh !== undefined) {
    refreshMs = parseDuration(fm.refresh);
    if (!refreshMs) errors.push(`refresh must look like 30s, 5m, 1h`);
    else if (refreshMs < 10_000) refreshMs = 10_000;
  }
  return { spec: { description, panels, refreshMs }, errors, empty: false };
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
    default: return perm;
  }
}
