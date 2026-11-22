import { scalar } from "./insert.ts";
import type { AppSpec } from "./spec.ts";
import { InputRef, InputText } from "./template.ts";

/** An app as "Open an app…" lists it. */
export interface AppItem {
  name: string;
  /** Its `app:` sentence. */
  description: string;
  path: string;
}

/**
 * The apps in the order to offer them: those opened lately first, in the order Obsidian keeps them
 * (`recent`, newest first); then those whose activity is newest (`lastActive`, by path); then the
 * rest by name.
 */
export function orderApps<T extends AppItem>(apps: readonly T[], recent: readonly string[], lastActive: ReadonlyMap<string, number>): T[] {
  const opened = (a: T) => {
    const i = recent.indexOf(a.path);
    return i < 0 ? recent.length : i;
  };
  const active = (a: T) => lastActive.get(a.path) ?? 0;
  return [...apps].sort((a, b) => opened(a) - opened(b) || active(b) - active(a) || a.name.localeCompare(b.name));
}

/**
 * One choice of what an embed can show of an app: a title or label, as the block's `panels:` names
 * it, with how many of the app's panels it names; or a panel nothing can name, with its view and why.
 */
export type EmbedChoice = { name: string; panels: number } | { view: string; reason: string };

/**
 * An app's panels as an embed names them: by title, else label, typed as plain text, which is how
 * the block's `panels:` finds them. Each name is one choice, in the order its first panel comes, and
 * picks every panel with that title or label.
 */
export function embedChoices(spec: AppSpec): EmbedChoice[] {
  const namesOf = (t: Record<string, unknown>) => [t.title, t.label].filter((v): v is string => typeof v === "string");
  const out: EmbedChoice[] = [];
  for (const { template, panel } of spec.panels) {
    const [name] = namesOf(template);
    if (name === undefined) {
      const typed = template.title ?? template.label;
      const reason = typed === undefined ? "It has no title or label"
        : typed instanceof InputRef || typed instanceof InputText ? `Its ${template.title === undefined ? "label" : "title"} changes with an input`
        : `Its ${template.title === undefined ? "label" : "title"} isn't text`;
      out.push({ view: panel.view, reason });
    } else if (!out.some((c) => "name" in c && c.name === name)) {
      out.push({ name, panels: spec.panels.filter((ps) => namesOf(ps.template).includes(name)).length });
    }
  }
  return out;
}

/**
 * What to name in `panels:` for the names chosen. Nothing when every panel is chosen, as a block
 * without it shows them all; nothing too when no panel can be named, as the whole app is all a
 * block can show of it then.
 */
export function embedPanels(choices: readonly EmbedChoice[], chosen: readonly string[]): string[] | undefined {
  const names = choices.flatMap((c) => ("name" in c ? [c.name] : []));
  if (names.length === 0 || (names.length === choices.length && names.every((n) => chosen.includes(n)))) return undefined;
  return names.filter((n) => chosen.includes(n));
}

/** A `gizmo` block that shows the app `link` names: only the panels named, or all of them. */
export function embedBlock(link: string, panels?: readonly string[]): string {
  const lines = ["```gizmo", `app: ${JSON.stringify(`[[${link}]]`)}`];
  if (panels) lines.push(`panels: [${panels.map((p) => scalar(p, true)).join(", ")}]`);
  return [...lines, "```"].join("\n");
}

/** A block as it goes in at the cursor, between the text `before` and `after` it on the line: on lines of its own. */
export function blockAt(before: string, after: string, block: string): string {
  return `${before.trim() ? "\n" : ""}${block}${after.trim() ? "\n" : ""}`;
}
