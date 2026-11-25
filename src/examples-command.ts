import { Modal, type App, type TFolder } from "obsidian";
import { drawExamples, type ExampleActs, type ExamplePlan } from "./examples-view.ts";
import { carriedOps } from "./kind-convert.ts";
import type GizmoPlugin from "./main.ts";
import { defaultDataPath, isKind } from "./store.ts";
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

/**
 * Makes what the window showed: the kind note, its rows as events written now (each row keeps the
 * day its line gave), then the app note, which opens. The kind and its rows come first, so a
 * failure after them loses nothing.
 */
async function make(plugin: GizmoPlugin, folder: TFolder, plan: ExamplePlan): Promise<string | undefined> {
  const { app } = plugin;
  const at = (note: string) => (folder.isRoot() ? `${note}.md` : `${folder.path}/${note}.md`);
  try {
    const kindPath = at(plan.kindNote);
    await app.vault.create(kindPath, plan.kindText);
    const ledger = plugin.runtime.dataLayer.ledger;
    if (ledger) {
      const data = defaultDataPath(kindPath);
      plugin.runtime.dataLayer.noteApp(data, kindPath);
      await ledger.write(data, carriedOps(plan.kind, plan.rows, () => ledger.newRowId()));
      await plugin.runtime.dataLayer.snapshotNow(data, false).catch(() => undefined);
    }
    const file = await app.vault.create(at(plan.appNote), plan.appText);
    await app.workspace.getLeaf("tab").setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
    return undefined;
  } catch (e) {
    return `Couldn't make the notes: ${(e as Error).message}`;
  }
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
