import type { Row } from "../data.ts";
import { fileDep } from "../deps.ts";
import { RESERVED, resolveList } from "../store.ts";
import type { SourceDef } from "./types.ts";

/**
 * Each row of a saved list carries its place in the list under this key, through where, sort,
 * limit and compute (rows are copied with their symbol keys), so an edit can find it again.
 */
export const ROW_INDEX = Symbol("row index");

const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);

/** Any other text names a list in the data note or the app note. */
export const list: SourceDef = {
  id: "list",
  matches: () => true,
  validate: (p) => (RESERVED.includes(p.source!) ? [`source can't use "${p.source}", which names part of the app`] : []),
  permissions: () => [],
  deps: (_p, files) => [fileDep(files.dataPath), fileDep(files.appPath)],
  // One copy per version of the two notes, shared by every panel and the background: nothing
  // downstream changes a loaded row or list in place.
  load: (p, files, layer) => layer.kept(`list\n${files.dataPath}\n${files.appPath}\n${p.source}`, [files.dataPath, files.appPath], () => {
    const value = resolveList(p.source!, layer.host.frontmatter(files.dataPath), layer.host.frontmatter(files.appPath) ?? {});
    // Copies: the rows in the metadata cache are never changed. Not enumerable, so rows still
    // compare and serialise as typed.
    return Array.isArray(value) ? value.map((r, i) => (isRow(r) ? Object.defineProperty({ ...r }, ROW_INDEX, { value: i }) : r)) : value;
  }),
};
