import { FuzzySuggestModal, Notice, type App } from "obsidian";
import { NO_IMPORT_FILES, NO_IMPORT_WAYS, importFiles, importNow, importWays, type ImportWay } from "./import.ts";
import type GizmoPlugin from "./main.ts";

/** Picks one of `items`, each shown by `text`. */
class Picker<T> extends FuzzySuggestModal<T> {
  private items: T[];
  private text: (item: T) => string;
  private picked: (item: T) => void;

  constructor(app: App, items: T[], placeholder: string, text: (item: T) => string, picked: (item: T) => void) {
    super(app);
    this.items = items;
    this.text = text;
    this.picked = picked;
    this.setPlaceholder(placeholder);
  }

  getItems(): T[] {
    return this.items;
  }

  getItemText(item: T): string {
    return this.text(item);
  }

  onChooseItem(item: T): void {
    this.picked(item);
  }
}

async function run(plugin: GizmoPlugin, way: ImportWay, path: string): Promise<void> {
  new Notice((await importNow(plugin.runtime, way, path)).text, 10_000);
}

/** "Import rows into a kind…": a kind and one of its maps, then a file of the vault, read into the kind's rows. */
export function registerImportCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "import-rows",
    name: "Import rows into a kind…",
    callback: () => {
      const all = importWays(plugin.runtime);
      if (!all.length) return void new Notice(NO_IMPORT_WAYS, 10_000);
      const pickFile = (way: ImportWay) => {
        const paths = importFiles(plugin.app.vault.getFiles().map((f) => f.path), way);
        if (!paths.length) return void new Notice(NO_IMPORT_FILES);
        new Picker(plugin.app, paths, `A file to read into ${way.name} as ${way.map}`, (p) => p, (p) => void run(plugin, way, p)).open();
      };
      if (all.length === 1) return pickFile(all[0]);
      new Picker(plugin.app, all, "Which kind, and which of its imports?", (w) => `${w.name}: ${w.map}`, pickFile).open();
    },
  });
}
