/**
 * What the data layer tells its listeners changed, as keys: a file by path, a note name that links
 * resolve by, a web source, and a scope of notes (`*` for every note).
 */
export const fileDep = (path: string) => `file:${path}`;
export const nameDep = (name: string) => `name:${name}`;
export const urlDep = (source: string) => `url:${source}`;
export const notesDep = (scope: string) => `notes:${scope}`;
/** Any note directly or deeper in a folder, by its path alone (a scope would read commas and `#`). */
export const folderDep = (folder: string) => `folder:${folder}/`;
/** What the apps ask of the person (see asks.ts), which no file holds. */
export const ASKS_DEP = "asks:";

/** The scope of a notes key; undefined for any other key. */
export function scopeOfDep(dep: string): string | undefined {
  return dep.startsWith("notes:") ? dep.slice(6) : undefined;
}
