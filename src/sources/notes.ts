import type { SourceDef } from "./types.ts";

/** `source: notes`: one row per note in the `from` scopes (#tags or folders). */
export const notes: SourceDef = {
  id: "notes",
  matches: (source) => source === "notes",
  validate: (p) => (p.from ? [] : ['source "notes" needs "from" (a #tag or folder)']),
  permissions: (p) => (p.from ? [[`read:${p.from}`, "from"]] : []),
  deps: (p) => [`notes:${p.from ?? ""}`],
  load: (p, _files, layer) => layer.notes(p.from ?? ""),
};
