import { textOf } from "./text.ts";
import { hasControl, maskControl } from "./control.ts";
import { violationText, type Verdict } from "./flows.ts";
import type { NoteReader } from "./expand.ts";
import { planCopy, type Plan } from "./gallery.ts";
import { isApp, isKind, isComponent, storeTarget } from "./store.ts";
import { readComponentPreview, readSpec, type AppSpec } from "./spec.ts";
import { describePermission, permissionsOf } from "./permissions.ts";

/**
 * A shared app: the app (or component) note first, then the notes it needs, each with the name it
 * is installed under and its text exactly as written. As text it is Markdown a person can read:
 * a heading, the app's description, how to install it, then each note in a fence of its own.
 */
export interface BundleNote {
  name: string;
  text: string;
}

const FENCE_INFO = "gizmo-note";
/** Shared text larger than this isn't an app. */
export const MAX_BUNDLE_BYTES = 1_000_000;

/** Why a name can't be a note's name, so a bundle can't write outside the folder it installs into. */
export function nameProblem(name: string): string | undefined {
  if (!name.trim()) return "a note in it has no name";
  if (name !== name.trim() || name.startsWith(".") || /[\\/:*?"<>|#^[\]]/.test(name) || hasControl(name)) {
    return `“${maskControl(name, "?")}” can't be a note's name`;
  }
  return undefined;
}

function duplicate(notes: BundleNote[]): string | undefined {
  const seen = new Set<string>();
  for (const { name } of notes) {
    const key = name.toLowerCase();
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return undefined;
}

/** The note's text in a fence longer than any run of backticks in it, so nothing inside closes it. */
function fenced(note: BundleNote): string {
  const longest = Math.max(0, ...[...note.text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(4, longest + 1));
  const text = note.text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return `${fence}${FENCE_INFO} ${note.name}\n${text}\n${fence}`;
}

/** The shared text for these notes, the first being what is shared; refuses a name that can't travel. */
export function toBundle(notes: BundleNote[], about: string): { text: string } | { error: string } {
  if (!notes.length) return { error: "nothing to share" };
  for (const n of notes) {
    const problem = nameProblem(n.name);
    if (problem) return { error: problem };
  }
  const twice = duplicate(notes);
  if (twice) return { error: `two of the notes it uses are called “${twice}”; rename one to share it` };
  const [first, ...rest] = notes;
  const what = rest.length ? `${first.name} and the ${rest.length === 1 ? "note" : `${rest.length} notes`} it uses (${rest.map((n) => n.name).join(", ")})` : first.name;
  const head = [
    `# ${first.name}`,
    ...(about ? ["", about] : []),
    "",
    `A Gizmo app for Obsidian: ${what}. To install it, run “Gizmo: Install an app from a link or text” and give it this text, or a link to it.`,
  ].join("\n");
  return { text: `${head}\n\n${notes.map(fenced).join("\n\n")}\n` };
}

/** The notes of a shared text, in order; refuses text that holds none, an unclosed one or a name that can't be. */
export function fromBundle(text: string): { notes: BundleNote[] } | { error: string } {
  const lines = text.split(/\r?\n/);
  const notes: BundleNote[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{4,})gizmo-note (.*)$/.exec(lines[i].trimEnd());
    if (!open) continue;
    const [, fence, name] = open;
    const end = lines.findIndex((l, j) => j > i && l.trimEnd() === fence);
    if (end < 0) return { error: `the note “${name}” isn't closed; the text was cut short` };
    notes.push({ name, text: `${lines.slice(i + 1, end).join("\n")}\n` });
    i = end;
  }
  if (!notes.length) return { error: "this isn't a shared Gizmo app; share one with “Share this app”" };
  for (const n of notes) {
    const problem = nameProblem(n.name);
    if (problem) return { error: problem };
  }
  const twice = duplicate(notes);
  if (twice) return { error: `it holds two notes called “${twice}”` };
  return { notes };
}

/** A note's frontmatter, parsed; undefined when it has none or it isn't YAML. */
export function frontmatterOf(text: string, parse: (yaml: string) => unknown): Record<string, unknown> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return undefined;
  try {
    const fm = parse(m[1]);
    return fm && typeof fm === "object" && !Array.isArray(fm) ? fm as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The vault as an install sees it: the notes it already has by name, and how links resolve in it. */
export interface InstallTarget {
  /** Where new notes go (`""` for the vault's root). */
  folder: string;
  /** The text of every note already in the vault under each of these names, in any folder or case. */
  existing(name: string): string[];
  notes: NoteReader;
  parse: (yaml: string) => unknown;
  /** What the applied data policy says of the app at `path`, its links read as `notes` reads them; undefined with no policy. */
  judge?(spec: AppSpec, path: string, notes: NoteReader): Verdict | undefined;
}

/** What installing shared notes would do, for a person to read before saying yes. */
export interface InstallPreview {
  name: string;
  about: string;
  kind: "app" | "component" | "lens";
  plan: Plan;
  /** The app's own check, as it would show when opened. */
  errors: string[];
  /** What it will ask to allow when it's first opened, in words. */
  asks: string[];
  /** Notes in it that do something on their own: other apps, and lenses that show on notes. */
  extras: string[];
  /** Checked against the data policy: the flows that would block it, and what the policy grants it without asking. */
  policy?: { violations: string[]; covered: string[] };
}

/**
 * Reads shared notes as they would be once installed into `target.folder`: links between them
 * resolve the way Obsidian resolves them there, falling back to the vault's own notes.
 */
export function previewInstall(notes: BundleNote[], target: InstallTarget): InstallPreview | { error: string } {
  const pathOf = (name: string) => (target.folder ? `${target.folder}/${name}.md` : `${name}.md`);
  const fms = new Map<string, Record<string, unknown> | undefined>(notes.map((n) => [pathOf(n.name), frontmatterOf(n.text, target.parse)]));
  const [first] = notes;
  const self = pathOf(first.name);
  const fm = fms.get(self);
  if (!fm || (fm.app === undefined && !isComponent(fm))) return { error: `“${first.name}” isn't a Gizmo app or component` };
  const reader: NoteReader = {
    resolve: (link, from) => {
      const target_ = link.replace(/\.md$/i, "");
      const own = [...fms.keys()].find((p) => p.toLowerCase() === `${target_}.md`.toLowerCase() || p.toLowerCase().endsWith(`/${target_}.md`.toLowerCase()));
      return own ?? target.notes.resolve(link, from);
    },
    frontmatter: (path) => (fms.has(path) ? fms.get(path) : target.notes.frontmatter(path)),
  };
  const component = fm.app === undefined;
  const preview = component ? readComponentPreview(fm, { path: self, notes: reader }) : undefined;
  const result = preview?.result ?? readSpec(fm, { path: self, notes: reader }) ?? { errors: [], empty: true };
  const verdict = result.spec && !component ? target.judge?.(result.spec, self, reader) : undefined;
  const asks = result.spec ? (verdict?.asked ?? permissionsOf(result.spec, self)).map(describePermission) : [];
  const extras = notes.slice(1).flatMap((n) => {
    const other = fms.get(pathOf(n.name));
    if (isApp(other)) return [`${n.name} is an app of its own`];
    if (isKind(other)) return [`${n.name} is a kind: its rows start empty, and any app here can read and add to them`];
    if (other && isComponent(other) && other.for !== undefined && other.for !== null) return [`${n.name} shows on every note in ${textOf(other.for)}`];
    return [];
  });
  for (const t of thenTargets(result.spec?.panels ?? [])) {
    if (!reader.resolve(t.app, self)) extras.push(`It runs “${t.do}” in ${t.app}, which you don't have`);
  }
  const existing: Record<string, string[]> = Object.fromEntries(notes.map((n) => [n.name, target.existing(n.name)]));
  const asGallery = (n: BundleNote) => ({ path: `${n.name}.md`, text: n.text });
  return {
    name: first.name,
    about: textOf((component ? fm.component : fm.app) ?? ""),
    kind: preview?.lens ? "lens" : component ? "component" : "app",
    plan: planCopy(asGallery(first), notes.slice(1).map(asGallery), existing),
    errors: result.errors,
    asks,
    extras,
    ...(verdict && { policy: { violations: verdict.violations.map(violationText), covered: verdict.covered.map(describePermission) } }),
  };
}

/** The other apps' shortcuts an app's panels run with `then`, each once, by the name typed. */
export function thenTargets(panels: { panel: { then?: { app: string; do: string } } }[]): { app: string; do: string }[] {
  const seen = new Map<string, { app: string; do: string }>();
  for (const { panel } of panels) {
    if (!panel.then) continue;
    const app = storeTarget(panel.then.app);
    seen.set(`${app}#${panel.then.do}`, { app, do: panel.then.do });
  }
  return [...seen.values()];
}

/** A web address for shared text: a gist's page becomes its raw text. Undefined when it isn't https. */
export function sharedUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const gist = /^\/([^/]+)\/([0-9a-f]+)\/?$/i.exec(url.pathname);
  if (url.hostname === "gist.github.com" && gist) return `https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw`;
  return url.toString();
}

/**
 * Text fetched from a link as shared notes: a shared app, or a single app or component note,
 * named after the link's file.
 */
export function fromFetched(text: string, url: string, parse: (yaml: string) => unknown): { notes: BundleNote[] } | { error: string } {
  if (text.length > MAX_BUNDLE_BYTES) return { error: "that link's text is too large to be an app" };
  const bundle = fromBundle(text);
  if ("notes" in bundle) return bundle;
  const fm = frontmatterOf(text, parse);
  if (!fm || (fm.app === undefined && !isComponent(fm))) return bundle;
  const file = new URL(url).pathname.split("/").pop() ?? "";
  let name: string;
  try {
    name = decodeURIComponent(file).replace(/\.md$/i, "");
  } catch {
    return { error: "that link's file name can't be read" };
  }
  const problem = nameProblem(name);
  return problem ? { error: problem } : { notes: [{ name, text }] };
}
