import { storeTarget } from "./store.ts";

/** A note of the gallery: its path under gallery/ (`Apps/Budget.md`) and its text exactly as written. */
export interface GalleryNote {
  path: string;
  text: string;
}

export interface GalleryApp {
  name: string;
  /** The app's one-line description, from its `app:` line. */
  about: string;
  note: GalleryNote;
}

/** What copying an app into a vault would do. */
export type Plan = { create: GalleryNote[]; reuse: string[] } | { refusal: string };

export const noteName = (path: string): string => path.split("/").pop()!.replace(/\.md$/i, "");

function frontmatter(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return [];
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  return end < 0 ? [] : lines.slice(1, end);
}

function unquote(value: string): string {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'")) return value.slice(1, value.lastIndexOf("'")).replace(/''/g, "'");
  return value.replace(/\s+#.*$/, "");
}

/** The apps of the gallery, by name, each with its description. */
export function galleryApps(notes: GalleryNote[]): GalleryApp[] {
  const apps: GalleryApp[] = [];
  for (const note of notes) {
    if (!note.path.startsWith("Apps/")) continue;
    const about = frontmatter(note.text).map((l) => /^app:\s*(.*?)\s*$/.exec(l)).find((m) => m)?.[1];
    if (about !== undefined) apps.push({ name: noteName(note.path), about: unquote(about), note });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** The names a note's panels `use`, as `use: "[[Name]]"`; anywhere in its keys, written out or inline. */
function usedNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of frontmatter(text)) {
    const link = /(?:^\s*(?:-\s+)*|[{,]\s*)use:\s*["']?(\[\[[^\]]*\]\])/.exec(line);
    if (link) names.add(noteName(storeTarget(link[1])));
  }
  return [...names];
}

/**
 * The gallery's components an app uses, and those they use in turn, each after the ones it needs.
 * A name the gallery has no component for is left out: the app's own check says if it's missing.
 */
export function componentsNeeded(app: GalleryNote, notes: GalleryNote[]): GalleryNote[] {
  const parts = new Map(notes.filter((n) => n.path.startsWith("Components/")).map((n) => [noteName(n.path).toLowerCase(), n]));
  const seen = new Set([app]);
  const out: GalleryNote[] = [];
  const visit = (note: GalleryNote) => {
    for (const name of usedNames(note.text)) {
      const part = parts.get(name.toLowerCase());
      if (!part || seen.has(part)) continue;
      seen.add(part);
      visit(part);
      out.push(part);
    }
  };
  visit(app);
  return out;
}

/**
 * The notes to create for an app and its components, or why not. `existing` holds, by the
 * gallery's names for them, the text of every note the vault already has under that name (they
 * are looked up by name, so a second one would make the app's `[[link]]` ambiguous). Nothing is
 * ever replaced: a taken name stops it, except a component that is already there word for word.
 */
export function planCopy(app: GalleryNote, components: GalleryNote[], existing: Record<string, string[]>): Plan {
  const appName = noteName(app.path);
  if (existing[appName]?.length) return { refusal: `“${appName}” already exists` };
  const create: GalleryNote[] = [];
  const reuse: string[] = [];
  for (const part of components) {
    const name = noteName(part.path);
    const have = existing[name] ?? [];
    if (!have.length) create.push(part);
    else if (have.every((text) => text === part.text)) reuse.push(name);
    else return { refusal: `“${name}” already exists and isn't the one “${appName}” needs` };
  }
  return { create: [...create, app], reuse };
}
