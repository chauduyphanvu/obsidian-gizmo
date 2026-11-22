import type { Row } from "../data.ts";
import { fileDep, folderDep } from "../deps.ts";
import { RESERVED, kindName, resolveList } from "../store.ts";
import { ROW_FIELDS, keptLines, lineAt, lineOf } from "../kind.ts";
import { isWhatIf, rowIdOf } from "../ledger-store.ts";
import { toTime } from "../time.ts";
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



const filled = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * A kind's rows on the lines `lines` keeps (every row for `all`), a planned row's line read at `at`
 * when shown ahead (see lineAt). A row that a logged row settled or pairs with (its `matched` names
 * that row) is left out where the logged line is kept too, since that row stands for it. A planned
 * row a logged row settled holds that row's `at` and fields in `settled`, so a panel can compare
 * what was planned with what happened.
 */
function onLines(rows: readonly unknown[], lines: string | string[] | undefined, at?: number): unknown[] {
  const kept = keptLines(lines);
  const withLogged = kept !== undefined && [lines ?? "logged"].flat().includes("logged");
  const logged = new Map<string, Row>();
  for (const r of rows) {
    const id = isRow(r) && lineOf(r) === "logged" ? rowIdOf(r) : undefined;
    if (id !== undefined) logged.set(id, r as Row);
  }
  return rows.flatMap((r) => {
    if (!isRow(r)) return kept ? [] : [r];
    if (kept && !kept.keeps(r, at)) return [];
    const line = lineOf(r);
    if (line === "logged" || !filled(r.matched)) return [r];
    if (withLogged) return [];
    const by = line === "planned" ? logged.get(String(r.matched)) : undefined;
    if (!by) return [r];
    const settled = Object.fromEntries(Object.entries(by).filter(([k]) => !ROW_FIELDS.includes(k)));
    return [Object.assign(copyRow(r), { settled })];
  });
}

/**
 * In a what-if, the rows as they are at `now`: of a kind's, those on the lines `lines` keeps then
 * (see onLines), a planned row whose time has come being on the logged line; of an app's own list,
 * all but the what-if rows dated after it.
 */
function happenedBy(value: unknown, now: number, kind: boolean, lines: string | string[] | undefined): unknown {
  if (!Array.isArray(value)) return value;
  if (kind) {
    const kept = onLines(value, lines, now);
    // A copy on the logged line has no `line`, so a formula that reads it agrees with `lines`.
    return kept.map((r) => {
      if (!isRow(r) || lineAt(r, now) === lineOf(r)) return r;
      const logged = copyRow(r);
      delete logged.line;
      return logged;
    });
  }
  const toCome = (r: unknown) => isRow(r) && isWhatIf(r) && (toTime(r.at) ?? -Infinity) > now;
  return value.some(toCome) ? value.filter((r) => !toCome(r)) : value;
}

/**
 * Any other text names a list in the data note or the app note. A kind's rows are read here too,
 * whichever app asks (see kind.ts): of those, only the lines the panel's `lines` keeps, logged rows
 * unless it says (see onLines), so whatever reads a panel's rows (its pipeline, rules, alerts,
 * replay) sees the same.
 */
export const list: SourceDef = {
  id: "list",
  matches: () => true,
  validate: (p) => (RESERVED.includes(p.source!) ? [`source can't use "${p.source}", which names part of the app`] : []),
  permissions: () => [],
  deps: (_p, files) => [fileDep(files.dataPath), fileDep(files.appPath), folderDep(logFolder(files.dataPath)), ...(files.devices ? [folderDep(files.devices)] : [])],
  // One copy per version of the notes, shared by every panel and the background: nothing
  // downstream changes a loaded row or list in place.
  load: (p, files, layer, opts) => {
    const ledger = layer.ledger;
    const ahead = layer.ahead !== undefined;
    const kind = kindName(layer.host.frontmatter(files.appPath)) === p.source;
    // Ahead, a planned row's line depends on the time each reader reads at, so lines are kept after the shared copy.
    const early = kind && !ahead ? keptLines(p.lines) : undefined;
    const pick = (value: unknown) => (kind && !ahead && Array.isArray(value) ? onLines(value, p.lines) : value);
    const key = `list\n${files.dataPath}\n${files.appPath}\n${p.source}${early ? `\n${early.key}` : kind && !ahead ? "\nall" : ""}`;
    if (ledger) {
      const devices = files.devices;
      layer.noteApp(files.dataPath, files.appPath, devices);
      const loaded = layer.kept(key, [files.dataPath, files.appPath, `${logFolder(files.dataPath)}/`, ...(devices ? [`${devices}/`] : [])], async () => {
        const old = devices ? layer.deviceNotes(devices) : [];
        const state = await ledger.state(files.dataPath, layer.host.frontmatter(files.appPath) ?? {}, old);
        // Shared with every reader: rows carry their ids, and nothing downstream changes them in place.
        const rows = state.lists.get(p.source!)?.rows;
        if (rows) return pick(rows);
        const ticked = state.ticked.get(p.source!);
        if (ticked) return [...ticked];
        const value = resolveList(p.source!, layer.host.frontmatter(files.dataPath), layer.host.frontmatter(files.appPath) ?? {});
        // In the past, a list its events hadn't started was empty; what the note holds now came later.
        return layer.at !== undefined && Array.isArray(value) ? [] : pick(value);
      });
      return ahead ? loaded.then((value) => happenedBy(value, opts.now.getTime(), kind, p.lines)) : loaded;
    }
    return layer.kept(key, [files.dataPath, files.appPath], () => {
      const value = resolveList(p.source!, layer.host.frontmatter(files.dataPath), layer.host.frontmatter(files.appPath) ?? {});
      return Array.isArray(value) ? pick(placed(value)) : value;
    });
  },
};
