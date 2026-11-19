import { FuzzySuggestModal, Notice, normalizePath, type App, type Plugin, type TFile } from "obsidian";
import { componentsNeeded, galleryApps, noteName, planCopy, type GalleryApp, type Plan } from "./gallery.ts";
import notes from "./gallery-notes.ts";

/** Resolves once Obsidian has read the note's properties, which is when it can open as an app. */
function indexed(app: App, file: TFile): Promise<void> {
  return new Promise((resolve) => {
    if (app.metadataCache.getFileCache(file)) return resolve();
    const done = () => {
      app.metadataCache.offref(ref);
      window.clearTimeout(timer);
      resolve();
    };
    const ref = app.metadataCache.on("changed", (changed) => { if (changed === file) done(); });
    const timer = window.setTimeout(done, 3000);
  });
}

/** The text of every note in the vault named like each of these, in any folder or case: links go by name. */
export async function existingNotes(app: App, names: string[]): Promise<Record<string, string[]>> {
  const files = app.vault.getMarkdownFiles();
  const existing: Record<string, string[]> = {};
  for (const name of names) {
    existing[name] = await Promise.all(files.filter((f) => f.basename.toLowerCase() === name.toLowerCase()).map((f) => app.vault.read(f)));
  }
  return existing;
}

/** Creates a plan's notes where new notes go, the app last, then opens it; says why when it can't. */
export async function installNotes(app: App, plan: Plan, label: string): Promise<boolean> {
  if ("refusal" in plan) {
    new Notice(plan.refusal);
    return false;
  }
  const folder = app.fileManager.getNewFileParent("");
  const created: TFile[] = [];
  try {
    for (const note of plan.create) created.push(await app.vault.create(normalizePath(`${folder.path}/${noteName(note.path)}.md`), note.text));
  } catch (e) {
    new Notice(`Couldn't copy “${label}”: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  await Promise.all(created.map((f) => indexed(app, f)));
  await app.workspace.getLeaf(false).openFile(created[created.length - 1]);
  return true;
}

/** Creates the app's note and the component notes it uses where new notes go, then opens the app. */
async function copyApp(app: App, gallery: GalleryApp): Promise<void> {
  const components = componentsNeeded(gallery.note, notes);
  const existing = await existingNotes(app, [gallery.note, ...components].map((n) => noteName(n.path)));
  await installNotes(app, planCopy(gallery.note, components, existing), gallery.name);
}

/** The gallery's apps, each with the line saying what it is for. */
class GalleryPicker extends FuzzySuggestModal<GalleryApp> {
  constructor(app: App) {
    super(app);
    this.setPlaceholder("New app from the gallery");
  }

  getItems(): GalleryApp[] {
    return galleryApps(notes);
  }

  getItemText(item: GalleryApp): string {
    return `${item.name} ${item.about}`;
  }

  renderSuggestion(match: { item: GalleryApp }, el: HTMLElement): void {
    el.createDiv({ cls: "gz-suggest-key", text: match.item.name });
    el.createDiv({ cls: "gz-suggest-hint", text: match.item.about });
  }

  onChooseItem(item: GalleryApp): void {
    void copyApp(this.app, item);
  }
}

/** "New app from the gallery": copies a ready-made app, and the components it uses, into the vault. */
export function registerGalleryCommand(plugin: Plugin): void {
  plugin.addCommand({
    id: "new-app-from-gallery",
    name: "New app from the gallery",
    callback: () => new GalleryPicker(plugin.app).open(),
  });
}
