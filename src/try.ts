/**
 * What a try runs on, on any host: the app's own note and the notes it uses, read from the vault or
 * from shared text, and what it would ask for. The try itself is a sandbox (see sandbox.ts).
 */
import { frontmatterOf, type BundleNote } from "./bundle.ts";
import { describePermission, permissionsOf } from "./permissions.ts";
import type { GizmoRuntime } from "./runtime.ts";
import type { SandboxNote } from "./sandbox.ts";
import { readSpec } from "./spec.ts";
import { basename } from "./store.ts";

/** An app to try: its name and note, every note it sees, and what it would ask for once allowed. */
export interface TryNotes {
  name: string;
  appPath: string;
  notes: Map<string, SandboxNote>;
  wanted: string[];
}

/** What a try leaves out, in words: what the app would read, use or send once allowed. */
export function leftOut(wanted: string[]): string[] {
  return wanted.flatMap((perm) => {
    const kind = perm.split(":")[0];
    if (kind === "read" && !/\.[A-Za-z0-9]+$/.test(perm)) return [`${describePermission(perm)}: none of them here`];
    if (kind === "kind") return [`${describePermission(perm)}: none of them here`];
    if (kind === "kind-write" || kind === "edit" || kind === "tasks" || kind === "secret" || kind === "send" || kind === "post" || kind === "share") return [describePermission(perm)];
    if (perm === "images") return ["Load pictures: their addresses are shown instead"];
    return [];
  });
}

/**
 * An app in the vault, to try before it's allowed: it sees its own note, the components it uses and
 * the templates it names, and nothing else. Undefined when the note is gone.
 */
export async function vaultTry(rt: GizmoRuntime, path: string): Promise<TryNotes | undefined> {
  const host = rt.dataLayer.host;
  if (!host.fileInfo(path)) return undefined;
  const noteOf = async (p: string): Promise<SandboxNote> => ({ frontmatter: host.frontmatter(p), text: await host.readFile(p) });
  const spec = readSpec(host.frontmatter(path), { path, notes: rt.host.notes, now: new Date(host.now()) })?.spec;
  const wanted = spec ? permissionsOf(spec, path) : [];
  const notes = new Map<string, SandboxNote>([[path, await noteOf(path)]]);
  const templates = wanted.filter((p) => p.startsWith("read:") && p.endsWith(".md")).map((p) => p.slice(5));
  for (const other of [...Object.keys(spec?.read ?? {}), ...templates]) {
    if (host.fileInfo(other) && !notes.has(other)) notes.set(other, await noteOf(other));
  }
  return { name: basename(path), appPath: path, notes, wanted };
}

/**
 * A shared app, to try before it's installed, on the shared notes alone, placed as the install would
 * place them. A link finds a shared note whose name ends as the link does.
 */
export function bundleTry(notes: BundleNote[], folder: string, parse: (yaml: string) => unknown): TryNotes {
  const pathOf = (name: string) => (folder ? `${folder}/${name}.md` : `${name}.md`);
  const all = new Map(notes.map((n): [string, SandboxNote] => [pathOf(n.name), { frontmatter: frontmatterOf(n.text, parse), text: n.text }]));
  const appPath = pathOf(notes[0].name);
  const reader = { resolve: (link: string) => [...all.keys()].find((p) => p.toLowerCase().endsWith(`${link.replace(/\.md$/i, "").toLowerCase()}.md`)), frontmatter: (p: string) => all.get(p)?.frontmatter };
  const spec = readSpec(all.get(appPath)?.frontmatter, { path: appPath, notes: reader, now: new Date() })?.spec;
  return { name: notes[0].name, appPath, notes: all, wanted: spec ? permissionsOf(spec, appPath) : [] };
}
