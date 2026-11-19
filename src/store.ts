/**
 * Where an app's recorded data lives. Saving into the app note itself would make Obsidian
 * re-serialise the hand-typed definition on every save, so rows go to a separate data note:
 * `<folder>/<App> data.md` by default, or the note named by the app's `store:` key.
 */

export function defaultDataPath(appPath: string): string {
  return `${appPath.replace(/\.md$/i, "")} data.md`;
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
