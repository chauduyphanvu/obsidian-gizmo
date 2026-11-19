import { parseDuration } from "./data.ts";
import { compileFormula, computeErrors } from "./formula.ts";
import { sourceDef } from "./sources/registry.ts";
import { RESERVED, storeTarget } from "./store.ts";
import {
  InputRef, NAME, fillParams, nearMisses, parseInputs, refusedPlaces, unsafeValue,
} from "./template.ts";
import {
  COMMON_KEYS, DATA_KEYS, GROUP_KEYS, INTERNAL_KEYS, KEY_TYPES, checkFields, isPlainObject, readValue, type PanelKey,
} from "./views/common.ts";
import { viewDef } from "./views/registry.ts";
import type { SaveTarget } from "./spec.ts";

/** The language version this plugin reads. */
export const SPEC_VERSION = 1;

export function checkVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === SPEC_VERSION) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > SPEC_VERSION) {
    return `spec: ${value} needs a newer Note Apps (this one reads spec ${SPEC_VERSION})`;
  }
  return `spec must be ${SPEC_VERSION}`;
}

/** Keys only a block holds, for others to read: never merged into a panel that doesn't take them. */
const BLOCK_ONLY: readonly string[] = ["fields", "record", "into"];
/** Keys a named source in `data:` may hold. */
const BLOCK_KEYS: readonly string[] = [...DATA_KEYS, ...GROUP_KEYS, ...BLOCK_ONLY];
/** Keys that say where a chain's data comes from, so only its root block holds them. */
const ROOT_KEYS: readonly string[] = ["headers", "from", "body", "record", "into"];
/** The most blocks one chain may hold, its root included. */
export const MAX_CHAIN = 4;

/** Named sources from `data:`, checked once; panels take their keys by naming them in `source`. */
export type Blocks = Map<string, Record<string, unknown>>;
/** Checked blocks, as a map or as `AppSpec.blocks`. */
export type BlockSet = ReadonlyMap<string, Record<string, unknown>> | Readonly<Record<string, Record<string, unknown>>>;

function blockIn(blocks: BlockSet, name: string): Record<string, unknown> | undefined {
  return blocks instanceof Map ? blocks.get(name) : Object.hasOwn(blocks, name) ? (blocks as Record<string, Record<string, unknown>>)[name] : undefined;
}

/** The block a block reads, when its source names another block rather than a list of its own name. */
function parentOf(name: string, blocks: BlockSet): string | undefined {
  const source = blockIn(blocks, name)?.source;
  return typeof source === "string" && source !== name && sourceDef(source).id === "list" && blockIn(blocks, source) ? source : undefined;
}

/** The blocks a checked block reads through, root first, ending with the block itself. */
export function blockChain(name: string, blocks: BlockSet): string[] {
  const chain = [name];
  for (let up = parentOf(name, blocks); up !== undefined && !chain.includes(up); up = parentOf(up, blocks)) chain.unshift(up);
  return chain;
}

/** The fields describing a block's rows: its own, or those of the nearest block up its chain that has them. */
export function schemaOf(name: string, blocks: BlockSet): Record<string, string | string[]> | undefined {
  const holder = blockChain(name, blocks).reverse().find((n) => blockIn(blocks, n)?.fields !== undefined);
  return holder === undefined ? undefined : blockIn(blocks, holder)!.fields as Record<string, string | string[]>;
}

function readBlockKey(key: string, value: unknown, names: ReadonlySet<string>): { value?: unknown; errors: string[] } {
  if (key === "record") {
    return parseDuration(value) ? { value, errors: [] } : { errors: ["record must look like 10m, 1h, 1d"] };
  }
  if (key === "into") {
    const name = typeof value === "string" || typeof value === "number" ? String(value) : "";
    if (!name || sourceDef(name).id !== "list") return { errors: ["into must name a list, e.g. into: kp_log"] };
    if (RESERVED.includes(name)) return { errors: [`into can't use "${name}", which names part of the app`] };
    return { value: name, errors: [] };
  }
  const read = readValue(key as PanelKey, value);
  if ("error" in read) return { errors: [read.error] };
  const errors = key === "fields" ? checkFields(read.value as Record<string, string | string[]>)
    : key === "compute" ? computeErrors(read.value as Record<string, string | number>, names)
    : [];
  return errors.length ? { errors } : { value: read.value, errors };
}

/** `names` are the `$names` the blocks' formulas may read: the app's inputs, or a component's params. */
export function readBlocks(value: unknown, errors: string[], names: ReadonlySet<string>): Blocks {
  const blocks: Blocks = new Map();
  if (value === undefined || value === null) return blocks;
  if (!isPlainObject(value)) {
    errors.push("data must be a set of named sources, e.g. data: {forecast: {source: https://…}}");
    return blocks;
  }
  for (const [name, raw] of Object.entries(value)) {
    const at = `data.${name}`;
    if (name === "notes") {
      errors.push(`data: "notes" can't be a name; source: notes already means notes in the vault`);
      continue;
    }
    if (!isPlainObject(raw)) {
      errors.push(`${at} must be a set of keys`);
      continue;
    }
    const block: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(raw)) {
      if (!BLOCK_KEYS.includes(key)) {
        errors.push(`${at}: ${key in KEY_TYPES ? `"${key}" belongs on the panel, not in data` : `unknown key "${key}"`}`);
        continue;
      }
      if (v === null || v === undefined) continue;
      const read = readBlockKey(key, v, names);
      errors.push(...read.errors.map((e) => `${at}: ${e}`));
      if (read.errors.length === 0) block[key] = read.value;
    }
    if (block.into !== undefined && block.record === undefined) {
      errors.push(`${at}: "into" needs "record"`);
      delete block.into;
    }
    if (typeof block.source !== "string" || !block.source) errors.push(`${at} needs a source`);
    else blocks.set(name, block);
  }
  checkChains(blocks, errors);
  return blocks;
}

/**
 * A block may read another block, which then runs first. Chains that loop or run more than
 * MAX_CHAIN deep are dropped; source keys typed below a chain's root are dropped with a pointer to it.
 */
function checkChains(blocks: Blocks, errors: string[]): void {
  const label = (names: string[]) => names.map((n) => `data.${n}`).join(" → ");
  const broken = new Set<string>();
  const loops = new Set<string>();
  for (const name of blocks.keys()) {
    // Followed the way blocks read each other: name → its source block → that block's source …
    const path = [name];
    for (let up = parentOf(name, blocks); up !== undefined; up = parentOf(up, blocks)) {
      if (path.includes(up)) {
        const loop = [...path.slice(path.indexOf(up)), up];
        const key = [...new Set(loop)].sort().join("\n");
        if (!loops.has(key)) errors.push(`${label(loop)} use each other`);
        loops.add(key);
        broken.add(name);
        break;
      }
      path.push(up);
    }
    if (broken.has(name) || path.length <= MAX_CHAIN) continue;
    broken.add(name);
    if (path.length === MAX_CHAIN + 1) errors.push(`${label(path)} is more than ${MAX_CHAIN} blocks deep`);
  }
  for (const name of broken) blocks.delete(name);
  for (const [name, block] of blocks) {
    if (parentOf(name, blocks) === undefined) continue;
    const root = blockChain(name, blocks)[0];
    for (const key of ROOT_KEYS) {
      if (!(key in block)) continue;
      errors.push(`data.${name}: "${key}" belongs on data.${root}, where the source is`);
      delete block[key];
    }
  }
}

/**
 * Where `save` writes when it names a block: the list at the root of the block's chain, or new
 * notes in the one folder a `notes` root reads. Undefined when the block's root is neither (it
 * then names a list, as any other text does).
 */
function blockTarget(save: string, blocks: Blocks): { target: SaveTarget } | { error: string } | undefined {
  const root = blocks.get(blockChain(save, blocks)[0])!;
  const source = String(root.source);
  const kind = sourceDef(source).id;
  if (kind === "list") return { target: { kind: "list", name: source } };
  if (kind !== "notes") return undefined;
  const from = typeof root.from === "string" ? root.from.trim() : "";
  if (!from || from.startsWith("#") || from.includes(",")) return { error: `save: "${save}" reads ${from || "no folder"}; name a folder to save notes into` };
  return { target: { kind: "folder", folder: from.replace(/\/+$/, "") } };
}

/** A block's pipeline, run as a stage when a panel names a block further down its chain. */
function stageKeys(block: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(block).filter(([k]) => k !== "source" && k !== "fields" && !ROOT_KEYS.includes(k)));
}

/** One block above the one a panel names: its name, for messages, and its pipeline keys. */
export interface Stage {
  block: string;
  keys: Record<string, unknown>;
}

/**
 * A panel whose `source` names a block gets the block's keys; the panel's own keys then replace
 * them one by one, and an empty panel key removes the key it would have inherited. When the block
 * reads another block, the source keys come from the chain's root and the blocks above the named
 * one become fixed stages, root first. `schema` is the nearest `fields` up the chain.
 */
export function expandPanel(raw: Record<string, unknown>, blocks: Blocks): {
  template: Record<string, unknown>;
  stages: Stage[];
  schema?: Record<string, string | string[]>;
  errors: string[];
} {
  const name = raw.source;
  const block = typeof name === "string" && sourceDef(name).id === "list" ? blocks.get(name) : undefined;
  if (!block) return { template: raw, stages: [], errors: [] };
  const chain = blockChain(name as string, blocks);
  const root = blocks.get(chain[0])!;
  const def = typeof raw.view === "string" ? viewDef(raw.view) : undefined;
  const allowed = new Set<string>(def ? [...COMMON_KEYS, ...def.keys] : []);
  const errors: string[] = [];
  const template: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "source" && value !== null && value !== undefined) template[key] = value;
  }
  const inherit = (from: string, keys: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(keys)) {
      if (key in raw || (BLOCK_ONLY.includes(key) && !allowed.has(key))) continue;
      if (def && !allowed.has(key)) errors.push(`"${key}" doesn't apply to ${def.id} (from data.${from})`);
      else template[key] = value;
    }
  };
  inherit(name as string, Object.fromEntries(Object.entries(block).filter(([k]) => k !== "source")));
  if (chain.length > 1) inherit(chain[0], Object.fromEntries(Object.entries(root).filter(([k]) => ROOT_KEYS.includes(k))));
  template.source = root.source;
  const stages = chain.slice(0, -1)
    .map((n) => ({ block: n, keys: stageKeys(blocks.get(n)!) }))
    .filter((s) => Object.keys(s.keys).length > 0);
  return { template, stages, schema: schemaOf(name as string, blocks), errors };
}

// ---- Components ----------------------------------------------------------------------------------

/** How deep components may use components, and how many panels an app may expand to. */
export const MAX_DEPTH = 4;
export const MAX_PANELS = 100;

/** What expansion needs from the vault; tests pass a fake. */
export interface NoteReader {
  /** The path a link points at from the note at `from`, or undefined when no note matches. */
  resolve(link: string, from: string): string | undefined;
  frontmatter(path: string): Record<string, unknown> | undefined;
}

/** One panel after expansion: its keys, where it was written, and which note wrote each key. */
export interface Produced {
  template: Record<string, unknown>;
  label: string;
  writtenIn: Record<string, string>;
}

/**
 * The note an entry was written in: its names, data blocks and how `$names` are filled there.
 * `selects` maps the names a component's own panels select to the app-wide names of this use of
 * it, so two uses of one component keep their selections apart; those names are also in `names`
 * and `params` (as references), and are refused where inputs are.
 */
interface Scope {
  path: string;
  blocks: Blocks;
  names: ReadonlySet<string>;
  kind: "input" | "param";
  params: ReadonlyMap<string, unknown>;
  selects: ReadonlyMap<string, string>;
}

/** The name an entry selects, as typed; numbers are text, as for any text key. */
export function selectOf(entry: unknown): string | undefined {
  if (!isPlainObject(entry)) return undefined;
  return typeof entry.select === "string" || typeof entry.select === "number" ? String(entry.select) : undefined;
}

/** The typed name behind an app-wide selection name (a component's own get `@<use>` added). */
export function typedName(name: string): string {
  return name.split("@")[0];
}

interface Component {
  description: string;
  /** Declared params; a value of undefined means the app must give it. */
  params: Map<string, unknown>;
  data: unknown;
  panels: unknown[];
}

export function linkOf(value: unknown): string | undefined {
  // `use: [[Ticker]]` without quotes is YAML for a list holding a list.
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 1) value = value[0][0];
  return typeof value === "string" && value.trim() ? storeTarget(value) : undefined;
}

export function basename(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/i, "");
}

const linkName = (path: string) => `[[${basename(path)}]]`;

/** Where a component's panel is written, for messages: "panel 2 (from [[City]] panel 1)". */
const stepLabel = (base: string, step: string[]) => (base ? `${base} (from ${step.join(" → ")})` : step.join(" → "));

function readComponent(fm: Record<string, unknown> | undefined, name: string, errors: string[]): Component | undefined {
  if (!fm || fm.component === undefined || fm.component === null || fm.component === false) {
    errors.push(`${name} isn't a component (it has no component: line)`);
    return undefined;
  }
  const version = checkVersion(fm.spec);
  if (version) {
    errors.push(`${name}: ${version}`);
    return undefined;
  }
  if (fm.app !== undefined) errors.push(`${name} has both app and component; a note is one or the other`);
  if (fm.inputs !== undefined) errors.push(`${name}: inputs belong in the app; take a param, and let the app pass with: {name: $name}`);
  for (const key of ["refresh", "store"]) if (fm[key] !== undefined) errors.push(`${name}: ${key} belongs in the app that uses it`);
  const params = componentParams(fm.params);
  if (!params) errors.push(`${name}: params must be a list of names or names with defaults`);
  for (const [n, v] of params ?? []) {
    if (!NAME.test(n)) errors.push(`${name}: param "${n}" can only use letters, digits and _`);
    if (v !== undefined && unsafeValue(v)) errors.push(`${name}: param "${n}" can't hold a secret or a line break`);
  }
  if (!Array.isArray(fm.panels) || fm.panels.length === 0) {
    errors.push(`${name} needs panels`);
    return undefined;
  }
  return { description: fm.component === true ? "" : String(fm.component), params: params ?? new Map(), data: fm.data, panels: fm.panels };
}

/** A component's params, each with its default; undefined means the app must give it. */
export function componentParams(value: unknown): Map<string, unknown> | undefined {
  const params = new Map<string, unknown>();
  if (Array.isArray(value)) for (const n of value) params.set(String(n), undefined);
  else if (isPlainObject(value)) for (const [n, v] of Object.entries(value)) params.set(n, v === null || v === "" ? undefined : v);
  else if (value !== undefined && value !== null) return undefined;
  return params;
}

const isInternal = (key: string) => (INTERNAL_KEYS as readonly string[]).includes(key);

/** Keys only expansion may add are reported when typed, and dropped. */
function withoutInternal(raw: Record<string, unknown>, at: (e: string) => void): Record<string, unknown> {
  const typed = Object.keys(raw).filter(isInternal);
  for (const key of typed) at(`unknown key "${key}"`);
  return typed.length ? Object.fromEntries(Object.entries(raw).filter(([k]) => !isInternal(k))) : raw;
}

/**
 * Binds the `$names` a part's formulas read as its `vars`: an input reference, filled when the
 * panel is, or a param's value, fixed now. A formula naming anything else drops the part's compute.
 */
function withVars(part: Record<string, unknown>, scope: Scope, at: (e: string) => void): Record<string, unknown> {
  if (!isPlainObject(part.compute)) return part;
  const vars: Record<string, unknown> = {};
  let unknown = false;
  for (const [column, text] of Object.entries(part.compute)) {
    const f = compileFormula(String(text));
    if ("error" in f) continue;
    for (const name of f.vars) {
      if (scope.names.has(name)) vars[name] = scope.kind === "input" ? new InputRef(name) : scope.params.get(name);
      else {
        at(`compute.${column}: $${name} isn't an input or param`);
        unknown = true;
      }
    }
  }
  if (unknown) return Object.fromEntries(Object.entries(part).filter(([k]) => k !== "compute"));
  return Object.keys(vars).length ? { ...part, vars } : part;
}

function fill(value: unknown, scope: Scope, errors: string[], key = ""): unknown {
  return scope.kind === "input" ? parseInputs(value, scope.names, key) : fillParams(value, scope.params, errors, key);
}

/**
 * Expands panel entries into plain panels: data blocks merged, components inlined with their
 * params filled, the caller's override keys applied. Records every component note it read and
 * every link it followed, so the app can tell when one changes.
 */
export class Expander {
  read: Record<string, unknown> = {};
  links = new Set<string>();
  errors: string[] = [];
  /** App-wide names of the selections components' own panels make. */
  selections = new Set<string>();
  private notes: NoteReader | undefined;
  private appPath: string;
  private uses = 0;

  constructor(notes: NoteReader | undefined, appPath: string) {
    this.notes = notes;
    this.appPath = appPath;
  }

  /** `names` are the app's inputs and the names its panels select. */
  appScope(blocks: Blocks, names: ReadonlySet<string>): Scope {
    return { path: this.appPath, blocks, names, kind: "input", params: new Map(), selects: new Map() };
  }

  /** The description of the component a link names, for an app that is one whole component. */
  describe(use: unknown): string {
    const link = linkOf(use);
    const path = link && this.notes?.resolve(link, this.appPath);
    const c = path ? this.notes!.frontmatter(path)?.component : undefined;
    return typeof c === "string" ? c : "";
  }

  /** `base` labels the entry in the app note ("panel 2"; empty for a whole-note use). */
  expand(raw: Record<string, unknown>, scope: Scope, base: string, trail: string[] = [], chain: string[] = [this.appPath]): Produced[] {
    const label = trail.length ? (base ? `${base} (from ${trail.join(" → ")})` : trail.join(" → ")) : base;
    const at = (e: string) => this.errors.push(label ? `${label}: ${e}` : e);
    if (raw.use === undefined) {
      if (raw.with !== undefined) {
        at('"with" needs "use"');
        raw = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "with"));
      }
      const prepared = this.prepare(withoutInternal(raw, at), scope, at, true);
      if (!prepared) return [];
      const { typed, template } = prepared;
      // A param may name a list for `source` or `save`, never a URL, notes or an app's input.
      for (const key of ["source", "save"] as const) {
        const written = typed[key];
        const got = template[key];
        if (scope.kind !== "param" || typeof written !== "string" || !/^\$[A-Za-z_]\w*$/.test(written) || !scope.names.has(written.slice(1))) continue;
        if (got instanceof InputRef || typeof got !== "string" || (key === "source" && sourceDef(got).id !== "list")) {
          at(`${written} can only name a list here; write a URL in the component with ${written} in its path or query`);
          return [];
        }
      }
      return [{ template, label, writtenIn: Object.fromEntries(Object.keys(template).map((k) => [k, scope.path])) }];
    }

    if (raw.view !== undefined) {
      at('"view" can\'t go beside "use"; the component decides its views');
      return [];
    }
    const link = linkOf(raw.use);
    if (!link) {
      at('use must be a link to a note, e.g. use: "[[Ticker]]"');
      return [];
    }
    if (/^https?:\/\//i.test(String(raw.use))) {
      at("components come from notes in this vault; copy the note in");
      return [];
    }
    this.links.add(basename(link));
    const path = this.notes?.resolve(link, scope.path);
    if (!path) {
      at(`can't find [[${link}]]`);
      return [];
    }
    const name = linkName(path);
    if (chain.slice(1).includes(path)) {
      at(`${[...chain.slice(chain.indexOf(path)), path].map(linkName).join(" → ")} uses itself`);
      return [];
    }
    if (chain.length - 1 >= MAX_DEPTH) {
      at(`${name} is more than ${MAX_DEPTH} components deep`);
      return [];
    }
    const fm = this.notes!.frontmatter(path);
    this.read[path] = fm ?? null;
    const problems: string[] = [];
    const component = readComponent(fm, name, problems);
    problems.forEach(at);
    if (!component) return [];

    // `with` values are read where they were typed, so they can pass on the caller's names.
    const given = new Map<string, unknown>();
    if (raw.with !== undefined && raw.with !== null && !isPlainObject(raw.with)) at("with must be a set of params, e.g. with: {symbol: AAPL}");
    for (const [k, v] of Object.entries(isPlainObject(raw.with) ? raw.with : {})) {
      if (!component.params.has(k)) {
        const takes = [...component.params.keys()];
        at(`${name} has no param "${k}" (${takes.length ? `it takes ${takes.join(", ")}` : "it takes none"})`);
      } else if (unsafeValue(v)) {
        at(`with.${k} can't hold a secret or a line break`);
      } else {
        const fillErrors: string[] = [];
        given.set(k, fill(v, scope, fillErrors, "with"));
        fillErrors.forEach(at);
      }
    }
    const params = new Map<string, unknown>();
    for (const [k, v] of component.params) {
      const value = given.has(k) ? given.get(k) : v;
      if (value === undefined) at(`${name} needs ${k}`);
      else params.set(k, value);
    }
    if (params.size < component.params.size) return [];

    const blockErrors: string[] = [];
    const names = new Set(component.params.keys());
    const stepOf = (j: number) => [...trail, `${name} panel ${j + 1}`];
    const selects = this.ownSelects(component.panels, names, (j, e) => this.errors.push(`${stepLabel(base, stepOf(j))}: ${e}`));
    for (const [typed, own] of selects) {
      names.add(typed);
      params.set(typed, new InputRef(own));
    }
    const inner: Scope = { path, blocks: readBlocks(component.data, blockErrors, names), names, kind: "param", params, selects };
    blockErrors.forEach((e) => at(`${name} ${e}`));
    const produced = component.panels.flatMap((entry, j) => {
      const step = stepOf(j);
      if (!isPlainObject(entry)) {
        this.errors.push(`${stepLabel(base, step)}: must be a set of keys`);
        return [];
      }
      return this.expand(entry, inner, base, step, [...chain, path]);
    });
    this.applyOverrides(raw, scope, produced, name, at);
    return produced;
  }

  /** Names a component's own panels select, each given an app-wide name for this use of it. */
  private ownSelects(panels: unknown[], params: ReadonlySet<string>, at: (j: number, e: string) => void): Map<string, string> {
    const use = ++this.uses;
    const out = new Map<string, string>();
    panels.forEach((entry, j) => {
      const name = selectOf(entry);
      if (name === undefined || out.has(name)) return;
      if (!NAME.test(name)) at(j, `select: "${name}" can only use letters, digits and _`);
      else if (params.has(name)) at(j, `select: "${name}" is already a param`);
      else {
        out.set(name, `${name}@${use}`);
        this.selections.add(`${name}@${use}`);
      }
    });
    return out;
  }

  /**
   * One entry's keys with the block it names merged in and its `$names` filled. When the block reads
   * other blocks, `upstream` holds their stages (root first); `schema` is the chain's nearest
   * `fields`. `typed` is the merged keys before filling. Undefined when a name is used where it
   * can't go.
   */
  private prepare(raw: Record<string, unknown>, scope: Scope, at: (e: string) => void, typos: boolean):
    { typed: Record<string, unknown>; template: Record<string, unknown> } | undefined {
    const merged = expandPanel(raw, scope.blocks);
    merged.errors.forEach(at);
    const parts = [merged.template, ...merged.stages.map((s) => s.keys)];
    if (typos) nearMisses(parts, scope.names, scope.kind).forEach(at);
    // A component's own selections are values from the user, refused wherever inputs are.
    const own = new Set(scope.selects.keys());
    const params = own.size ? new Set([...scope.names].filter((n) => !own.has(n))) : scope.names;
    const refused = parts.flatMap((part) => [...refusedPlaces(part, params, scope.kind), ...refusedPlaces(part, own, "input")]);
    refused.forEach(at);
    if (refused.length) return undefined;
    const fillErrors: string[] = [];
    const [template, ...stages] = parts.map((part) => withVars(fill(part, scope, fillErrors) as Record<string, unknown>, scope, at));
    fillErrors.forEach(at);
    if (stages.length) template.upstream = stages.map((keys, i) => ({ block: merged.stages[i].block, keys }));
    if (merged.schema) template.schema = merged.schema;
    // A checklist's save is the list it ticks, never a block's target.
    if (typeof template.save === "string" && scope.blocks.has(template.save) && template.view !== "checklist") {
      const saving = blockTarget(template.save, scope.blocks);
      if (saving && "error" in saving) {
        at(saving.error);
        return undefined;
      }
      if (saving) template.target = saving.target;
      const schema = schemaOf(template.save, scope.blocks);
      if (schema && !template.schema) template.schema = schema;
    }
    const selected = selectOf(template);
    if (selected !== undefined && scope.selects.has(selected)) template.select = scope.selects.get(selected);
    return { typed: merged.template, template };
  }

  /** Keys beside `use` replace those keys in every panel the component makes that takes them. */
  private applyOverrides(raw: Record<string, unknown>, scope: Scope, produced: Produced[], name: string, at: (e: string) => void): void {
    const keys = withoutInternal(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "use" && k !== "with")), at);
    if (Object.keys(keys).length === 0) return;
    const filled = this.prepare(keys, scope, at, false)?.template;
    if (!filled) return;
    const set = (t: Produced, key: string) => {
      const value = filled[key];
      if (value === null || value === undefined) delete t.template[key];
      else t.template[key] = value;
      t.writtenIn[key] = scope.path;
    };
    // Keys typed empty aren't in `filled`; they remove the key from the component's panels.
    for (const key of new Set([...Object.keys(keys), ...Object.keys(filled)])) {
      if (isInternal(key)) continue;
      const targets = produced.filter((pr) => {
        const def = typeof pr.template.view === "string" ? viewDef(pr.template.view) : undefined;
        return def && ([...COMMON_KEYS, ...def.keys] as string[]).includes(key);
      });
      if (targets.length === 0) {
        at(`"${key}" doesn't apply to any panel of ${name}`);
        continue;
      }
      for (const t of targets) {
        set(t, key);
        // A chain's stages and schema come with the source that named it; formula values with the formulas.
        if (key === "source") for (const k of ["upstream", "schema"]) set(t, k);
        if (key === "compute") set(t, "vars");
        if (key === "save") set(t, "target");
      }
    }
  }
}
