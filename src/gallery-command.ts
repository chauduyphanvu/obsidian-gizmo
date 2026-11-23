import { FuzzySuggestModal, Modal, Notice, Setting, normalizePath, parseYaml, type App, type Plugin, type TFile } from "obsidian";
import { previewInstall } from "./bundle.ts";
import {
  askLine, componentsNeeded, galleryApps, kitParams, planCopy, setUp, type GalleryApp, type GalleryNote, type KitParam, type Plan,
} from "./gallery.ts";
import { vaultNotes } from "./host.ts";
import { basename } from "./store.ts";
import notes from "../scripts/gallery-notes.ts";

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

/** Where new notes go, as an install reads it: `""` for the vault's root. */
function newNotesFolder(app: App): string {
  const folder = app.fileManager.getNewFileParent("").path;
  return folder === "/" ? "" : folder;
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
    for (const note of plan.create) created.push(await app.vault.create(normalizePath(`${folder.path}/${basename(note.path)}.md`), note.text));
  } catch (e) {
    new Notice(`Couldn't copy “${label}”: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  await Promise.all(created.map((f) => indexed(app, f)));
  await app.workspace.getLeaf(false).openFile(created[created.length - 1]);
  return true;
}

/** Creates the app's note (as `note` has it) and the component notes it uses where new notes go, then opens the app. */
async function copyApp(app: App, gallery: GalleryApp, note: GalleryNote, components: GalleryNote[]): Promise<void> {
  const existing = await existingNotes(app, [note, ...components].map((n) => basename(n.path)));
  await installNotes(app, planCopy(note, components, existing), gallery.name);
}

/** What the app will ask for once copied, in one line, as installing it would say. */
function asksOf(app: App, note: GalleryNote, components: GalleryNote[]): string {
  const shared = [note, ...components].map((n) => ({ name: basename(n.path), text: n.text }));
  const preview = previewInstall(shared, { folder: newNotesFolder(app), existing: () => [], notes: vaultNotes(app), parse: parseYaml });
  return "error" in preview ? "" : askLine(preview.asks);
}

/**
 * Choosing a gallery app: one you already have is offered to open instead; one that is a kit with
 * params asks for your values first; any other is copied as it is.
 */
function chooseApp(app: App, gallery: GalleryApp): void {
  const name = basename(gallery.note.path).toLowerCase();
  const yours = app.vault.getMarkdownFiles().find((f) => f.basename.toLowerCase() === name);
  if (yours) return new HaveItModal(app, gallery.name, yours).open();
  const components = componentsNeeded(gallery.note, notes);
  const params = kitParams(gallery.note, components, parseYaml);
  if (!params.length) return void copyApp(app, gallery, gallery.note, components);
  new SetUpModal(app, gallery, params, asksOf(app, gallery.note, components), (note) => void copyApp(app, gallery, note, components)).open();
}

/** The app chosen is in the vault already: open yours, or leave it. */
class HaveItModal extends Modal {
  private name: string;
  private file: TFile;

  constructor(app: App, name: string, file: TFile) {
    super(app);
    this.name = name;
    this.file = file;
  }

  onOpen(): void {
    const el = this.contentEl.createDiv({ cls: "gizmo" });
    el.createEl("p", { text: `You already have “${this.name}”.` });
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    row.createEl("button", { cls: "mod-cta", text: "Open yours" }).addEventListener("click", () => {
      void this.app.workspace.getLeaf(false).openFile(this.file);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Asks for the values of the kit an app is before it's copied: one field for each param, filled in with the gallery's. */
class SetUpModal extends Modal {
  private gallery: GalleryApp;
  private params: KitParam[];
  private asks: string;
  private copy: (note: GalleryNote) => void;

  constructor(app: App, gallery: GalleryApp, params: KitParam[], asks: string, copy: (note: GalleryNote) => void) {
    super(app);
    this.gallery = gallery;
    this.params = params;
    this.asks = asks;
    this.copy = copy;
  }

  onOpen(): void {
    this.titleEl.setText(`Set up ${this.gallery.name}`);
    const el = this.contentEl.createDiv({ cls: "gizmo" });
    el.createEl("p", { text: "Give it your own values. You can change them later in its with: line." });
    if (this.asks) el.createEl("p", { cls: "gz-muted", text: this.asks });
    const typed: Record<string, string> = {};
    const done = () => {
      this.close();
      this.copy(setUp(this.gallery.note, this.params, typed));
    };
    const inputs: HTMLInputElement[] = [];
    for (const p of this.params) {
      new Setting(el).setName(p.name).addText((t) => {
        if (typeof p.value === "number") {
          t.inputEl.type = "number";
          t.inputEl.step = "any";
        }
        t.setValue(p.value === undefined ? "" : String(p.value));
        t.onChange((v) => { typed[p.name] = v; });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || e.isComposing) return;
          e.preventDefault();
          done();
        });
        inputs.push(t.inputEl);
      });
    }
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    row.createEl("button", { cls: "mod-cta", text: "Copy" }).addEventListener("click", done);
    inputs[0]?.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }
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
    chooseApp(this.app, item);
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
