import type { Row } from "../data.ts";
import { THIS } from "../template.ts";
import type { SourceDef } from "./types.ts";

/**
 * What `$this` and `source: this` read: a note's properties, with its `name`, `path`, `folder` and
 * `tags` (which win over properties of the same name).
 */
export function thisValues(path: string, frontmatter: Record<string, unknown> | undefined, tags: string[]): Row {
  const slash = path.lastIndexOf("/");
  return {
    ...frontmatter,
    name: path.slice(slash + 1).replace(/\.md$/i, ""),
    path,
    folder: slash < 0 ? "" : path.slice(0, slash),
    tags,
  };
}

/** `source: this`: one row, the properties of the note the app sits in. Reading its own note needs no grant. */
export const thisNote: SourceDef = {
  id: "this",
  matches: (source) => source === THIS,
  permissions: () => [],
  deps: (_p, files) => [`file:${files.hostPath ?? files.appPath}`],
  load(_p, files, layer) {
    const path = files.hostPath ?? files.appPath;
    return thisValues(path, layer.host.frontmatter(path), layer.host.tags(path));
  },
};
