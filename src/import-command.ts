import { FuzzySuggestModal, Notice, type App } from "obsidian";
import { importable, importedText } from "./import.ts";
import type GizmoPlugin from "./main.ts";
import { basename } from "./store.ts";

/** One way to import: a kind and one of its maps, and the folder that map names, if any. */
interface Way {
  kind: string;
  name: string;
  map: string;
  folder?: string;
}

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

/** Every kind's maps under `import:`, as the background reads them. */
function ways(plugin: GizmoPlugin): Way[] {
  return plugin.runtime.background.list().flatMap(({ path, name }) => (plugin.runtime.background.spec(path)?.kind?.imports ?? [])
    .map((m) => ({ kind: path, name, map: m.name, ...(m.folder !== undefined && { folder: m.folder }) })));
}

/** The files a map can read, those in its folder first. */
function files(plugin: GizmoPlugin, way: Way): string[] {
  const all = plugin.app.vault.getFiles().map((f) => f.path).filter(importable);
  const inFolder = (p: string) => way.folder !== undefined && p.startsWith(`${way.folder}/`);
  return [...all.filter(inFolder).sort(), ...all.filter((p) => !inFolder(p)).sort()];
}

async function run(plugin: GizmoPlugin, way: Way, path: string): Promise<void> {
  const r = await plugin.runtime.background.importFile(way.kind, way.map, path, "you");
  if (!r) return void new Notice("Gizmo's background service isn't running yet; try again in a moment");
  new Notice("error" in r ? `Couldn't import ${basename(path)}: ${r.error}` : importedText(r, way.name, basename(path)), 10_000);
}

/** "Import rows into a kind…": a kind and one of its maps, then a file of the vault, read into the kind's rows. */
export function registerImportCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "import-rows",
    name: "Import rows into a kind…",
    callback: () => {
      const all = ways(plugin);
      if (!all.length) return void new Notice("No kind has a way to import yet: give a kind note an import: map, e.g. import: {bank: {at: Date, amount: Amount}}", 10_000);
      const pickFile = (way: Way) => {
        const paths = files(plugin, way);
        if (!paths.length) return void new Notice("No .csv, .json or .ics file in this vault to import");
        new Picker(plugin.app, paths, `A file to read into ${way.name} as ${way.map}`, (p) => p, (p) => void run(plugin, way, p)).open();
      };
      if (all.length === 1) return pickFile(all[0]);
      new Picker(plugin.app, all, "Which kind, and which of its imports?", (w) => `${w.name}: ${w.map}`, pickFile).open();
    },
  });
}
