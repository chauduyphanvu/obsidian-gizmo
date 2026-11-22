import { Modal, Platform, Setting, type App, type TFile, type TFolder } from "obsidian";
import type GizmoPlugin from "./main.ts";
import { afterAppLine, nameProblem, newAppProblem, newAppText } from "./new-app.ts";
import { VIEW_TYPE } from "./view.ts";

/** Asks for the new app's name and what it is for, and says inline why it can't be made yet. */
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
    const el = this.contentEl.createDiv({ cls: "gizmo" });
    let name = "";
    let purpose = "";
    let tried = false;
    const where = this.folder.isRoot() ? "at the top of the vault" : `in ${this.folder.path}`;
    const enter = (input: HTMLInputElement) => input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      void submit();
    });
    new Setting(el).setName("Name").setDesc(`The note's name; it goes ${where}.`).addText((t) => {
      t.setPlaceholder("Water").onChange((v) => { name = v; check(); });
      enter(t.inputEl);
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(el).setName("What is it for?").setDesc("One sentence. It becomes the app line.").addText((t) => {
      t.setPlaceholder("Count the glasses of water I drink each day").onChange((v) => { purpose = v; check(); });
      enter(t.inputEl);
    });
    const said = el.createDiv({ cls: "gz-new-app-problem" });
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const createButton = row.createEl("button", { cls: "mod-cta", text: "Create" });
    createButton.addEventListener("click", () => void submit());

    const taken = () => this.folder.children.map((c) => c.name);
    // What's wrong with a name is said as it is typed; a field left empty only once Create is tried.
    const check = () => {
      const problem = newAppProblem(name, purpose, taken());
      said.setText((tried ? problem : name.trim() ? nameProblem(name, taken()) : undefined) ?? "");
      return problem;
    };
    const submit = async () => {
      tried = true;
      if (check() || createButton.disabled) return;
      createButton.disabled = true;
      const failed = await this.create(name.trim(), purpose.trim());
      if (!failed) return this.close();
      said.setText(failed);
      createButton.disabled = false;
    };
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
  const text = newAppText(purpose);
  try {
    const file = await plugin.app.vault.create(folder.isRoot() ? `${name}.md` : `${folder.path}/${name}.md`, text);
    void openNewApp(plugin, file, text);
    return undefined;
  } catch (e) {
    return `Couldn't make the note: ${(e as Error).message}`;
  }
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
