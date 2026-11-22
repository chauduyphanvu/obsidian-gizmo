import type { AppFiles } from "../datalayer.ts";
import type { KindRef, Panel } from "../spec.ts";
import { defaultDataPath } from "../store.ts";
import { linesProblem } from "../kind.ts";
import { list } from "./list.ts";
import type { SourceDef } from "./types.ts";

/** A whole link, `[[Spend]]`: as a `source` or a `save`, the kind whose note it names. */
const KIND_LINK = /^\[\[[^[\]]+\]\]$/;

export function isKindLink(text: unknown): text is string {
  return typeof text === "string" && KIND_LINK.test(text.trim());
}

/** The kind a panel's rows belong to: the one its `source` links to, else the one it saves to. */
export function kindOfPanel(p: Panel): KindRef | undefined {
  return p.kind ?? (p.target?.kind === "list" && p.target.at !== undefined ? { path: p.target.at, name: p.target.name } : undefined);
}

/** A kind's rows are kept as an app keeps a list: in the data note beside the kind's own note. */
export function kindFiles(ref: KindRef): AppFiles {
  return { appPath: ref.path, dataPath: defaultDataPath(ref.path) };
}

/** The data notes of the kinds an app's panels read or save to: rows other apps change too. */
export function kindDataPaths(panels: readonly { panel: Panel }[]): string[] {
  return [...new Set(panels.flatMap(({ panel }) => {
    const ref = kindOfPanel(panel);
    return ref ? [kindFiles(ref).dataPath] : [];
  }))];
}

/**
 * A link to a kind note: its rows, read from the kind's own data note, whichever app asks. Every
 * reader passes the kind's note as the owner of the rows, so they all share one copy.
 */
export const kind: SourceDef = {
  id: "kind",
  matches: (source) => isKindLink(source),
  validate: (p) => {
    const problem = p.lines === undefined ? undefined : linesProblem(p.lines);
    return [...(kindOfPanel(p) ? [] : [`source: ${p.source} isn't a kind`]), ...(problem ? [problem] : [])];
  },
  permissions: (p, selfPath) => {
    const ref = kindOfPanel(p);
    return ref && ref.path !== selfPath ? [[`kind:${ref.path}`, "source"]] : [];
  },
  deps: (p) => {
    const ref = kindOfPanel(p);
    return ref ? list.deps({ ...p, source: ref.name }, kindFiles(ref)) : [];
  },
  load: (p, _files, layer, opts) => {
    const ref = kindOfPanel(p);
    return ref ? list.load({ ...p, source: ref.name }, kindFiles(ref), layer, opts) : [];
  },
};
