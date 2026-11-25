/**
 * What Do… offers for a line that names no shortcut and that no shortcut's name starts: the apps
 * whose name has every word typed, to open, and Gizmo's own windows by name. In the order given (the
 * apps as "Open an app…" orders them), at most `limit`.
 */
export interface DoChoice {
  label: string;
  run(): void;
}

export function doChoices(
  line: string,
  apps: readonly { name: string; path: string }[],
  actions: readonly { name: string; run(): void }[],
  open: (path: string) => void,
  limit = 5,
): DoChoice[] {
  const words = line.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const has = (name: string) => words.every((w) => name.toLowerCase().includes(w));
  return [
    ...apps.filter((a) => has(a.name)).map((a): DoChoice => ({ label: `Open ${a.name}`, run: () => open(a.path) })),
    ...actions.filter((a) => has(a.name)).map((a): DoChoice => ({ label: a.name, run: () => a.run() })),
  ].slice(0, limit);
}
