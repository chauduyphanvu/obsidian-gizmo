import { sourceDef } from "./sources/registry.ts";
import type { Panel } from "./spec.ts";
import { storeTarget } from "./store.ts";
import {
  InputRef, NAME, fillParams, nearMisses, parseInputs, refusedPlaces, unsafeValue,
} from "./template.ts";
import { COMMON_KEYS, DATA_KEYS, GROUP_KEYS, KEY_TYPES, isPlainObject, readValue } from "./views/common.ts";
import { viewDef } from "./views/registry.ts";

/** The language version this plugin reads. */
export const SPEC_VERSION = 1;

export function checkVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === SPEC_VERSION) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > SPEC_VERSION) {
    return `spec: ${value} needs a newer Note Apps (this one reads spec ${SPEC_VERSION})`;
  }
  return `spec must be ${SPEC_VERSION}`;
}

/** Keys a named source in `data:` may hold. */
const BLOCK_KEYS: readonly string[] = [...DATA_KEYS, ...GROUP_KEYS];

/** Named sources from `data:`, checked once; panels take their keys by naming them in `source`. */
export type Blocks = Map<string, Record<string, unknown>>;

export function readBlocks(value: unknown, errors: string[]): Blocks {
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
      const read = readValue(key as keyof Panel, v);
      if ("error" in read) errors.push(`${at}: ${read.error}`);
      else block[key] = read.value;
    }
    if (typeof block.source !== "string" || !block.source) errors.push(`${at} needs a source`);
    else blocks.set(name, block);
  }
  // A block reads a URL, notes or a list, never another block, so there are no chains to follow.
  for (const [name, block] of [...blocks]) {
    const source = String(block.source);
    if (source !== name && blocks.has(source)) {
      errors.push(`data.${name}: source "${source}" is another data block; blocks can't use each other`);
      blocks.delete(name);
    }
  }
  return blocks;
}

/**
 * A panel whose `source` names a block gets the block's keys; the panel's own keys then replace
 * them one by one, and an empty panel key removes the key it would have inherited.
 */
export function expandPanel(raw: Record<string, unknown>, blocks: Blocks): { template: Record<string, unknown>; errors: string[] } {
  const name = raw.source;
  const block = typeof name === "string" && sourceDef(name).id === "list" ? blocks.get(name) : undefined;
  if (!block) return { template: raw, errors: [] };
  const def = typeof raw.view === "string" ? viewDef(raw.view) : undefined;
  const allowed = new Set<string>(def ? [...COMMON_KEYS, ...def.keys] : []);
  const errors: string[] = [];
  const template: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "source" && value !== null && value !== undefined) template[key] = value;
  }
  for (const [key, value] of Object.entries(block)) {
    if (key === "source" || key in raw) continue;
    if (def && !allowed.has(key)) errors.push(`"${key}" doesn't apply to ${def.id} (from data.${name as string})`);
    else template[key] = value;
  }
  template.source = block.source;
  return { template, errors };
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

/** The note an entry was written in: its names, data blocks and how `$names` are filled there. */
interface Scope {
  path: string;
  blocks: Blocks;
  names: ReadonlySet<string>;
  kind: "input" | "param";
  params: ReadonlyMap<string, unknown>;
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
  private notes: NoteReader | undefined;
  private appPath: string;

  constructor(notes: NoteReader | undefined, appPath: string) {
    this.notes = notes;
    this.appPath = appPath;
  }

  appScope(blocks: Blocks, inputs: ReadonlySet<string>): Scope {
    return { path: this.appPath, blocks, names: inputs, kind: "input", params: new Map() };
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
      const merged = expandPanel(raw, scope.blocks);
      merged.errors.forEach(at);
      nearMisses(merged.template, scope.names, scope.kind).forEach(at);
      const refused = refusedPlaces(merged.template, scope.names, scope.kind);
      refused.forEach(at);
      if (refused.length) return [];
      const fillErrors: string[] = [];
      const template = fill(merged.template, scope, fillErrors) as Record<string, unknown>;
      fillErrors.forEach(at);
      // A param may name a list for `source` or `save`, never a URL, notes or an app's input.
      for (const key of ["source", "save"] as const) {
        const typed = merged.template[key];
        const got = template[key];
        if (scope.kind !== "param" || typeof typed !== "string" || !/^\$[A-Za-z_]\w*$/.test(typed) || !scope.names.has(typed.slice(1))) continue;
        if (got instanceof InputRef || typeof got !== "string" || (key === "source" && sourceDef(got).id !== "list")) {
          at(`${typed} can only name a list here; write a URL in the component with ${typed} in its path or query`);
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
    const inner: Scope = { path, blocks: readBlocks(component.data, blockErrors), names: new Set(component.params.keys()), kind: "param", params };
    blockErrors.forEach((e) => at(`${name} ${e}`));
    const produced = component.panels.flatMap((entry, j) => {
      const step = [...trail, `${name} panel ${j + 1}`];
      if (!isPlainObject(entry)) {
        this.errors.push(`${base ? `${base} (from ${step.join(" → ")})` : step.join(" → ")}: must be a set of keys`);
        return [];
      }
      return this.expand(entry, inner, base, step, [...chain, path]);
    });
    this.applyOverrides(raw, scope, produced, name, at);
    return produced;
  }

  /** Keys beside `use` replace those keys in every panel the component makes that takes them. */
  private applyOverrides(raw: Record<string, unknown>, scope: Scope, produced: Produced[], name: string, at: (e: string) => void): void {
    const keys = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "use" && k !== "with"));
    if (Object.keys(keys).length === 0) return;
    const merged = expandPanel(keys, scope.blocks);
    const refused = refusedPlaces(merged.template, scope.names, scope.kind);
    refused.forEach(at);
    if (refused.length) return;
    const fillErrors: string[] = [];
    const filled = fill(merged.template, scope, fillErrors) as Record<string, unknown>;
    fillErrors.forEach(at);
    // Keys typed empty aren't in `filled`; they remove the key from the component's panels.
    for (const key of new Set([...Object.keys(keys), ...Object.keys(filled)])) {
      const value = filled[key];
      const targets = produced.filter((pr) => {
        const def = typeof pr.template.view === "string" ? viewDef(pr.template.view) : undefined;
        return def && ([...COMMON_KEYS, ...def.keys] as string[]).includes(key);
      });
      if (targets.length === 0) {
        at(`"${key}" doesn't apply to any panel of ${name}`);
        continue;
      }
      for (const t of targets) {
        if (value === null || value === undefined) delete t.template[key];
        else t.template[key] = value;
        t.writtenIn[key] = scope.path;
      }
    }
  }
}
