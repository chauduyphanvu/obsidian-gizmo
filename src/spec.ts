import { PERIODS, stampParts, type Agg, type Per } from "./data.ts";
import { storeTarget } from "./store.ts";
import {
  namesIn, nearMisses, parseInputs, readInputs, refusedPlaces, resolveInputs, type InputDef, type InputValue,
} from "./template.ts";
import { expandPanel, readBlocks } from "./expand.ts";
import { COMMON_KEYS, KEY_TYPES, isPlainObject, readValue } from "./views/common.ts";
import { VIEW_DEFS, viewDef } from "./views/registry.ts";

export interface Panel {
  view: string;
  title?: string;
  tab?: string;
  span?: number;
  source?: string;
  headers?: Record<string, string>;
  pick?: string;
  from?: string;
  where?: Record<string, string | number | boolean>;
  sort?: string;
  limit?: number;
  group?: string;
  per?: Per;
  x?: string;
  y?: string | string[];
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

/** One panel of an app, as written and as drawn. */
export interface PanelSpec {
  /** The panel's keys as written; hashing them gives the panel its identity. */
  template: Record<string, unknown>;
  /** The checked keys the panel draws with. */
  panel: Panel;
  /** Where the panel is written, for messages: "panel 2"; empty for a single top-level panel. */
  label: string;
  /** Inputs the panel uses; it is drawn again when one of them changes. */
  inputs: string[];
  /** Panels in a `panels` list are checked strictly; a single top-level panel isn't. */
  strict: boolean;
}

export interface AppSpec {
  /** Link or path of the note that holds recorded data, when not the default `<App> data.md`. */
  store?: string;
  description: string;
  panels: PanelSpec[];
  refreshMs?: number;
  inputs: InputDef[];
}

/** Where each input starts: its first choice, or today. */
export function startingValues(defs: InputDef[], now: Date): Record<string, InputValue> {
  return Object.fromEntries(defs.map((d) => [d.name, d.kind === "date" ? stampParts(now).date : d.options[0]]));
}

/** The panel with these input values filled in, checked. */
export function resolvePanel(ps: PanelSpec, values: Readonly<Record<string, InputValue>>): { panel?: Panel; errors: string[] } {
  if (ps.inputs.length === 0) return { panel: ps.panel, errors: [] };
  return checkPanel(resolveInputs(ps.template, values) as Record<string, unknown>, ps.strict);
}

/** The language version this plugin reads. */
export const SPEC_VERSION = 1;

/** Top-level keys that define an app or component; lists may never be named after them. */
export const RESERVED = ["app", "panels", "refresh", "store", "spec", "data", "inputs", "use", "with", "component", "params"];

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
    const read = readValue(key as keyof Panel, value);
    if ("error" in read) errors.push(read.error);
    else panel[key] = read.value;
  }
  const p = panel as unknown as Panel;
  const problems = [
    ...(def.needsSource && !p.source ? [`${def.id} needs a source`] : []),
    ...(def.validate?.(p) ?? []),
    ...(p.source === "notes" && !p.from ? ['source "notes" needs "from" (a #tag or folder)'] : []),
    ...(p.source && /^http:\/\//i.test(p.source) ? ["source must use https"] : []),
    ...(p.line && !p.append ? ['"line" needs "append"'] : []),
    ...(p.per && !p.group ? ['"per" needs "group"'] : []),
    ...(p.span !== undefined && ![1, 2, 3, 4].includes(p.span) ? ["span must be 1, 2, 3 or 4"] : []),
    ...(p.per && !PERIODS.includes(p.per) ? [`per must be one of ${PERIODS.join(", ")}`] : []),
    ...(p.group === "count" ? ['group can\'t be "count"; every group gets a count'] : []),
    ...(p.save && RESERVED.includes(p.save) ? [`save can't use "${p.save}", which names part of the app`] : []),
    ...(isListName(p.source) && RESERVED.includes(p.source) ? [`source can't use "${p.source}", which names part of the app`] : []),
    ...(p.source && /^https?:\/\/[^/?#]*\{secret:/i.test(p.source) ? ["a secret can't be part of the host; put it in the path, the query or headers"] : []),
  ];
  return { panel: problems.length ? undefined : p, errors: [...errors, ...problems] };
}

/** A source that names a list in the data note or app note (not a URL, not `notes`). */
export function isListName(source: string | undefined): source is string {
  return !!source && source !== "notes" && !isUrl(source);
}

function checkVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === SPEC_VERSION) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > SPEC_VERSION) {
    return `spec: ${value} needs a newer Note Apps (this one reads spec ${SPEC_VERSION})`;
  }
  return `spec must be ${SPEC_VERSION}`;
}

/** Reads an app from a note's frontmatter. Returns undefined when the note isn't an app. */
export function readSpec(fm: Record<string, unknown> | undefined, opts: { now?: Date } = {}): SpecResult | undefined {
  if (!fm || fm.app === undefined || fm.app === null || fm.app === false) return undefined;
  const description = fm.app === true ? "" : String(fm.app);
  const versionError = checkVersion(fm.spec);
  // Keys written for a newer version may mean something else, so nothing is drawn.
  if (versionError) return { errors: [versionError], empty: false };
  const errors: string[] = [];
  const panels: PanelSpec[] = [];
  const blocks = readBlocks(fm.data, errors);
  const inputs = readInputs(fm.inputs, errors);
  const names = new Set(inputs.map((d) => d.name));
  const start = startingValues(inputs, opts.now ?? new Date());
  const used = new Set<string>();
  const add = (raw: Record<string, unknown>, label: string, strict: boolean) => {
    const at = (e: string) => (label ? `${label}: ${e}` : e);
    const expanded = expandPanel(raw, blocks);
    errors.push(...expanded.errors.map(at));
    errors.push(...nearMisses(expanded.template, names, "input").map(at));
    const refused = refusedPlaces(expanded.template, names, "input");
    errors.push(...refused.map(at));
    if (refused.length) return;
    const template = parseInputs(expanded.template, names) as Record<string, unknown>;
    const uses = [...namesIn(template, names)];
    for (const n of uses) used.add(n);
    const r = checkPanel(resolveInputs(template, start) as Record<string, unknown>, strict);
    errors.push(...r.errors.map(at));
    // Any choice can be picked, so each must make a valid panel too.
    for (const def of inputs) {
      if (def.kind !== "choice" || !uses.includes(def.name)) continue;
      for (const option of def.options.slice(1)) {
        const other = checkPanel(resolveInputs(template, { ...start, [def.name]: option }) as Record<string, unknown>, strict)
          .errors.filter((e) => !r.errors.includes(e));
        if (other.length === 0) continue;
        errors.push(...other.map((e) => at(`${e} (when $${def.name} is ${option})`)));
        break;
      }
    }
    if (r.panel) panels.push({ template, panel: r.panel, label, inputs: uses, strict });
  };

  if (Array.isArray(fm.panels)) {
    fm.panels.forEach((raw, i) => {
      const label = `panel ${i + 1}`;
      if (!isPlainObject(raw)) return errors.push(`${label}: must be a set of keys`);
      add(raw, label, true);
    });
    if (fm.panels.length === 0) return { errors, empty: true };
  } else if (fm.view !== undefined) {
    // The note's other properties aren't part of the panel.
    add(Object.fromEntries(Object.entries(fm).filter(([k]) => k in KEY_TYPES)), "", false);
  } else {
    return { errors, empty: true };
  }

  for (const d of inputs) if (!used.has(d.name)) errors.push(`input "${d.name}" isn't used by any panel`);

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
  return { spec: { description, panels, refreshMs, store, inputs }, errors, empty: false };
}

export function secretsIn(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/\{secret:([a-z0-9-]+)\}/g)].map((m) => m[1]);
}

/** What an app is allowed to do, as stable strings. Writes to the note itself need no grant. */
export function permissionsOf(spec: AppSpec, selfPath: string): string[] {
  const out = new Set<string>();
  for (const { panel: p } of spec.panels) {
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
