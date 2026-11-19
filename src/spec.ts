import { PERIODS, parseDuration, stampParts, type Agg, type Per } from "./data.ts";
import { computeErrors } from "./formula.ts";
import { sourceDef } from "./sources/registry.ts";
import { RESERVED, storeTarget } from "./store.ts";
import {
  readInputs, refsIn, resolveInputs, type InputDef, type InputValue,
} from "./template.ts";
import {
  Expander, MAX_PANELS, basename, checkVersion, componentParams, readBlocks, type NoteReader, type Produced, type Stage,
} from "./expand.ts";
import type { PipelineKeys } from "./pipeline.ts";
import { COMMON_KEYS, KEY_TYPES, isPlainObject, readValue, type PanelKey } from "./views/common.ts";
import { VIEW_DEFS, viewDef } from "./views/registry.ts";

export { parseDuration };

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
  compute?: Record<string, string | number>;
  select?: string;
  action?: string;
  row?: Record<string, string>;
  name?: string;
  template?: string;
  open?: string;
  edit?: string[];
  format?: string | Record<string, string>;
  labels?: Record<string, string>;
  values?: Record<string, Record<string, string>>;
  cells?: Record<string, string>;
  layout?: string;
  compare?: string;
  goal?: number;
  stack?: boolean;
  body?: string | Record<string, unknown>;
  start?: string;
  end?: string;
  shortcut?: string;
  pin?: string;
  alert?: string | Record<string, string | number | boolean>;
  /** Internal: the pipelines of the blocks above the one the panel names, root first. */
  upstream?: PipelineKeys[];
  /** Internal: the fields of the nearest block with `fields` up the panel's chain. */
  schema?: Record<string, string | string[]>;
  /** Internal: the values of the `$names` its own `compute` formulas read. */
  vars?: Record<string, unknown>;
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
  /** The note each key was typed in, so a permission can name the component that asks for it. */
  writtenIn: Record<string, string>;
}

export interface AppSpec {
  /** Link or path of the note that holds recorded data, when not the default `<App> data.md`. */
  store?: string;
  description: string;
  panels: PanelSpec[];
  refreshMs?: number;
  inputs: InputDef[];
  /** The app's own data blocks, checked, as typed (`$names` unfilled). */
  blocks: Record<string, Record<string, unknown>>;
  /** Component notes read while expanding (path → frontmatter), and the names of every `use` link. */
  read: Record<string, unknown>;
  links: string[];
}

/** Where each input starts: its first choice, or today. */
export function startingValues(defs: InputDef[], now: Date): Record<string, InputValue> {
  return Object.fromEntries(defs.map((d) => [d.name, d.kind === "date" ? stampParts(now).date : d.options[0]]));
}

/** The panel with these input values filled in, checked. */
export function resolvePanel(ps: PanelSpec, values: Readonly<Record<string, InputValue>>): { panel?: Panel; errors: string[] } {
  if (ps.inputs.length === 0) return { panel: ps.panel, errors: [] };
  return checkTemplate(resolveInputs(ps.template, values) as Record<string, unknown>, ps.strict);
}

/**
 * Checks a filled template: its typed keys through checkPanel, then the stages expansion added
 * for the blocks above the one it names. A stage's key-level problems drop the key; its other
 * problems stop the panel, as a panel's own do.
 */
function checkTemplate(t: Record<string, unknown>, strict: boolean): { panel?: Panel; errors: string[] } {
  const { upstream, schema, vars, ...keys } = t;
  const r = checkPanel(keys, strict);
  const errors = [...r.errors];
  const stages: PipelineKeys[] = [];
  let stopped = false;
  for (const { block, keys: raw } of (upstream ?? []) as Stage[]) {
    const s = readStage(raw);
    errors.push(...[...s.errors, ...s.problems].map((e) => `data.${block}: ${e}`));
    stopped ||= s.problems.length > 0;
    stages.push(s.stage);
  }
  if (!r.panel || stopped) return { errors };
  const panel: Panel = { ...r.panel };
  if (stages.length) panel.upstream = stages;
  if (schema) panel.schema = schema as Panel["schema"];
  if (vars) panel.vars = vars as Panel["vars"];
  return { panel, errors };
}

/** One block's pipeline keys, checked again once its `$names` are filled. */
function readStage(raw: Record<string, unknown>): { stage: PipelineKeys; errors: string[]; problems: string[] } {
  const stage: PipelineKeys = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const read = key === "vars" ? { value } : readValue(key as PanelKey, value);
    if ("error" in read) errors.push(read.error);
    else (stage as Record<string, unknown>)[key] = read.value;
  }
  return { stage, errors, problems: groupProblems(stage) };
}

function groupProblems(p: PipelineKeys): string[] {
  return [
    ...(p.per && !p.group ? ['"per" needs "group"'] : []),
    ...(p.per && !PERIODS.includes(p.per) ? [`per must be one of ${PERIODS.join(", ")}`] : []),
    ...(p.group === "count" ? ['group can\'t be "count"; every group gets a count'] : []),
  ];
}


export interface SpecResult {
  spec?: AppSpec;
  errors: string[];
  /** The note has an `app:` description but no panel keys yet. */
  empty: boolean;
}

export function isUrl(source: string | undefined): source is string {
  return !!source && sourceDef(source).id === "url";
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
    const type = KEY_TYPES[key as PanelKey];
    if (!type || !allowed.has(key)) {
      if (strict) errors.push(type ? `"${key}" doesn't apply to ${def.id}` : `unknown key "${key}"`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const read = readValue(key as PanelKey, value);
    if ("error" in read) errors.push(read.error);
    else panel[key] = read.value;
  }
  const formulaErrors = panel.compute ? computeErrors(panel.compute as Record<string, string | number>) : [];
  if (formulaErrors.length) {
    errors.push(...formulaErrors);
    delete panel.compute;
  }
  const p = panel as unknown as Panel;
  const problems = [
    ...(def.needsSource && !p.source ? [`${def.id} needs a source`] : []),
    ...(def.validate?.(p) ?? []),
    ...(p.source ? sourceDef(p.source).validate?.(p) ?? [] : []),
    ...(p.line && !p.append ? ['"line" needs "append"'] : []),
    ...groupProblems(p),
    ...(p.span !== undefined && ![1, 2, 3, 4].includes(p.span) ? ["span must be 1, 2, 3 or 4"] : []),
    ...(p.save && RESERVED.includes(p.save) ? [`save can't use "${p.save}", which names part of the app`] : []),
  ];
  return { panel: problems.length ? undefined : p, errors: [...errors, ...problems] };
}

/** A source that names a list in the data note or app note (not a URL, not `notes`). */
export function isListName(source: string | undefined): source is string {
  return !!source && sourceDef(source).id === "list";
}

/** Reads an app from a note's frontmatter. Returns undefined when the note isn't an app. */
export function readSpec(
  fm: Record<string, unknown> | undefined,
  opts: { now?: Date; notes?: NoteReader; path?: string } = {},
): SpecResult | undefined {
  if (!fm || fm.app === undefined || fm.app === null || fm.app === false) return undefined;
  let description = fm.app === true ? "" : String(fm.app);
  const versionError = checkVersion(fm.spec);
  // Keys written for a newer version may mean something else, so nothing is drawn.
  if (versionError) return { errors: [versionError], empty: false };
  const errors: string[] = [];
  const inputErrors: string[] = [];
  const inputs = readInputs(fm.inputs, inputErrors);
  const names = new Set(inputs.map((d) => d.name));
  const blocks = readBlocks(fm.data, errors, names);
  errors.push(...inputErrors);
  const start = startingValues(inputs, opts.now ?? new Date());
  const expander = new Expander(opts.notes, opts.path ?? "");
  const scope = expander.appScope(blocks, names);

  const panels: PanelSpec[] = [];
  const used = new Set<string>();
  let count = 0;
  const check = (p: Produced, strict: boolean) => {
    const at = (e: string) => (p.label ? `${p.label}: ${e}` : e);
    const uses = refsIn(p.template);
    for (const n of uses) used.add(n);
    const r = checkTemplate(resolveInputs(p.template, start) as Record<string, unknown>, strict);
    errors.push(...r.errors.map(at));
    // Any choice can be picked, so each must make a valid panel too.
    for (const def of inputs) {
      if (def.kind !== "choice" || !uses.includes(def.name)) continue;
      for (const option of def.options.slice(1)) {
        const other = checkTemplate(resolveInputs(p.template, { ...start, [def.name]: option }) as Record<string, unknown>, strict)
          .errors.filter((e) => !r.errors.includes(e));
        if (other.length === 0) continue;
        errors.push(...other.map((e) => at(`${e} (when $${def.name} is ${option})`)));
        break;
      }
    }
    if (r.panel) panels.push({ template: p.template, panel: r.panel, label: p.label, inputs: uses, strict, writtenIn: p.writtenIn });
  };
  // Each entry expands to one or more panels, checked in turn so each panel's problems stay together.
  const entry = (raw: Record<string, unknown>, label: string, strict: boolean) => {
    const before = expander.errors.length;
    const produced = expander.expand(raw, scope, label);
    errors.push(...expander.errors.slice(before));
    for (const p of produced) {
      if (++count === MAX_PANELS + 1) errors.push(`this app has more than ${MAX_PANELS} panels; only the first ${MAX_PANELS} are drawn`);
      if (count > MAX_PANELS) return;
      check(p, strict);
    }
  };
  if (fm.use !== undefined) {
    if (fm.panels !== undefined) errors.push("put - use: … inside panels to mix a component with other panels");
    else entry({ use: fm.use, with: fm.with }, "", true);
    if (!description) description = expander.describe(fm.use);
  } else if (Array.isArray(fm.panels)) {
    if (fm.panels.length === 0) return { errors, empty: true };
    fm.panels.forEach((raw, i) => {
      if (isPlainObject(raw)) entry(raw, `panel ${i + 1}`, true);
      else errors.push(`panel ${i + 1}: must be a set of keys`);
    });
  } else if (fm.view !== undefined) {
    // The note's other properties aren't part of the panel.
    entry(Object.fromEntries(Object.entries(fm).filter(([k]) => k in KEY_TYPES)), "", false);
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
  const spec = {
    description, panels, refreshMs, store, inputs, blocks: Object.fromEntries(blocks), read: expander.read, links: [...expander.links],
  };
  return { spec, errors, empty: false };
}

/** What opening a component note shows: how to use it, and a preview when every param has a default. */
export interface ComponentPreview {
  result: SpecResult;
  usage: string;
  /** Params without a default; the preview needs them all filled. */
  missing: string[];
}

export function isComponent(fm: Record<string, unknown> | undefined): boolean {
  return !!fm && fm.component !== undefined && fm.component !== null && fm.component !== false && fm.app === undefined;
}

/**
 * Reads a component note as an app that uses it. Params without a default are filled with their
 * own names, so its keys can still be checked; only a component whose params all have defaults
 * is drawn.
 */
export function readComponentPreview(fm: Record<string, unknown>, opts: { now?: Date; notes?: NoteReader; path: string }): ComponentPreview {
  const params = componentParams(fm.params) ?? new Map<string, unknown>();
  const missing = [...params].filter(([, v]) => v === undefined).map(([k]) => k);
  const self = opts.path.replace(/\.md$/i, "");
  const result = readSpec({
    app: fm.component === true ? "" : String(fm.component),
    use: `[[${self}]]`,
    with: Object.fromEntries(missing.map((n) => [n, n])),
  }, opts)!;
  const values = [...params].map(([k, v]) => `${k}: ${v === undefined ? "…" : typeof v === "string" ? v : JSON.stringify(v)}`);
  const usage = `panels:\n  - use: "[[${basename(opts.path)}]]"${values.length ? `\n    with: {${values.join(", ")}}` : ""}`;
  return { result, usage, missing };
}

/** A panel's permissions, each with the key that asks for it. */
function panelPermissions(p: Panel, selfPath: string): [string, keyof Panel][] {
  const out: [string, keyof Panel][] = p.source ? sourceDef(p.source).permissions(p, selfPath) : [];
  if (p.append && notePath(p.append) !== selfPath) out.push([`write:${notePath(p.append)}`, "append"]);
  return out;
}

/** What an app is allowed to do, as stable strings. Writes to the note itself need no grant. */
export function permissionsOf(spec: AppSpec, selfPath: string): string[] {
  const out = new Set<string>();
  for (const { panel } of spec.panels) for (const [perm] of panelPermissions(panel, selfPath)) out.add(perm);
  if (spec.store) out.add(`store:${notePath(storeTarget(spec.store))}`);
  return [...out].sort();
}

/** For each permission, the notes whose keys ask for it: the app itself or the components it uses. */
export function askersOf(spec: AppSpec, selfPath: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (perm: string, path: string) => {
    if (!out.has(perm)) out.set(perm, new Set());
    out.get(perm)!.add(path);
  };
  for (const ps of spec.panels) {
    for (const [perm, key] of panelPermissions(ps.panel, selfPath)) add(perm, ps.writtenIn[key] ?? selfPath);
  }
  if (spec.store) add(`store:${notePath(storeTarget(spec.store))}`, selfPath);
  return out;
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
