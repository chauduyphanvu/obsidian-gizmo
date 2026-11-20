import type { Row } from "../data.ts";
import type { DataLayer } from "../datalayer.ts";
import { fileDep, folderDep } from "../deps.ts";
import { RESERVED, resolveList } from "../store.ts";
import { copyRow } from "../data.ts";
import { logFolder } from "../ledger.ts";
import type { SourceDef } from "./types.ts";

/**
 * Each row of a saved list carries its place in the list under this key, through where, sort,
 * limit and compute (rows are copied with their symbol keys), so an edit can find it again.
 */
export const ROW_INDEX = Symbol("row index");

const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);

/** Copies, so the rows in the metadata cache are never changed; their place kept, not enumerable, so rows still compare and serialise as typed. */
function placed(list: unknown[]): unknown[] {
  return list.map((r, i) => (isRow(r) ? Object.defineProperty(copyRow(r), ROW_INDEX, { value: i }) : r));
}



/** Any other text names a list in the data note or the app note. */
export const list: SourceDef = {
  id: "list",
  matches: () => true,
  validate: (p) => (RESERVED.includes(p.source!) ? [`source can't use "${p.source}", which names part of the app`] : []),
  permissions: () => [],
  deps: (_p, files) => [fileDep(files.dataPath), fileDep(files.appPath), folderDep(logFolder(files.dataPath)), ...(files.devices ? [folderDep(files.devices)] : [])],
  // One copy per version of the notes, shared by every panel and the background: nothing
  // downstream changes a loaded row or list in place.
  load: (p, files, layer) => {
    const ledger = layer.ledger;
    if (ledger) {
      const devices = files.devices;
      layer.noteApp(files.dataPath, files.appPath, devices);
      return layer.kept(`list\n${files.dataPath}\n${files.appPath}\n${p.source}`, [files.dataPath, files.appPath, `${logFolder(files.dataPath)}/`, ...(devices ? [`${devices}/`] : [])], async () => {
        const old = devices ? layer.deviceNotes(devices) : [];
        const state = await ledger.state(files.dataPath, layer.host.frontmatter(files.appPath) ?? {}, old);
        const rows = state.lists.get(p.source!)?.rows;
        if (rows) return placed(rows);
        const ticked = state.ticked.get(p.source!);
        if (ticked) return [...ticked];
        return resolveList(p.source!, layer.host.frontmatter(files.dataPath), layer.host.frontmatter(files.appPath) ?? {});
      });
    }
    return layer.kept(`list\n${files.dataPath}\n${files.appPath}\n${p.source}`, [files.dataPath, files.appPath], () => {
      const value = resolveList(p.source!, layer.host.frontmatter(files.dataPath), layer.host.frontmatter(files.appPath) ?? {});
      return Array.isArray(value) ? placed(value) : value;
    });
  },
};
