import { Modal, type App, type TFolder } from "obsidian";
import { drawExamples, type ExampleActs, type ExamplePlan } from "./examples-view.ts";
import { makeFromLines } from "./examples-make.ts";
import type GizmoPlugin from "./main.ts";
import { isKind } from "./store.ts";
import { VIEW_TYPE } from "./view.ts";

class ExamplesModal extends Modal {
  private acts: Omit<ExampleActs, "cancel">;

  constructor(app: App, acts: Omit<ExampleActs, "cancel">) {
    super(app);
    this.acts = acts;
  }

  onOpen(): void {
    this.titleEl.setText("New app from lines");
    this.modalEl.addClass("gz-examples-modal");
    const make = async (plan: ExamplePlan) => {
      const failed = await this.acts.make(plan);
      if (failed === undefined) this.close();
      return failed;
    };
    drawExamples(this.contentEl.createDiv({ cls: "gizmo" }), { ...this.acts, make, cancel: () => this.close() });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Makes what the window showed (see makeFromLines), then opens the app. */
async function make(plugin: GizmoPlugin, folder: TFolder, plan: ExamplePlan): Promise<string | undefined> {
  const made = await makeFromLines(plugin.runtime, folder.isRoot() ? "" : folder.path, plan);
  if ("error" in made) return made.error;
  await plugin.app.workspace.getLeaf("tab").setViewState({ type: VIEW_TYPE, state: { file: made.path }, active: true });
  return undefined;
}

/** "New app from lines…": lines a person already has become a kind, its rows and an app, shown as keys before anything is made. */
export function registerExamples(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "new-app-from-lines",
    name: "New app from lines…",
    callback: () => {
      const folder = plugin.app.fileManager.getNewFileParent(plugin.app.workspace.getActiveFile()?.path ?? "");
      new ExamplesModal(plugin.app, {
        now: () => new Date(),
        taken: (note) => folder.children.some((c) => c.name === `${note}.md`),
        used: (name) => {
          const word = name.toLowerCase();
          const index = plugin.runtime.background.captureIndex();
          if (index?.names.has(word) || index?.clashes.has(word)) return true;
          return plugin.app.vault.getMarkdownFiles().some((f) => {
            const fm = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
            return fm !== undefined && isKind(fm) && String(fm.kind).toLowerCase() === word;
          });
        },
        make: (plan) => make(plugin, folder, plan),
      }).open();
    },
  });
}
