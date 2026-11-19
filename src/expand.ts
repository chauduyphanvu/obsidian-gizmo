import type { Panel } from "./spec.ts";
import { COMMON_KEYS, DATA_KEYS, KEY_TYPES, isPlainObject, readValue } from "./views/common.ts";
import { viewDef } from "./views/registry.ts";

/** Keys a named source in `data:` may hold. */
const BLOCK_KEYS: readonly string[] = DATA_KEYS;

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
  const block = typeof name === "string" && !/^https?:\/\//i.test(name) && name !== "notes" ? blocks.get(name) : undefined;
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
