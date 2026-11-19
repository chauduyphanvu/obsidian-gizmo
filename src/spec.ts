import { PERIODS, parseDuration, stampParts, type Agg, type Per } from "./data.ts";
import { computeErrors } from "./formula.ts";
import { rowsAreNotes, sourceDef } from "./sources/registry.ts";
import { RESERVED, SOURCE_WORDS, basename, definitionReason, isApp, notePath, runsAsApp, storeTarget } from "./store.ts";
import {
  InputRef, InputText, NAME, THIS, firstRef, readInputs, readRef, refsIn, resolveInputs, resolveWith, secretIds, stringsIn,
  type InputDef, type InputValue,
} from "./template.ts";
import { namesIn } from "./template.ts";
import {
  Expander, MAX_PANELS, TAKEN, checkVersion, componentParams, panelEntries, readBlocks, readFor, selectOf, typedName,
  type NoteReader, type Produced, type Stage,
} from "./expand.ts";
import type { PipelineKeys } from "./pipeline.ts";
import { COMMON_KEYS, KEY_TYPES, isPlainObject, readFields, readValue, type FieldInfo, type PanelKey } from "./keys.ts";
import { editErrors, editPermissions, editableSource } from "./edit.ts";
import { VIEW_DEFS, viewDef } from "./views/registry.ts";
import { backgroundKeyErrors } from "./views/alerts.ts";

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
  row?: Record<string, string | number | boolean>;
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
  /** Another app's shortcut to run after this panel acts, or when its alert turns true. */
  then?: Then;
  /** A sentence about the row picked in the panel, drawn under its rows. */
  detail?: string;
  /** With `agg: share`: the rows counted, as a `where`-style map. */
  of?: Record<string, string | number | boolean>;
  /** Internal: the pipelines of the blocks above the one the panel names, root first. */
  upstream?: PipelineKeys[];
  /** Internal: the fields of the nearest block with `fields` up the panel's chain. */
  schema?: Record<string, string | string[]>;
  /** Internal: the values of the `$names` its own `compute` formulas read. */
  vars?: Record<string, unknown>;
  /** Internal: where `save` writes, settled from the keys (and the block `save` names) when checked. */
  target?: SaveTarget;
  /** Internal: the secrets typed whole in its source, headers and body; its requests may fill no other. */
  secrets?: string[];
  /** Internal: what its fields (a form's own, and the schema's) say besides their types. */
  fieldInfo?: Record<string, FieldInfo>;
}

/** `then`: the app (a link or name) and shortcut to run, and the values to fill its form with, as text with `{placeholders}`. */
export interface Then {
  app: string;
  do: string;
  fill?: Record<string, string>;
}

/**
 * Where a panel's `save` writes: a list in the app's data note, one new note per save in a folder,
 * or the properties of the note the app sits in (`save: this`; a lens's `scope` is its `for`, which
 * writing there needs permission for).
 */
export type SaveTarget = { kind: "list"; name: string } | { kind: "folder"; folder: string } | { kind: "this"; scope?: string };

/** What `save` text names on its own: the note the app sits in, a folder when it ends in a slash (`Books/`), else a list. */
export function saveTarget(save: string): SaveTarget {
  if (save === THIS) return { kind: "this" };
  return save.endsWith("/") ? { kind: "folder", folder: save.replace(/^\/+|\/+$/g, "") } : { kind: "list", name: save };
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
  /** Names panels select, app-wide: as typed, or `name@<use>` for a component's own. */
  selections: string[];
  /** The app's own data blocks, checked, as typed (`$names` unfilled). */
  blocks: Record<string, Record<string, unknown>>;
  /** Each block that records, as the panel it is read as while the app is closed: `view: table` naming it. */
  recorded: Record<string, PanelSpec>;
  /** Component notes read while expanding (path → frontmatter), and the names of every `use` link. */
  read: Record<string, unknown>;
  links: string[];
}

/** Where each input starts: its first choice, or today. A search box starts with no value. */
export function startingValues(defs: InputDef[], now: Date): Record<string, InputValue> {
  const out: Record<string, InputValue> = {};
  for (const d of defs) if (d.kind !== "text") out[d.name] = d.kind === "date" ? stampParts(now).date : d.options[0];
  return out;
}

/**
 * The panel with these values filled in, checked. A name the panel reads that has no value yet (a
 * selection nobody made, an empty search box) leaves it `waiting` for that name. A value that can't
 * be used (a secret or a line break in typed text, a row where text goes) is an error, and the
 * panel isn't drawn.
 */
export function resolvePanel(ps: PanelSpec, values: Readonly<Record<string, unknown>>): { panel?: Panel; errors: string[]; waiting?: string } {
  if (ps.inputs.length === 0) return { panel: ps.panel, errors: [] };
  const waiting = ps.inputs.find((n) => values[n] === undefined);
  if (waiting !== undefined) return { errors: [], waiting };
  const problems: string[] = [];
  const template = ps.inputs.includes(THIS) ? absentThis(ps.template, values[THIS]) : ps.template;
  const filled = resolveInputs(template, values, problems) as Record<string, unknown>;
  if (problems.length) return { errors: problems };
  const r = checkFilled(ps.template, filled, ps.strict);
  return r.panel ? { ...r, panel: keepRowTypes(r.panel, ps.template.row, filled.row) } : r;
}

/**
 * Checking makes every `row` value text. A value that was exactly one `$reference` keeps what the
 * reference gave, so a number picked from a row is saved as a number.
 */
function keepRowTypes(p: Panel, written: unknown, filled: unknown): Panel {
  if (!p.row || !isPlainObject(written) || !isPlainObject(filled)) return p;
  const typed = Object.keys(written).filter((k) => written[k] instanceof InputRef && k in p.row!);
  if (typed.length === 0) return p;
  return { ...p, row: { ...p.row, ...Object.fromEntries(typed.map((k) => [k, filled[k] as string | number | boolean])) } };
}

/**
 * A filled template checked, once no value has completed a secret placeholder: text typed beside a
 * literal `{` (`"{$q}"` holding `secret:demo}`) would otherwise name a secret the note never typed.
 */
function checkFilled(template: Record<string, unknown>, filled: Record<string, unknown>, strict: boolean): { panel?: Panel; errors: string[] } {
  const typed = (template.secrets ?? []) as string[];
  for (const key of ["source", "headers", "body"]) {
    if (!stringsIn(filled[key]).flatMap(secretIds).some((id) => !typed.includes(id))) continue;
    const ref = firstRef(template[key]);
    return { errors: [`${ref ? `$${typedName(ref.input)}` : "a value"} can't name a secret`] };
  }
  return checkTemplate(filled, strict);
}

/** A `where` condition no value meets: a comparison with nothing to compare against. */
const NO_ROW = "< (none)";

/**
 * A `$this` property the note doesn't have fills text as empty; as a `where` condition it matches no
 * row, rather than every row whose field is empty too.
 */
function absentThis(t: Record<string, unknown>, note: unknown): Record<string, unknown> {
  const fix = (keys: Record<string, unknown>): Record<string, unknown> => {
    if (!isPlainObject(keys.where)) return keys;
    const where = Object.entries(keys.where).map(([k, v]) =>
      [k, v instanceof InputRef && v.input === THIS && (readRef(note, v.path) ?? null) === null ? NO_ROW : v]);
    return { ...keys, where: Object.fromEntries(where) };
  };
  const out = { ...fix(t) };
  if (Array.isArray(t.upstream)) out.upstream = (t.upstream as Stage[]).map((s) => ({ ...s, keys: fix(s.keys) }));
  return out;
}

/**
 * Checks a filled template: its typed keys through checkPanel, then the stages expansion added
 * for the blocks above the one it names. A stage's key-level problems drop the key; its other
 * problems stop the panel, as a panel's own do.
 */
function checkTemplate(t: Record<string, unknown>, strict: boolean): { panel?: Panel; errors: string[] } {
  const { upstream, schema, vars, target, secrets, kept, fieldInfo, ...keys } = t;
  const stageErrors: string[] = [];
  const stages: PipelineKeys[] = [];
  let stopped = false;
  for (const { block, keys: raw } of (upstream ?? []) as Stage[]) {
    const s = readStage(raw);
    stageErrors.push(...[...s.errors, ...s.problems].map((e) => `data.${block}: ${e}`));
    stopped ||= s.problems.length > 0;
    stages.push(s.stage);
  }
  const internal: Partial<Panel> = {};
  if (stages.length) internal.upstream = stages;
  if (schema) internal.schema = schema as Panel["schema"];
  if (vars) internal.vars = vars as Panel["vars"];
  if (target) internal.target = target as SaveTarget;
  if (secrets) internal.secrets = secrets as string[];
  if (fieldInfo) internal.fieldInfo = fieldInfo as Panel["fieldInfo"];
  const r = checkPanel(keys, strict, internal);
  // Checking makes `row` text; values that were one whole param keep the param's type.
  if (r.panel?.row && isPlainObject(kept)) {
    const row = r.panel.row;
    r.panel.row = { ...row, ...Object.fromEntries(Object.entries(kept).filter(([k]) => k in row)) } as Panel["row"];
  }
  const errors = [...r.errors, ...stageErrors];
  return !r.panel || stopped ? { errors } : { panel: r.panel, errors };
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
 * `internal` holds what expansion added (a chain's stages, a schema, a save target); the view's
 * checks see it.
 */
export function checkPanel(raw: Record<string, unknown>, strict: boolean, internal: Partial<Panel> = {}): { panel?: Panel; errors: string[] } {
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
  const p = { ...panel, ...internal } as Panel;
  const fieldProblems = settleFields(p);
  // A checklist's save is the list it ticks; anything else may save to a folder.
  if (p.save && def.id !== "checklist") p.target ??= saveTarget(p.save);
  const problems = [
    ...fieldProblems,
    ...schemaDefaults(p, def.keys),
    ...shareDefaults(p, def.keys),
    ...(def.needsSource && !p.source ? [`${def.id} needs a source`] : []),
    ...(def.validate?.(p) ?? []),
    ...(p.source ? sourceDef(p.source).validate?.(p) ?? [] : []),
    ...(p.body !== undefined && !isUrl(p.source) ? ['"body" needs a URL source'] : []),
    ...(p.line && !p.append ? ['"line" needs "append"'] : []),
    ...groupProblems(p),
    ...(p.span !== undefined && ![1, 2, 3, 4].includes(p.span) ? ["span must be 1, 2, 3 or 4"] : []),
    ...(p.save && RESERVED.includes(p.save) && p.target?.kind !== "this" ? [`save can't use "${p.save}", which names part of the app`] : []),
    ...(p.save && SOURCE_WORDS.includes(p.save) ? [`save can't use "${p.save}", which names a kind of source`] : []),
    ...(p.target?.kind === "this" && def.id !== "form" ? ["save: this works on a form"] : []),
    ...(p.target?.kind === "folder" && !p.target.folder ? ["save needs a folder before the /, e.g. save: Books/"] : []),
    ...definitionProblems(p, def.id),
    ...backgroundKeyErrors(p),
  ];
  if (problems.length) return { errors: [...errors, ...problems] };
  showFields(p);
  return { panel: p, errors };
}

/**
 * A form's `fields` as plain types: picked from the schema of the block it saves to when they are
 * a list of names, else read as typed, where a field written as a map adds its label, format and
 * default to `fieldInfo` (over the schema's, field by field).
 */
function settleFields(p: Panel): string[] {
  const written = p.fields as unknown;
  if (written === undefined) return [];
  if (Array.isArray(written)) {
    const schema = p.schema;
    // Told here, not again as a form without fields.
    p.fields = {};
    if (!schema) return ["fields as a list names fields of the block the form saves to; save to a block with fields, or give each field a type"];
    const names = written.map(String);
    const missing = names.find((n) => !Object.hasOwn(schema, n));
    if (missing !== undefined) return [`fields: "${missing}" isn't a field of the block it saves to (it has ${Object.keys(schema).join(", ")})`];
    p.fields = Object.fromEntries(names.map((n) => [n, schema[n]]));
    return [];
  }
  const { types, info, errors } = readFields(written as Record<string, unknown>);
  p.fields = types;
  const merged = { ...p.fieldInfo };
  for (const [name, own] of Object.entries(info)) merged[name] = { ...merged[name], ...own };
  if (Object.keys(merged).length) p.fieldInfo = merged;
  return errors;
}

/**
 * What a block's fields give a table that doesn't say: its columns (a note's name, then the fields
 * in the order typed), and with `edit: true` every field among its columns that can be changed.
 */
function schemaDefaults(p: Panel, keys: readonly string[]): string[] {
  if (keys.includes("columns") && p.columns === undefined && p.schema && !p.group) {
    const named = rowsAreNotes(p.source);
    p.columns = [...new Set([...(named ? ["name"] : []), ...Object.keys(p.schema)])];
  }
  if ((p.edit as unknown) !== true) return [];
  const schema = p.schema;
  if (!schema) {
    delete p.edit;
    return ["edit: true needs fields on the block; or list the columns to edit"];
  }
  // A note's name, a computed column and the like are fields a table may show but never write.
  const writable = (f: string) => !editableSource(p) || editErrors(p, [f]).length === 0;
  p.edit = (p.columns ?? Object.keys(schema)).filter((f) => Object.hasOwn(schema, f) && writable(f));
  return p.edit.length ? [] : ["edit: true finds no field of the block among the columns; list the columns to edit"];
}

/**
 * `agg: share` and `of` go together; grouped, each group's share is the `share` column, which a
 * panel naming no series or columns shows.
 */
function shareDefaults(p: Panel, keys: readonly string[]): string[] {
  if (p.of !== undefined && p.agg !== "share") return ['"of" needs agg: share'];
  if (p.agg !== "share") return [];
  if (p.of === undefined) return ["agg: share needs of, e.g. of: {outcome: right}"];
  if (p.group && keys.includes("y") && p.y === undefined) p.y = "share";
  if (p.group && keys.includes("columns") && p.columns === undefined) p.columns = [p.group, "share"];
  return [];
}

/**
 * Labels and formats the fields give fill in for those the panel doesn't; a share reads as a
 * percent unless the panel gives a format.
 */
function showFields(p: Panel): void {
  const info = Object.entries(p.fieldInfo ?? {});
  const labels = Object.fromEntries(info.flatMap(([f, i]) => (i.label === undefined ? [] : [[f, i.label]])));
  if (Object.keys(labels).length) p.labels = { ...labels, ...p.labels };
  if (p.agg === "share" && p.format === undefined) p.format = p.group ? { share: "0%" } : "0%";
  const formats = Object.fromEntries(info.flatMap(([f, i]) => (i.format === undefined ? [] : [[f, i.format]])));
  if (typeof p.format !== "string" && Object.keys(formats).length) p.format = { ...formats, ...p.format };
}

/**
 * Properties a save would write into a note (a new one, or the note an embed or lens sits in) that
 * would make it run: `row`'s keys, else a form's fields. A row action without `row` saves whatever
 * the row holds, so those keys are dropped when the note is written instead.
 */
function definitionProblems(p: Panel, view: string): string[] {
  const kind = p.target?.kind;
  if (kind !== "folder" && kind !== "this") return [];
  const keys = p.row ? Object.keys(p.row) : view === "form" ? Object.keys(p.fields ?? p.schema ?? {}) : [];
  const what = p.row ? "row can't set" : kind === "this" ? "save: this can't change" : "save can't set";
  return keys.flatMap((k) => {
    const why = definitionReason(k);
    return why ? [`${what} "${k}", ${why}`] : [];
  });
}

/** A source that names a list in the data note or app note (not a URL, not `notes`). */
export function isListName(source: string | undefined): source is string {
  return !!source && sourceDef(source).id === "list";
}

/** The note an embed or a lens sits in, for `save: this`; a lens's `for` scope, which writing there needs permission for. */
export interface HostNote {
  scope?: string;
}

/** What `save: this` says in an app note opened on its own, which Obsidian would reformat if it were written. */
export const SAVE_THIS_HOSTED = 'save: this works in an embed or a lens, where "this" is the note it sits in';

/**
 * Reads an app from a note's frontmatter. Returns undefined when the note isn't an app. `host` is
 * given when the app sits in another note (an embed, a lens), where `save: this` writes that note.
 */
export function readSpec(
  fm: Record<string, unknown> | undefined,
  opts: { now?: Date; notes?: NoteReader; path?: string; host?: HostNote } = {},
): SpecResult | undefined {
  if (!fm || !isApp(fm)) return undefined;
  let description = fm.app === true ? "" : String(fm.app);
  const versionError = checkVersion(fm.spec);
  // Keys written for a newer version may mean something else, so nothing is drawn.
  if (versionError) return { errors: [versionError], empty: false };
  const errors: string[] = [];
  const inputErrors: string[] = [];
  const inputs = readInputs(fm.inputs, inputErrors).filter((d) => d.name !== THIS);
  if (isPlainObject(fm.inputs) && THIS in fm.inputs) inputErrors.push(`inputs: ${TAKEN}`);
  const inputNames = new Set(inputs.map((d) => d.name));
  const selects = appSelects(fm, inputNames, inputErrors);
  // Selections are names like inputs, known before any `$name` is read; so is the note the app is in.
  const names = new Set([...inputNames, ...selects, THIS]);
  const blocks = readBlocks(fm.data, errors, names);
  errors.push(...inputErrors);
  const start = startingValues(inputs, opts.now ?? new Date());
  const expander = new Expander(opts.notes, opts.path ?? "");
  const scope = expander.appScope(blocks, names, selects);
  const isSelection = (n: string) => selects.has(n) || expander.selections.has(n);
  // Names whose values only come at run time, from whoever types or picks them.
  const typed = (n: string) => isSelection(n) || inputs.some((d) => d.name === n && d.kind === "text");
  const late = (n: string) => n === THIS || typed(n);
  // What runs while the app is closed fills its inputs with their starting values; nobody types or picks there.
  const notLate = (key: string, n: string) => `${key} can't depend on $${typedName(n)}, which has no value until someone ${isSelection(n) ? "picks a row" : "types"}`;
  // The background works only for app notes; in an embed or a lens these keys would never run.
  const notHere = (key: string) => `${key} works in an app note, not in an embed or a lens`;
  /** A panel's keys checked with these values; a name only typed or picked at run time is tried with stand-ins. */
  const checkAt = (template: Record<string, unknown>, uses: string[], values: Record<string, unknown>, strict: boolean) => (uses.some(late)
    ? checkStandIns(template, values, late, strict)
    : checkFilled(template, resolveInputs(template, values) as Record<string, unknown>, strict));
  // A block that records is fetched while its app is closed, read exactly as a panel naming it reads
  // it, so what it may touch is asked for from the same keys that are sent.
  const recorded: Record<string, PanelSpec> = {};
  const recordErrors: string[] = [];
  for (const [name, block] of blocks) {
    if (block.record === undefined) continue;
    const label = `data.${name}`;
    if (opts.host) {
      errors.push(`${label}: ${notHere("record")}`);
      continue;
    }
    const n = [...namesIn(block, names)].find(typed);
    if (n !== undefined) {
      errors.push(`${label}: ${notLate("record", n)}`);
      continue;
    }
    const before = expander.errors.length;
    const [p] = expander.expand({ view: "table", source: name }, scope, label);
    recordErrors.push(...expander.errors.splice(before));
    if (!p) continue;
    noteSecrets(p.template);
    const uses = refsIn(p.template);
    const r = checkAt(p.template, uses, start, true);
    recordErrors.push(...r.errors.map((e) => `${label}: ${e}`));
    if (r.panel) recorded[name] = { template: p.template, panel: r.panel, label, inputs: uses, strict: true, writtenIn: p.writtenIn };
  }
  const shortcuts = new Set<string>();

  const panels: PanelSpec[] = [];
  const used = new Set<string>();
  /** Each selection's selecting panel, by label. */
  const selectedBy = new Map<string, string>();
  let count = 0;
  const check = (p: Produced, strict: boolean) => {
    const at = (e: string) => (p.label ? `${p.label}: ${e}` : e);
    const uses = refsIn(p.template);
    for (const n of uses) used.add(n);
    const bare = bareRefs(p.template).filter((n) => n === THIS || isSelection(n));
    if (bare.length) {
      errors.push(...[...new Set(bare)].map((n) => at(n === THIS ? "say which property: $this.rating" : `say which field: $${typedName(n)}.id`)));
      return;
    }
    if (p.template.save === THIS) {
      if (!opts.host) {
        errors.push(at(SAVE_THIS_HOSTED));
        return;
      }
      p.template.target = { kind: "this", ...(opts.host.scope ? { scope: opts.host.scope } : {}) };
    }
    // A board's moves write its group field, which, like `edit`, must be settled from the keys.
    const grouping = p.template.view === "board" ? refsIn(p.template.group)[0] : undefined;
    if (grouping !== undefined) {
      errors.push(at(`$${typedName(grouping)} can't be used in "group" on a board, where moving a card changes it`));
      return;
    }
    const selected = selectOf(p.template);
    if (selected !== undefined && isSelection(selected)) {
      if (selectedBy.has(selected)) {
        errors.push(at(`two panels select "${typedName(selected)}"`));
        return;
      }
      selectedBy.set(selected, p.label);
    }
    noteSecrets(p.template);
    const checkWith = (values: Record<string, unknown>) => checkAt(p.template, uses, values, strict);
    const r = checkWith(start);
    errors.push(...r.errors.map(at));
    // Any choice can be picked, so each must make a valid panel too.
    for (const def of inputs) {
      if (def.kind !== "choice" || !uses.includes(def.name)) continue;
      for (const option of def.options.slice(1)) {
        const other = checkWith({ ...start, [def.name]: option }).errors.filter((e) => !r.errors.includes(e));
        if (other.length === 0) continue;
        errors.push(...other.map((e) => at(`${e} (when $${def.name} is ${option})`)));
        break;
      }
    }
    for (const key of ["shortcut", "pin", "alert", "then"] as const) {
      if (r.panel?.[key] === undefined) continue;
      const n = uses.find(late);
      if (opts.host) errors.push(at(notHere(key)));
      // A form's `then` runs with what was typed in it, which it reads like its other actions do.
      else if (n !== undefined && key !== "then") errors.push(at(notLate(key, n)));
    }
    // Where it can't run, it isn't asked for either; the rest of the panel still works.
    if (opts.host && r.panel?.then) delete r.panel.then;
    const shortcut = r.panel?.shortcut;
    if (shortcut !== undefined && shortcuts.has(shortcut)) errors.push(at(`two panels use the shortcut "${shortcut}"`));
    if (shortcut !== undefined) shortcuts.add(shortcut);
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
    if (fm.panels !== undefined || fm.tabs !== undefined) errors.push("put - use: … inside panels to mix a component with other panels");
    else entry({ use: fm.use, with: fm.with }, "", true);
    if (!description) description = expander.describe(fm.use);
  } else if (Array.isArray(fm.panels) || (fm.tabs !== undefined && fm.tabs !== null)) {
    const before = errors.length;
    const entries = panelEntries(fm, errors);
    if (entries.length === 0 && errors.length === before) return { errors, empty: true };
    for (const { raw, label } of entries) {
      if (isPlainObject(raw)) entry(raw, label, true);
      else errors.push(`${label}: must be a set of keys`);
    }
  } else if (fm.view !== undefined) {
    // The note's other properties aren't part of the panel.
    entry(Object.fromEntries(Object.entries(fm).filter(([k]) => k in KEY_TYPES)), "", false);
  } else {
    return { errors, empty: true };
  }
  // A recorded block's problem is told once, under the panel that already shows it if there is one.
  errors.push(...recordErrors.filter((e) => !errors.some((x) => x.endsWith(e.slice(e.indexOf(": "))))));
  for (const d of inputs) if (!used.has(d.name)) errors.push(`input "${d.name}" isn't used by any panel`);
  const selections = [...selects, ...expander.selections];
  for (const n of selections) {
    if (used.has(n)) continue;
    const label = selectedBy.get(n);
    errors.push(`${label ? `${label}: ` : ""}selection "${typedName(n)}" isn't used by any panel`);
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
  // Data is written into the store's properties; an app's or component's own keys are no place for it.
  const stored = store === undefined ? undefined : opts.notes?.resolve(storeTarget(store), opts.path ?? "");
  const storedFm = stored === undefined ? undefined : opts.notes!.frontmatter(stored);
  if (runsAsApp(storedFm)) {
    errors.push(`store can't be an app or a component note; name a note that only holds data, e.g. store: "[[Weight log]]"`);
    store = undefined;
  }
  const spec = {
    description, panels, refreshMs, store, inputs, selections,
    blocks: Object.fromEntries(blocks), recorded, read: expander.read, links: [...expander.links],
  };
  return { spec, errors, empty: false };
}

/** The names an app's own panel entries select (beside `use` too), checked. */
function appSelects(fm: Record<string, unknown>, inputs: ReadonlySet<string>, errors: string[]): Set<string> {
  // A tabs problem is told once, where the panels are read.
  const listed = Array.isArray(fm.panels) || (fm.tabs !== undefined && fm.tabs !== null);
  const entries = fm.use !== undefined ? [] : listed ? panelEntries(fm, []) : fm.view !== undefined ? [{ raw: fm, label: "" }] : [];
  const out = new Set<string>();
  entries.forEach(({ raw: entry, label }) => {
    const name = selectOf(entry);
    if (name === undefined || out.has(name)) return;
    const at = label ? `${label}: ` : "";
    if (!NAME.test(name)) errors.push(`${at}select: "${name}" can only use letters, digits and _`);
    else if (name === THIS) errors.push(`${at}select: ${TAKEN}`);
    else if (inputs.has(name)) errors.push(`${at}select: "${name}" is already an input`);
    else out.add(name);
  });
  return out;
}

/** Names read whole (`$quake`, no path) in a template; a formula's values are bound whole by design. */
function bareRefs(value: unknown, out: string[] = []): string[] {
  if (value instanceof InputRef) {
    if (!value.path) out.push(value.input);
  } else if (value instanceof InputText) {
    for (const p of value.parts) bareRefs(p, out);
  } else if (Array.isArray(value)) {
    for (const v of value) bareRefs(v, out);
  } else if (isPlainObject(value) && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) if (k !== "vars") bareRefs(v, out);
  }
  return out;
}

/**
 * What a name whose value only comes at run time stands for while checking: each of these is
 * tried in turn, and only problems every one of them has are reported, since the others depend on
 * what will be typed or picked.
 */
const STAND_INS: readonly unknown[] = ["x", 1, true];

/** Checks a template with each stand-in for the `late` names; the panel is the first that checks out. */
function checkStandIns(
  template: Record<string, unknown>, values: Readonly<Record<string, unknown>>, late: (name: string) => boolean, strict: boolean,
): { panel?: Panel; errors: string[] } {
  const runs = STAND_INS.map((s) => {
    const filled = resolveWith(template, (ref) => (late(ref.input) ? s : readRef(values[ref.input], ref.path)), []);
    return checkTemplate(filled as Record<string, unknown>, strict);
  });
  const panel = runs.find((r) => r.panel)?.panel;
  if (!panel) return runs[0];
  return { panel, errors: runs[0].errors.filter((e) => runs.every((r) => r.errors.includes(e))) };
}

/** What opening a component note shows: how to use it, and a preview when every param has a default. */
export interface ComponentPreview {
  result: SpecResult;
  usage: string;
  /** Params without a default; the preview needs them all filled. */
  missing: string[];
  /** A lens's `for` scope: it runs on the notes there, so it isn't previewed on its own. */
  lens?: string;
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
  const lens = fm.for === undefined || fm.for === null ? undefined : readFor(fm.for);
  const scope = lens && "scope" in lens ? lens.scope : undefined;
  // A lens is checked as it runs: sitting in a note of its scope.
  const result = readSpec({
    app: fm.component === true ? "" : String(fm.component),
    use: `[[${self}]]`,
    with: Object.fromEntries(missing.map((n) => [n, n])),
  }, scope ? { ...opts, host: { scope } } : opts)!;
  const values = [...params].map(([k, v]) => `${k}: ${v === undefined ? "…" : typeof v === "string" ? v : JSON.stringify(v)}`);
  const usage = `panels:\n  - use: "[[${basename(opts.path)}]]"${values.length ? `\n    with: {${values.join(", ")}}` : ""}`;
  return { result, usage, missing, lens: scope };
}

/**
 * The panels whose title or label (as typed) is one of `names`, for an embed that shows part of an
 * app, with the inputs those panels use. `app` names the app in messages.
 */
export function pickPanels(spec: AppSpec, names: readonly string[], app: string): { spec: AppSpec; errors: string[] } {
  const namesOf = (ps: PanelSpec) => [ps.template.title, ps.template.label].filter((v): v is string => typeof v === "string");
  const panels = spec.panels.filter((ps) => namesOf(ps).some((n) => names.includes(n)));
  const known = spec.panels.map((ps) => namesOf(ps)[0]).filter((n) => n !== undefined);
  const has = known.length ? `it has ${known.join(", ")}` : "none of its panels has a title or label";
  const errors = names.filter((n) => !spec.panels.some((ps) => namesOf(ps).includes(n)))
    .map((n) => `panels: ${app} has no panel called "${n}" (${has})`);
  const inputs = spec.inputs.filter((d) => panels.some((ps) => ps.inputs.includes(d.name)));
  return { spec: { ...spec, panels, inputs }, errors };
}

/** A panel's permissions, each with the key that asks for it. */
function panelPermissions(p: Panel, selfPath: string): [string, keyof Panel][] {
  const out: [string, keyof Panel][] = p.source ? sourceDef(p.source).permissions(p, selfPath) : [];
  if (p.append && notePath(p.append) !== selfPath) out.push([`write:${notePath(p.append)}`, "append"]);
  // Named as typed, like the notes it writes: the app it names is looked up when it runs.
  if (p.then) out.push([`run:${storeTarget(p.then.app)}#${p.then.do}`, "then"]);
  // A lens writes the properties of whichever note in its scope it is shown on.
  if (p.target?.kind === "this" && p.target.scope) out.push([`edit:${p.target.scope}`, "save"]);
  if (p.target?.kind === "folder") {
    out.push([`create:${p.target.folder}`, "save"]);
    if (p.template) out.push([`read:${notePath(storeTarget(p.template))}`, "template"]);
  }
  // The browser fetches an image from whatever host the row's data names, so no host can be settled from the keys.
  if (Object.values(p.cells ?? {}).includes("image")) out.push(["images", "cells"]);
  // A board moves cards by changing their group field, so it edits without an `edit` key.
  if (p.edit?.length) out.push(...editPermissions(p, "edit"));
  else if (p.view === "board") out.push(...editPermissions(p, "group"));
  return out;
}

/**
 * Everything that runs for an app: its panels, and its recorded blocks, which are fetched even when
 * no panel shows them. What it may do is asked from exactly these.
 */
function running(spec: AppSpec): PanelSpec[] {
  return [...spec.panels, ...Object.values(spec.recorded)];
}

/** What an app is allowed to do, as stable strings. Writes to the note itself need no grant. */
export function permissionsOf(spec: AppSpec, selfPath: string): string[] {
  const out = new Set<string>();
  for (const { panel } of running(spec)) for (const [perm] of panelPermissions(panel, selfPath)) out.add(perm);
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
  // Blocks that record are the app's own.
  for (const ps of Object.values(spec.recorded)) for (const [perm] of panelPermissions(ps.panel, selfPath)) add(perm, selfPath);
  if (spec.store) add(`store:${notePath(storeTarget(spec.store))}`, selfPath);
  return out;
}

/** Notes on a template the secrets typed in it, when there are any. */
function noteSecrets(template: Record<string, unknown>): void {
  const secrets = typedSecrets(template);
  if (secrets.length) template.secrets = secrets;
}

/**
 * The secrets typed whole in a template's source, headers and body, before any `$name` is filled:
 * the only ones its requests may fill. Text beside a `$name` is read piece by piece, so a value
 * can't complete a placeholder the note only started.
 */
function typedSecrets(template: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const id of secretIds(v)) out.add(id);
    else if (v instanceof InputText) v.parts.forEach(walk);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v) && !(v instanceof InputRef) && !(v instanceof Date)) Object.values(v).forEach(walk);
  };
  walk(template.source);
  for (const v of Object.values(isPlainObject(template.headers) ? template.headers : {})) walk(v);
  walk(template.body);
  return [...out].sort();
}

export function describePermission(perm: string): string {
  if (perm === "read:*") return "Read any note in the vault";
  if (perm === "edit:*") return "Change properties of notes anywhere in the vault";
  if (perm === "images") return "Load images from any site (image cells)";
  const [kind, ...rest] = perm.split(":");
  const what = rest.join(":");
  switch (kind) {
    case "net": return `Fetch data from ${what}`;
    case "post": return `Send a request body to ${what}`;
    case "secret": return `Use your saved secret "${what}"`;
    // A file (a template note) or a scope of notes (a folder or #tag).
    case "read": return /\.[A-Za-z0-9]+$/.test(what) ? `Read ${what}` : `Read notes in ${what}`;
    case "write": return `Add lines to ${what}`;
    case "store": return `Save its data in ${what}`;
    case "create": return `Create notes in ${what}`;
    case "edit": return `Change properties of notes in ${what}`;
    case "tasks": return `Tick tasks in notes in ${what}`;
    case "run": {
      const cut = what.lastIndexOf("#");
      return `Run “${what.slice(cut + 1)}” in ${what.slice(0, cut)}`;
    }
    default: return perm;
  }
}
