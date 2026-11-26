/**
 * Sharing and installing apps, on any host the runtime runs in: what sharing an app takes along,
 * reading shared text or a link, what installing it would do, the gallery's choice, and the install
 * itself. The windows that show these, and opening what was installed, are the host's.
 */
import { fromBundle, fromFetched, previewInstall, sharedUrl, thenTargets, type BundleNote, type InstallPreview } from "./bundle.ts";
import type { Host } from "./datalayer.ts";
import { askLine, componentsNeeded, kitParams, planCopy, type GalleryApp, type GalleryNote, type KitParam, type Plan } from "./gallery.ts";
import { permissionsOf } from "./permissions.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { readComponentPreview, readSpec } from "./spec.ts";
import { basename, dataPathOf, isApp, isComponent, notePath, storeTarget } from "./store.ts";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The text of every note in the vault named like each of these, in any folder or case: links go by name. */
export async function existingNotes(rt: GizmoRuntime, names: string[]): Promise<Record<string, string[]>> {
  const host = rt.dataLayer.host;
  const files = host.markdownFiles();
  const existing: Record<string, string[]> = {};
  for (const name of names) {
    existing[name] = await Promise.all(files.filter((f) => f.basename.toLowerCase() === name.toLowerCase()).map((f) => host.readFile(f.path)));
  }
  return existing;
}

/**
 * The notes sharing an app takes along: the note itself, every component it reads at any depth,
 * and the template notes its panels make notes from. Never its data note or the notes it keeps.
 */
export async function notesToShare(rt: GizmoRuntime, path: string): Promise<{ notes: BundleNote[]; about: string; runs: string[] } | { error: string }> {
  const host = rt.dataLayer.host;
  const notes = rt.host.notes;
  const fm = host.frontmatter(path);
  const component = isComponent(fm);
  if (!fm || (!component && !isApp(fm))) return { error: "Only an app or a component can be shared" };
  const opts = { now: new Date(host.now()), notes, path };
  const spec = (component ? readComponentPreview(fm, opts).result : readSpec(fm, opts))?.spec;
  if (!spec) return { error: `${basename(path)} has a problem to fix before it can be shared` };
  const paths = new Set(Object.keys(spec.read));
  for (const { panel } of spec.panels) {
    const template = panel.template && notes.resolve(storeTarget(panel.template), path);
    if (template) paths.add(template);
  }
  paths.delete(path);
  const others = [...paths].filter((p) => host.fileInfo(p));
  const read = await Promise.all([path, ...others].map(async (p) => ({ name: basename(p), text: await host.readFile(p) })));
  const names = new Set(read.map((n) => n.name.toLowerCase()));
  const runs = thenTargets(spec.panels).filter((t) => !names.has(t.app.toLowerCase())).map((t) => `It runs “${t.do}” in ${t.app}, which isn't included; whoever installs it needs an app of that name with that shortcut.`);
  const about = component ? fm.component : fm.app;
  return { notes: read, about: typeof about === "string" || typeof about === "number" ? String(about) : "", runs };
}

/** Whether pasted text is a link, and the address it would fetch (undefined for a link that can't be installed). */
export function sharedLink(input: string): { link: boolean; url?: string } {
  const trimmed = input.trim();
  const link = /^\w+:\/\//.test(trimmed);
  return { link, url: link ? sharedUrl(trimmed) : undefined };
}

/**
 * What a link or pasted text holds, or why it can't be read, said ready to show. A link is fetched
 * only here, and `fetching` is told of it first.
 */
export async function readShared(
  input: string, fetch: Host["fetch"], parse: (yaml: string) => unknown, fetching?: (host: string) => void,
): Promise<{ notes: BundleNote[] } | { error: string }> {
  const trimmed = input.trim();
  const { link, url } = sharedLink(trimmed);
  if (link && !url) return { error: "Only https links can be installed" };
  let got: { notes: BundleNote[] } | { error: string };
  if (url) {
    fetching?.(new URL(url).hostname);
    try {
      const res = await fetch(url, {});
      if (res.status >= 400) return { error: `${new URL(url).hostname} answered ${res.status}` };
      got = fromFetched(res.text, url, parse);
      if ("error" in got && new URL(trimmed).hostname === "gist.github.com") got = { error: `${got.error}. For a gist of several files, use the raw link of the shared file` };
    } catch (e) {
      return { error: `Couldn't fetch it: ${(e as Error).message}` };
    }
  } else {
    got = fromBundle(trimmed);
  }
  return "error" in got ? { error: cap(got.error) } : got;
}

/** What installing shared notes would do here, judged against this vault's policy, and where they'd go. */
export async function previewShared(rt: GizmoRuntime, notes: BundleNote[]): Promise<{ preview: InstallPreview; folder: string } | { error: string }> {
  const existing = await existingNotes(rt, notes.map((n) => n.name));
  const folder = rt.host.newNotesFolder();
  const preview = previewInstall(notes, {
    folder,
    existing: (name) => existing[name] ?? [],
    notes: rt.host.notes,
    parse: (yaml) => rt.dataLayer.host.parseYaml(yaml),
    judge: (spec, path, reader) => {
      // The shared notes resolve as they will once installed: a store or a then target among them counts.
      const storePath = (store: string, from: string) => reader.resolve(storeTarget(store), from) ?? notePath(storeTarget(store));
      return rt.verdict(spec, permissionsOf(spec, path), { appPath: path, dataPath: dataPathOf(spec.store, path, storePath), hostPath: path }, undefined, reader, storePath);
    },
  });
  return "error" in preview ? { error: cap(preview.error) } : { preview, folder };
}

/** How shared notes install: planned again, since names may have been taken since the preview. */
export async function planShared(rt: GizmoRuntime, notes: BundleNote[]): Promise<Plan> {
  const existing = await existingNotes(rt, notes.map((n) => n.name));
  const asGallery = (n: BundleNote) => ({ path: `${n.name}.md`, text: n.text });
  return planCopy(asGallery(notes[0]), notes.slice(1).map(asGallery), existing);
}

/**
 * Creates a plan's notes where new notes go, the app last, and waits until the host has read them;
 * the app's path to open, or why it couldn't. A note that can't be made stops the rest.
 */
export async function installNotes(rt: GizmoRuntime, plan: Plan, label: string): Promise<{ opened: string } | { error: string }> {
  if ("refusal" in plan) return { error: plan.refusal };
  const folder = rt.host.newNotesFolder();
  const created: string[] = [];
  try {
    for (const note of plan.create) {
      const path = folder ? `${folder}/${basename(note.path)}.md` : `${basename(note.path)}.md`;
      if (!(await rt.host.writes.createText(path, note.text))) throw new Error("File already exists.");
      created.push(path);
    }
  } catch (e) {
    return { error: `Couldn't copy “${label}”: ${e instanceof Error ? e.message : String(e)}` };
  }
  await Promise.all(created.map((p) => rt.host.whenIndexed(p)));
  return { opened: created[created.length - 1] };
}

/**
 * Choosing a gallery app: one you already have (by name, in any folder or case) is yours to open;
 * otherwise the components it uses, and the params of the kit it is, for which you're asked first.
 */
export function galleryChoice(rt: GizmoRuntime, gallery: GalleryApp, all: GalleryNote[]): { yours: string } | { components: GalleryNote[]; params: KitParam[] } {
  const name = basename(gallery.note.path).toLowerCase();
  const yours = rt.dataLayer.host.markdownFiles().find((f) => f.basename.toLowerCase() === name);
  if (yours) return { yours: yours.path };
  const components = componentsNeeded(gallery.note, all);
  return { components, params: kitParams(gallery.note, components, (yaml) => rt.dataLayer.host.parseYaml(yaml)) };
}

/** A gallery app and the components it uses, planned as a copy into the vault as it is now. */
export async function planGallery(rt: GizmoRuntime, note: GalleryNote, components: GalleryNote[]): Promise<Plan> {
  const existing = await existingNotes(rt, [note, ...components].map((n) => basename(n.path)));
  return planCopy(note, components, existing);
}

/** What the app will ask for once copied, in one line, as installing it would say. */
export function asksOf(rt: GizmoRuntime, note: GalleryNote, components: GalleryNote[]): string {
  const shared = [note, ...components].map((n) => ({ name: basename(n.path), text: n.text }));
  const preview = previewInstall(shared, { folder: rt.host.newNotesFolder(), existing: () => [], notes: rt.host.notes, parse: (yaml) => rt.dataLayer.host.parseYaml(yaml) });
  return "error" in preview ? "" : askLine(preview.asks);
}
