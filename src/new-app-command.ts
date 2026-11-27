import { Modal, Platform, type App, type TFile, type TFolder } from "obsidian";
import type GizmoPlugin from "./main.ts";
import { afterAppLine } from "./new-app.ts";
import { drawNewApp, makeApp } from "./new-app-pane.ts";
import { VIEW_TYPE } from "./view.ts";

/** Asks for the new app's name and what it is for (see drawNewApp). */
class NewAppModal extends Modal {
  private folder: TFolder;
  private create: (name: string, purpose: string) => Promise<string | undefined>;

  constructor(app: App, folder: TFolder, create: (name: string, purpose: string) => Promise<string | undefined>) {
    super(app);
    this.folder = folder;
    this.create = create;
  }

  onOpen(): void {
    this.titleEl.setText("New app");
    const folder = this.folder;
    drawNewApp(this.contentEl, {
      where: folder.isRoot() ? "at the top of the vault" : `in ${folder.path}`,
      taken: () => folder.children.map((c) => c.name),
      create: this.create,
      close: () => this.close(),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Waits, a second at most, for Obsidian to read a new note's properties, so it opens as the app it is. */
function readProperties(plugin: GizmoPlugin, file: TFile): Promise<void> {
  if (plugin.isApp(file)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      plugin.app.metadataCache.offref(ref);
      window.clearTimeout(timer);
      resolve();
    };
    const ref = plugin.app.metadataCache.on("changed", (f) => { if (f === file) done(); });
    const timer = window.setTimeout(done, 1000);
  });
}

/** Opens a new app note as an app in a new tab; on a screen with room, its source beside it, the cursor at the end of the app line. */
async function openNewApp(plugin: GizmoPlugin, file: TFile, text: string): Promise<void> {
  await readProperties(plugin, file);
  const leaf = plugin.app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
  if (Platform.isPhone) return;
  const at = afterAppLine(text);
  await plugin.showSourceAt(leaf, file, at.line, at.ch);
}

/** Makes the app note in `folder`, then opens it; says why when it can't be made. */
export async function createApp(plugin: GizmoPlugin, folder: TFolder, name: string, purpose: string): Promise<string | undefined> {
  const made = await makeApp(plugin.runtime, folder.isRoot() ? "" : folder.path, name, purpose);
  if ("error" in made) return made.error;
  const file = plugin.app.vault.getFileByPath(made.path);
  if (file) void openNewApp(plugin, file, made.text);
  return undefined;
}

/** "New app": a note with only its app line, opened as the app, ready for panels. */
export function registerNewApp(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "new-app",
    name: "New app",
    callback: () => {
      const folder = plugin.app.fileManager.getNewFileParent(plugin.app.workspace.getActiveFile()?.path ?? "");
      new NewAppModal(plugin.app, folder, (name, purpose) => createApp(plugin, folder, name, purpose)).open();
    },
  });
}
