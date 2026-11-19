import { file } from "./file.ts";
import { base } from "./base.ts";
import { list } from "./list.ts";
import { notes } from "./notes.ts";
import { tasks } from "./tasks.ts";
import { thisNote } from "./this.ts";
import type { SourceDef } from "./types.ts";
import { url } from "./url.ts";

/** Every kind of source, tried in order; `list` matches anything, so it stays last. */
export const SOURCE_DEFS: readonly SourceDef[] = [url, notes, thisNote, file, tasks, base, list];

/** The kind of source a (filled) `source` value is. */
export function sourceDef(source: string): SourceDef {
  return SOURCE_DEFS.find((d) => d.matches(source))!;
}
