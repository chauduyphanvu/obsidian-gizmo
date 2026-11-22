import { scalar } from "./insert.ts";

/** Characters no file name may hold, on some system Obsidian runs on, and those a link can't name. */
const NOT_IN_NAMES = /[\\/:*?"<>|#^[\]]/;

/**
 * Why "New app" can't make a note of this name (trimmed) in a folder whose files and folders have
 * these names, if so. A name differing only in case is taken too, as it is on most disks.
 */
export function nameProblem(name: string, taken: readonly string[]): string | undefined {
  const n = name.trim();
  if (!n) return "Give it a name";
  if (NOT_IN_NAMES.test(n)) return "A name can't hold any of \\ / : * ? \" < > | # ^ [ ]";
  if (n.startsWith(".")) return "A name can't start with a dot";
  const file = `${n}.md`.toLowerCase();
  if (taken.some((t) => t.toLowerCase() === file)) return `There is already a note named ${n} in this folder`;
  return undefined;
}

/** Why "New app" can't make this app, if so: its name, or an app line that says nothing, which wouldn't make the note an app. */
export function newAppProblem(name: string, purpose: string, taken: readonly string[]): string | undefined {
  return nameProblem(name, taken) ?? (purpose.trim() ? undefined : "Say what it is for");
}

/**
 * A new app note: only its `app:` line, typed so YAML reads it back as written. That is an app
 * with no panels yet, which Insert panel and the app's own starter buttons add to.
 */
export function newAppText(purpose: string): string {
  return `---\napp: ${scalar(purpose.trim(), false)}\n---\n`;
}

/** Where the cursor goes in a new app note: at the end of its `app:` line. */
export function afterAppLine(text: string): { line: number; ch: number } {
  return { line: 1, ch: text.split("\n")[1].length };
}
