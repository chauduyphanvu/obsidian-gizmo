import { sourceDef } from "./sources/registry.ts";
import type { Panel } from "./spec.ts";
import { definitionReason } from "./store.ts";

/** Fields of a notes row that come from the file, not from its properties. */
const FILE_FIELDS = ["name", "path", "tags", "mtime", "ctime"];

/**
 * What a panel's rows can be written back to: their notes (from `notes` or a base), their saved
 * list, or the task lines they came from; else undefined.
 */
export function editableSource(p: Panel): "notes" | "list" | "tasks" | undefined {
  const id = p.source ? sourceDef(p.source).id : undefined;
  return id === "notes" || id === "list" || id === "tasks" ? id : id === "base" ? "notes" : undefined;
}

/**
 * Problems with changing these fields of a panel's rows where they came from (a table's `edit`;
 * a board's group field). The source is decided by the root of its chain; computed columns, a
 * note's file fields and the properties that would make a note an app or a component can't be
 * written.
 */
export function editErrors(p: Panel, fields: readonly string[]): string[] {
  const kind = editableSource(p);
  if (!kind) return ["edit works on notes and saved lists"];
  if (kind === "tasks" && fields.some((f) => f !== "done")) return ['edit: only "done" can be changed on tasks'];
  const computed = new Set([p, ...(p.upstream ?? [])].flatMap((s) => Object.keys(s.compute ?? {})));
  return fields.flatMap((f) => (computed.has(f) ? [`edit: "${f}" is computed`]
    : kind === "notes" && FILE_FIELDS.includes(f) ? [`edit: "${f}" comes from the note's file, not its properties`]
    : kind === "notes" && definitionReason(f) ? [`edit can't change "${f}", ${definitionReason(f)}`]
    : []));
}

/**
 * The permission changing a panel's rows needs, asked by `key`: notes in its `from` (any note,
 * for a base), or ticking tasks in its `from`; a saved list is the app's own.
 */
export function editPermissions(p: Panel, key: keyof Panel): [string, keyof Panel][] {
  if (editableSource(p) === "tasks") return p.from ? [[`tasks:${p.from}`, key]] : [];
  if (editableSource(p) === "notes" && sourceDef(p.source!).id === "base") return [["edit:*", key]];
  return editableSource(p) === "notes" && p.from ? [[`edit:${p.from}`, key]] : [];
}
