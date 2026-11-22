import { componentParams, linkOf } from "./expand.ts";
import { scalar } from "./insert.ts";
import { isPlainObject } from "./keys.ts";
import { POLICY_PATH } from "./policy.ts";
import { basename, storeTarget } from "./store.ts";

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
    if (about !== undefined) apps.push({ name: basename(note.path), about: unquote(about), note });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** The names a note's panels `use`, as `use: "[[Name]]"`; anywhere in its keys, written out or inline. */
function usedNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of frontmatter(text)) {
    const link = /(?:^\s*(?:-\s+)*|[{,]\s*)use:\s*["']?(\[\[[^\]]*\]\])/.exec(line);
    if (link) names.add(basename(storeTarget(link[1])));
  }
  return [...names];
}

/**
 * The gallery's components an app uses, and those they use in turn, each after the ones it needs.
 * A name the gallery has no component for is left out: the app's own check says if it's missing.
 */
export function componentsNeeded(app: GalleryNote, notes: GalleryNote[]): GalleryNote[] {
  const parts = new Map(notes.filter((n) => n.path.startsWith("Components/")).map((n) => [basename(n.path).toLowerCase(), n]));
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
  const appName = basename(app.path);
  // Installed where new notes go, which may be the vault's root: a shared note never becomes the policy.
  const policy = [app, ...components].find((n) => basename(n.path).toLowerCase() === basename(POLICY_PATH).toLowerCase());
  if (policy) return { refusal: `“${basename(policy.path)}” is the name of your data policy's note, which a copied note can't take` };
  if (existing[appName]?.length) return { refusal: `“${appName}” already exists` };
  const create: GalleryNote[] = [];
  const reuse: string[] = [];
  for (const part of components) {
    const name = basename(part.path);
    const have = existing[name] ?? [];
    if (!have.length) create.push(part);
    else if (have.every((text) => text === part.text)) reuse.push(name);
    else return { refusal: `“${name}” already exists and isn't the one “${appName}” needs` };
  }
  return { create: [...create, app], reuse };
}

/** A param of the kit an app is: the value the app gives it, else the kit's default; `given` when the app's `with:` names it. */
export interface KitParam {
  name: string;
  value: string | number | undefined;
  given: boolean;
}

/** A note's frontmatter, parsed; undefined when it has none or it isn't a set of keys. */
function keysOf(text: string, parse: (yaml: string) => unknown): Record<string, unknown> | undefined {
  const lines = frontmatter(text);
  if (!lines.length) return undefined;
  try {
    const keys = parse(lines.join("\n"));
    return isPlainObject(keys) ? keys : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to ask for when copying an app that is one whole kit (`use:` and `with:` at the top of its
 * note, the kit among `components`): each param the kit takes, with the value the app gives it, else
 * the kit's default. None for an app that isn't one, or whose kit takes a param a text field can't
 * hold (a list, a set of keys, true or false).
 */
export function kitParams(app: GalleryNote, components: GalleryNote[], parse: (yaml: string) => unknown): KitParam[] {
  const keys = keysOf(app.text, parse);
  const link = keys && linkOf(keys.use);
  const kit = link === undefined ? undefined : components.find((c) => basename(c.path).toLowerCase() === basename(link).toLowerCase());
  const params = kit && componentParams(keysOf(kit.text, parse)?.params);
  if (!keys || !params) return [];
  const given = isPlainObject(keys.with) ? keys.with : {};
  const out: KitParam[] = [];
  for (const [name, fallback] of params) {
    const value = (Object.hasOwn(given, name) ? given[name] : fallback) ?? undefined;
    if (value !== undefined && typeof value !== "string" && typeof value !== "number") return [];
    out.push({ name, value, given: Object.hasOwn(given, name) });
  }
  return out;
}

/** A note's text with its top-level `with:` (and any lines it runs on to) replaced by `line`, or `line` added after `use:`. */
function withLine(text: string, line: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  const top = (key: string) => lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${key}\\s*:`).test(l));
  const at = top("with");
  if (at < 0) {
    lines.splice(top("use") + 1, 0, line);
    return lines.join(eol);
  }
  let last = at;
  while (last + 1 < end && /^\s/.test(lines[last + 1])) last++;
  lines.splice(at, last - at + 1, line);
  return lines.join(eol);
}

/**
 * The app's note with the values typed for its kit's params (see kitParams) in its `with:`, written
 * on one line so YAML reads each back as typed. A field left empty, or a number field that doesn't
 * hold a number, keeps the value it started with; a param the app didn't name is written only when
 * it changed. With nothing changed, the note is exactly as the gallery wrote it.
 */
export function setUp(app: GalleryNote, params: KitParam[], typed: Readonly<Record<string, string>>): GalleryNote {
  const values = params.map((p) => {
    const text = (typed[p.name] ?? "").trim();
    if (text === "") return p.value;
    if (typeof p.value !== "number") return text;
    const n = Number(text);
    return Number.isFinite(n) ? n : p.value;
  });
  if (values.every((v, i) => v === params[i].value)) return app;
  const entries = params.flatMap((p, i) => (values[i] !== undefined && (p.given || values[i] !== p.value) ? [`${p.name}: ${scalar(values[i], true)}`] : []));
  return { path: app.path, text: withLine(app.text, `with: {${entries.join(", ")}}`) };
}

/** What an app will ask for when it's first opened, in one line, worded as the install preview words it. */
export function askLine(asks: readonly string[]): string {
  if (!asks.length) return "It asks for nothing: it only keeps its own data beside it.";
  return `When you open it, it will ask your OK to ${asks.map((a) => a.charAt(0).toLowerCase() + a.slice(1)).join("; ")}.`;
}
