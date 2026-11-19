import { RESERVED, resolveList } from "../store.ts";
import type { SourceDef } from "./types.ts";

/** Any other text names a list in the data note or the app note. */
export const list: SourceDef = {
  id: "list",
  matches: () => true,
  validate: (p) => (RESERVED.includes(p.source!) ? [`source can't use "${p.source}", which names part of the app`] : []),
  permissions: () => [],
  deps: (_p, files) => [`file:${files.dataPath}`, `file:${files.appPath}`],
  load: (p, files, layer) => resolveList(p.source!, layer.host.frontmatter(files.dataPath), layer.host.frontmatter(files.appPath) ?? {}),
};
