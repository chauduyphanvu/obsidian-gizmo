import { asksSource } from "./asks.ts";
import { expectSource } from "./expect.ts";
import { file } from "./file.ts";
import { kind } from "./kind.ts";
import { base } from "./base.ts";
import { list } from "./list.ts";
import { notes } from "./notes.ts";
import { tasks } from "./tasks.ts";
import { thisNote } from "./this.ts";
import type { SourceDef } from "./types.ts";
import { url } from "./url.ts";

/** Every kind of source, tried in order; `list` matches anything, so it stays last. */
export const SOURCE_DEFS: readonly SourceDef[] = [url, notes, thisNote, file, tasks, base, expectSource, asksSource, kind, list];

/** The kind of source a (filled) `source` value is. */
export function sourceDef(source: string): SourceDef {
  return SOURCE_DEFS.find((d) => d.matches(source))!;
}

/** Whether a source's rows are saved rows: a list of the app's own, or a kind's. */
export function rowsAreSaved(source: string | undefined): boolean {
  const id = source ? sourceDef(source).id : undefined;
  return id === "list" || id === "kind";
}

/** Whether a source's rows are notes in the vault (notes, tasks, a base), each named by its `path`. */
export function rowsAreNotes(source: string | undefined): boolean {
  const kind = source ? sourceDef(source).id : undefined;
  return kind === "notes" || kind === "tasks" || kind === "base";
}
