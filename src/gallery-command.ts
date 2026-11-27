import { FuzzySuggestModal, Modal, Notice, normalizePath, type App, type TFile } from "obsidian";
import { galleryApps, type GalleryApp, type GalleryNote, type KitParam, type Plan } from "./gallery.ts";
import { drawHaveIt, drawSetUp, setUpTitle } from "./gallery-pane.ts";
import { asksOf, galleryChoice, installNotes, planGallery } from "./install.ts";
import type GizmoPlugin from "./main.ts";
import notes from "../scripts/gallery-notes.ts";

/** Installs a plan, then opens the app it made; says why when it can't. */
export async function installAndOpen(plugin: GizmoPlugin, plan: Plan, label: string): Promise<boolean> {
  const made = await installNotes(plugin.runtime, plan, label);
  if ("error" in made) {
    new Notice(made.error);
    return false;
  }
  const file = plugin.app.vault.getFileByPath(normalizePath(made.opened));
  if (file) await plugin.app.workspace.getLeaf(false).openFile(file);
  return true;
}

/** Creates the app's note (as `note` has it) and the component notes it uses where new notes go, then opens the app. */
async function copyApp(plugin: GizmoPlugin, gallery: GalleryApp, note: GalleryNote, components: GalleryNote[]): Promise<void> {
  await installAndOpen(plugin, await planGallery(plugin.runtime, note, components), gallery.name);
}

/**
 * Choosing a gallery app: one you already have is offered to open instead; one that is a kit with
 * params asks for your values first; any other is copied as it is.
 */
function chooseApp(plugin: GizmoPlugin, gallery: GalleryApp): void {
  const app = plugin.app;
  const choice = galleryChoice(plugin.runtime, gallery, notes);
  if ("yours" in choice) {
    const file = app.vault.getFileByPath(choice.yours);
    if (file) new HaveItModal(app, gallery.name, file).open();
    return;
  }
  const { components, params } = choice;
  if (!params.length) return void copyApp(plugin, gallery, gallery.note, components);
  new SetUpModal(app, gallery, params, asksOf(plugin.runtime, gallery.note, components), (note) => void copyApp(plugin, gallery, note, components)).open();
}

/** The app chosen is in the vault already (see drawHaveIt). */
class HaveItModal extends Modal {
  private name: string;
  private file: TFile;

  constructor(app: App, name: string, file: TFile) {
    super(app);
    this.name = name;
    this.file = file;
  }

  onOpen(): void {
    drawHaveIt(this.contentEl, this.name, { open: () => void this.app.workspace.getLeaf(false).openFile(this.file), close: () => this.close() });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Asks for the values of the kit an app is before it's copied (see drawSetUp). */
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
    this.titleEl.setText(setUpTitle(this.gallery));
    drawSetUp(this.contentEl, this.gallery, this.params, this.asks, { copy: this.copy, close: () => this.close() });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** The gallery's apps, each with the line saying what it is for. */
class GalleryPicker extends FuzzySuggestModal<GalleryApp> {
  private plugin: GizmoPlugin;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
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
    chooseApp(this.plugin, item);
  }
}

/** "New app from the gallery": copies a ready-made app, and the components it uses, into the vault. */
export function registerGalleryCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "new-app-from-gallery",
    name: "New app from the gallery",
    callback: () => new GalleryPicker(plugin).open(),
  });
}
