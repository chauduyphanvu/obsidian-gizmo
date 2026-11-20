import type { Row } from "../data.ts";
import type { DataLayer } from "../datalayer.ts";
import { fileDep, notesDep } from "../deps.ts";
import { RESERVED, resolveList } from "../store.ts";
import type { SourceDef } from "./types.ts";

/**
 * Each row of a saved list carries its place in the list under this key, through where, sort,
 * limit and compute (rows are copied with their symbol keys), so an edit can find it again.
 */
export const ROW_INDEX = Symbol("row index");
/** A row read from a device's own note (`devices: split`) carries that note; any other comes from the data note. */
export const ROW_SOURCE = Symbol("row source");

const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);

/** Copies, so the rows in the metadata cache are never changed; their place kept, not enumerable, so rows still compare and serialise as typed. */
function placed(list: unknown[], source?: string): unknown[] {
  return list.map((r, i) => {
    if (!isRow(r)) return r;
    const row = Object.defineProperty({ ...r }, ROW_INDEX, { value: i });
    return source === undefined ? row : Object.defineProperty(row, ROW_SOURCE, { value: source });
  });
}

/** The device notes directly in a split app's folder: the notes there that say which device they are. */
export function deviceNotes(layer: DataLayer, folder: string): string[] {
  return layer.notes(folder)
    .filter((r) => typeof r.path === "string" && !r.path.slice(folder.length + 1).includes("/") && typeof r.device === "string")
    .map((r) => r.path as string)
    .sort();
}

/** When a row was saved, as its text sorts: `YYYY-MM-DDTHH:MM`; a row without one sorts first. */
const savedAt = (r: unknown) => (isRow(r) && typeof r.at === "string" ? r.at : "");

/** Any other text names a list in the data note or the app note. */
export const list: SourceDef = {
  id: "list",
  matches: () => true,
  validate: (p) => (RESERVED.includes(p.source!) ? [`source can't use "${p.source}", which names part of the app`] : []),
  permissions: () => [],
  deps: (_p, files) => [fileDep(files.dataPath), fileDep(files.appPath), ...(files.split ? [notesDep(files.split.folder)] : [])],
  // One copy per version of the notes, shared by every panel and the background: nothing
  // downstream changes a loaded row or list in place.
  load: (p, files, layer) => {
    const split = files.split;
    const paths = [files.dataPath, files.appPath, ...(split ? [`${split.folder}/`] : [])];
    return layer.kept(`list\n${files.dataPath}\n${files.appPath}\n${split?.folder ?? ""}\n${p.source}`, paths, () => {
      const value = resolveList(p.source!, layer.host.frontmatter(files.dataPath), layer.host.frontmatter(files.appPath) ?? {});
      const own = Array.isArray(value) ? placed(value) : value;
      const devices = split ? deviceNotes(layer, split.folder) : [];
      if (!devices.length || !Array.isArray(own)) return own;
      // Each device adds rows to its own note; read together, they are in the order they were saved.
      const rows = [...own, ...devices.flatMap((path) => {
        const list = layer.host.frontmatter(path)?.[p.source!];
        return Array.isArray(list) ? placed(list, path) : [];
      })];
      return rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => savedAt(a).localeCompare(savedAt(b)) || i - j).map(([r]) => r);
    });
  },
};
