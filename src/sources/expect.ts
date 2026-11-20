import { rowsOf, toTime, getPath } from "../data.ts";
import { fileDep, folderDep } from "../deps.ts";
import { areRules, expectRows, readExpect } from "../expect.ts";
import { logFolder } from "../ledger.ts";
import { list } from "./list.ts";
import type { SourceDef } from "./types.ts";

/** How far back `source: expect` goes when a rhythm's list has no older row. */
const BACK_MS = 400 * 24 * 3_600_000;

/**
 * `source: expect`: a row for each window of each of the app's rhythms, from the first row its list
 * holds: `{rule, window, at, met, due}`. Reading the app's own lists needs no grant. In an app whose
 * `expect:` isn't rules, it is the list called expect, as it was before rules.
 */
export const expectSource: SourceDef = {
  id: "expect",
  matches: (source) => source === "expect",
  permissions: () => [],
  deps: (_p, files) => [fileDep(files.appPath), fileDep(files.dataPath), folderDep(logFolder(files.dataPath))],
  async load(p, files, layer, opts) {
    const raw = layer.host.frontmatter(files.appPath)?.expect;
    if (!areRules(raw)) return list.load(p, files, layer, opts);
    const rules = readExpect(raw, []);
    const rows = new Map<string, unknown[]>();
    for (const r of rules) {
      if (r.kind !== "rhythm" || rows.has(r.source)) continue;
      rows.set(r.source, rowsOf(await layer.rawData(r.source, { view: "table", source: r.source }, files, opts)));
    }
    const now = opts.now.getTime();
    const times = [...rows.values()].flat().map((r) => toTime(getPath(r, "at"))).filter((t): t is number => t !== undefined);
    const from = Math.max(now - BACK_MS, times.length ? Math.min(...times) : now);
    return expectRows(rules, (list) => rows.get(list) ?? [], from, opts.now);
  },
};
