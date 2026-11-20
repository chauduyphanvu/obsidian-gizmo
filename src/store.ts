/**
 * Where an app's recorded data lives. Saving into the app note itself would make Obsidian
 * re-serialise the hand-typed definition on every save, so rows go to a separate data note:
 * `<folder>/<App> data.md` by default, or the note named by the app's `store:` key.
 */

/** The top-level keys of an app note and of a component note, in the order hints offer them. */
export const APP_KEYS: readonly string[] = ["app", "spec", "refresh", "store", "data", "inputs", "panels", "tabs", "use", "with", "view"];
export const COMPONENT_KEYS: readonly string[] = ["component", "params", "data", "panels", "tabs", "for", "spec"];

/** Top-level keys that define an app or component, and `this`; lists may never be named after them. */
export const RESERVED = [...new Set([...APP_KEYS, ...COMPONENT_KEYS, "this"])].filter((k) => k !== "view");

/**
 * Top-level keys that make a note an app, a component or a lens, or say what one shows. What the
 * plugin writes into a note's properties from data (a saved row, a field, a moved card) never sets
 * one, so data can't turn a note into something that runs.
 */
export const DEFINITION_KEYS = [...RESERVED, "view"];

/** Why a note's property can't be written from data: the end of a sentence, or undefined when it can. */
export function definitionReason(key: string): string | undefined {
  if (!DEFINITION_KEYS.includes(key)) return undefined;
  if (key === "app") return "which would make the note an app";
  if (key === "component") return "which would make the note a component";
  return "which is one of an app's own keys";
}

/** A row as a note's properties: without the keys that would make the note an app or a component. */
export function withoutDefinition<T extends Record<string, unknown>>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !DEFINITION_KEYS.includes(k))) as T;
}

/** Kinds of source that are one word (`this` is in RESERVED): `source:` reads the kind, so a list can't be named after one. */
export const SOURCE_WORDS = ["notes", "tasks", "expect"];

/** A frontmatter value that is there: not missing, null or false. */
export function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

/** A note its `app` key makes an app. */
export function isApp(fm: Record<string, unknown> | undefined): boolean {
  return isSet(fm?.app);
}

export function isComponent(fm: Record<string, unknown> | undefined): boolean {
  return !!fm && fm.component !== undefined && fm.component !== null && fm.component !== false && fm.app === undefined;
}

/**
 * A note that opens as an app: an app, or a component (which shows how to use it). No data note is
 * one, and no lens shows on one.
 */
export function runsAsApp(fm: Record<string, unknown> | undefined): boolean {
  return !!fm && (isSet(fm.app) || isSet(fm.component));
}

/** A path's note name: its last part, without `.md`. */
export function basename(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/i, "");
}

export function notePath(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

export function defaultDataPath(appPath: string): string {
  return `${appPath.replace(/\.md$/i, "")} data.md`;
}

/** An app's data note: the note its `store` names, else its default one. */
export function dataPathOf(store: string | undefined, appPath: string, storePath: (store: string, fromPath: string) => string): string {
  return store ? storePath(store, appPath) : defaultDataPath(appPath);
}

/** Where an app with `devices: split` kept each device's rows before every device kept its own log: a folder beside its data note. */
export function devicesFolder(dataPath: string): string {
  return dataPath.replace(/\.md$/i, "");
}

/** The note a `store:` value points at, as link text: `[[Logs/Weight|w]]` and `Logs/Weight.md` both give `Logs/Weight`. */
export function storeTarget(store: string): string {
  const inner = store.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  return inner.split("|")[0].split("#")[0].trim().replace(/\.md$/i, "");
}

/**
 * A list named by `source:` or a checklist. The data note wins when it has the key, so rows the
 * app recorded take over from any starting list typed into the app note.
 */
export function resolveList(
  name: string,
  dataFm: Record<string, unknown> | undefined,
  appFm: Record<string, unknown>,
): unknown {
  if (dataFm && name in dataFm) return dataFm[name] ?? [];
  return appFm[name] ?? [];
}
