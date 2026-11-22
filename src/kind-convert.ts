import type { NoteReader } from "./expand.ts";
import { isPlainObject } from "./keys.ts";
import type { Row } from "./data.ts";
import { ROW_FIELDS, fieldsProblem, kindProblem } from "./kind.ts";
import type { Op } from "./ledger.ts";
import { rowIdOf } from "./ledger-store.ts";
import { readSpec, savedFields, type AppSpec } from "./spec.ts";
import { basename } from "./store.ts";

/** What making a kind from one of an app's lists would do, for a person to read before saying yes. */
export interface KindPlan {
  list: string;
  /** The kind note to make, and its whole text. */
  path: string;
  text: string;
  /** The app note's text with its keys pointed at the kind, and each line that changed (0-based, in the note). */
  appText: string;
  changed: { line: number; from: string; to: string }[];
}

/** Text a YAML value needs quotes for: what YAML would read as something else, or as the start of a map, list or comment. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_ ./-]*$/;
const WORDS = /^(true|false|yes|no|on|off|null|~)$/i;

/** A value as YAML on one line, the way the gallery's notes are typed: `{type: number, label: Spent}`, `[food, home]`. */
export function yamlInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(yamlInline).join(", ")}]`;
  if (isPlainObject(value)) return `{${Object.entries(value).map(([k, v]) => `${yamlInline(k)}: ${yamlInline(v)}`).join(", ")}}`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
  return PLAIN.test(text) && !WORDS.test(text) && text.trim() === text ? text : JSON.stringify(text);
}

/**
 * The lists of an app that can become a kind: the ones a form, button or row action saves rows
 * into, in the app's own data note. Not a checklist's ticks, nor what a block records.
 */
export function convertible(spec: AppSpec): string[] {
  const { whole } = savedFields(spec.panels, new Map(Object.entries(spec.blocks)), false);
  const recorded = new Set(Object.values(spec.blocks).flatMap((b) => (b.record === undefined ? [] : [typeof b.into === "string" ? b.into : ""])));
  const out = new Set<string>();
  for (const { panel: p } of spec.panels) {
    if (p.view === "checklist" || p.target?.kind !== "list" || p.target.at !== undefined) continue;
    if (!recorded.has(p.target.name) && !(whole.has(p.target.name) && !fieldsOf(spec, p.target.name))) out.add(p.target.name);
  }
  return [...out];
}

/** The fields describing a list's rows, as typed: those of a block that reads the list, else of a form that saves to it. */
function fieldsOf(spec: AppSpec, list: string): Record<string, unknown> | undefined {
  for (const block of Object.values(spec.blocks)) if (block.source === list && isPlainObject(block.fields)) return block.fields;
  for (const { panel: p, template } of spec.panels) {
    if (p.target?.kind === "list" && p.target.at === undefined && p.target.name === list && isPlainObject(template.fields)) return template.fields;
  }
  return undefined;
}

/** The note a kind made from `list` goes in: named after the list, beside the app; `<Name> rows` when that name is taken. */
function kindPathFor(list: string, appPath: string, taken: (path: string) => boolean): string | undefined {
  const folder = appPath.includes("/") ? `${appPath.slice(0, appPath.lastIndexOf("/"))}/` : "";
  const name = `${list.charAt(0).toUpperCase()}${list.slice(1).replace(/_/g, " ")}`;
  return [`${folder}${name}.md`, `${folder}${name} rows.md`].find((p) => !taken(p));
}

/**
 * The app note's lines with `list` replaced by a link to the kind wherever the keys name the list
 * itself: the `source` of a block that reads it, and a panel's `source` or `save` when no block has
 * that name (a panel naming a block keeps reading the block). Only keys typed on a line of their own.
 */
function pointAtKind(lines: string[], list: string, link: string, blocks: readonly string[]): KindPlan["changed"] {
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) return [];
  const changed: KindPlan["changed"] = [];
  const isBlock = blocks.includes(list);
  let inData = false;
  let block: string | undefined;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      inData = /^data:\s*$/.test(line);
      block = undefined;
      continue;
    }
    if (inData) {
      const named = /^ {2}([^\s:#][^:]*):\s*$/.exec(line);
      if (named) block = named[1].trim();
    }
    const m = /^(\s*(?:- )?)(source|save):\s*(["']?)([^"'#]+?)\3\s*$/.exec(line);
    if (!m || m[4] !== list) continue;
    // In `data:`, a block that reads another block of that name keeps reading it.
    if (inData ? m[2] !== "source" || (isBlock && block !== list) : isBlock) continue;
    const to = `${m[1]}${m[2]}: "${link}"`;
    changed.push({ line: i, from: line, to });
    lines[i] = to;
  }
  return changed;
}

/**
 * Plans turning one of an app's lists into a kind: the kind note (its fields as the app types
 * them) and the app note pointed at it. The plan is checked by reading the app again as it would
 * be: when it then has a new problem, or still keeps the list itself, nothing is offered.
 */
export function planKind(opts: {
  appPath: string;
  appText: string;
  fm: Record<string, unknown>;
  spec: AppSpec;
  list: string;
  notes: NoteReader;
  parse: (yaml: string) => unknown;
  taken: (path: string) => boolean;
}): KindPlan | { error: string } {
  const { appPath, spec, list, fm } = opts;
  const app = basename(appPath);
  if (fm.use !== undefined) return { error: `${app}'s panels come from a component; point the component's own keys at a kind instead` };
  if (spec.store !== undefined || spec.split) return { error: `${app} keeps its data in a note of its own choosing (store or devices); a kind keeps its rows beside the kind's note` };
  if (!convertible(spec).includes(list)) return { error: `${app} saves no rows into a list called ${list}` };
  const problem = kindProblem(list);
  if (problem) return { error: `${problem}; rename the list first` };
  const fields = fieldsOf(spec, list);
  if (!fields) return { error: `no fields describe the rows of ${list}; give the form that saves them fields, or a data block with fields` };
  const kept = fieldsProblem(fields);
  if (kept) return { error: `${kept}; rename that field of ${list} first` };
  const path = kindPathFor(list, appPath, opts.taken);
  if (!path) return { error: `a note for the kind is already there; rename it first` };
  const text = [
    "---", `kind: ${yamlInline(list)}`, "fields:", ...Object.entries(fields).map(([k, v]) => `  ${yamlInline(k)}: ${yamlInline(v)}`), "---",
    `The rows of ${list}, for any app to read and add to: \`source: "[[${basename(path)}]]"\` reads them, \`save: "[[${basename(path)}]]"\` adds one.`,
    "",
  ].join("\n");

  const lines = opts.appText.split("\n");
  const changed = pointAtKind(lines, list, `[[${basename(path)}]]`, Object.keys(spec.blocks));
  const byHand = { error: `${app}'s keys for ${list} aren't each on a line of their own, so Gizmo can't change them safely; make the kind note, then point source and save at "[[${basename(path)}]]" yourself` };
  if (!changed.length) return byHand;
  const appText = lines.join("\n");
  const end = lines.indexOf("---", 1);
  let after: Record<string, unknown> | undefined;
  let kindFm: Record<string, unknown> | undefined;
  try {
    after = opts.parse(lines.slice(1, end).join("\n")) as Record<string, unknown>;
    kindFm = opts.parse(text.split("\n").slice(1, text.split("\n").indexOf("---", 1)).join("\n")) as Record<string, unknown>;
  } catch {
    return byHand;
  }
  const notes: NoteReader = {
    resolve: (link, from) => (link === basename(path) ? path : opts.notes.resolve(link, from)),
    frontmatter: (p) => (p === path ? kindFm : opts.notes.frontmatter(p)),
  };
  const was = new Set(readSpec(fm, { notes: opts.notes, path: appPath })?.errors ?? []);
  const read = readSpec(after, { notes, path: appPath });
  const fresh = (read?.errors ?? ["it would no longer be an app"]).filter((e) => !was.has(e));
  const still = read?.spec?.panels.some(({ panel: p }) => (p.target?.kind === "list" && p.target.at === undefined && p.target.name === list)
    || (p.source === list && !p.kind));
  if (fresh.length || still) return byHand;
  return { list, path, text, appText, changed };
}

/**
 * A list's rows as adds to the kind's rows, each under the id it has. A field Gizmo keeps on a
 * kind's rows (line, matched, by, writer, imported), which no field of the list can be, is left
 * behind: on a kind it would say the row is planned, someone else's, or read from a file.
 */
export function carriedOps(list: string, rows: readonly Row[], newId: () => string): Op[] {
  return rows.map((row) => ({ op: "add", l: list, row: rowIdOf(row) ?? newId(), v: Object.fromEntries(Object.entries(row).filter(([k]) => !ROW_FIELDS.includes(k))) }));
}
