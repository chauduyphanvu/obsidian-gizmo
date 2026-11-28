import { FuzzySuggestModal, Modal, Notice, type App, type TFile } from "obsidian";
import type { KindPlan } from "./kind-convert.ts";
import { drawKindPlan, kindLists, kindTitle, offerList } from "./kind-pane.ts";
import type GizmoPlugin from "./main.ts";
import type { AppSpec } from "./spec.ts";
import { isApp } from "./store.ts";

/** Says what making the kind does before anything is written (see drawKindPlan). */
class KindModal extends Modal {
  private appName: string;
  private plan: KindPlan;
  private rows: number;
  private make: () => Promise<string | undefined>;

  constructor(app: App, appName: string, plan: KindPlan, rows: number, make: () => Promise<string | undefined>) {
    super(app);
    this.appName = appName;
    this.plan = plan;
    this.rows = rows;
    this.make = make;
  }

  onOpen(): void {
    this.titleEl.setText(kindTitle(this.plan));
    drawKindPlan(this.contentEl, this.appName, this.plan, this.rows, { make: () => this.make(), close: () => this.close() });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Picks which of an app's lists to make a kind of, when it saves into more than one. */
class ListPicker extends FuzzySuggestModal<string> {
  private lists: string[];
  private picked: (list: string) => void;

  constructor(app: App, lists: string[], picked: (list: string) => void) {
    super(app);
    this.lists = lists;
    this.picked = picked;
    this.setPlaceholder("Which list becomes a kind?");
  }

  getItems(): string[] {
    return this.lists;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.picked(item);
  }
}

async function offer(plugin: GizmoPlugin, file: TFile, fm: Record<string, unknown>, spec: AppSpec, list: string): Promise<void> {
  const offered = await offerList(plugin.runtime, file.path, fm, spec, list);
  if ("error" in offered) return void new Notice(offered.error, 12_000);
  new KindModal(plugin.app, file.basename, offered.plan, offered.rows, async () => {
    const made = await offered.make();
    if (!made.ok) return made.said;
    new Notice(made.said);
    return undefined;
  }).open();
}

/** "Make a list a kind": an app's own saved list becomes rows every app can read, with the rows it has. */
export function registerKindCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "make-kind",
    name: "Make a list a kind",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      const fm = file ? plugin.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
      if (!file || !fm || !isApp(fm)) return false;
      if (checking) return true;
      const found = kindLists(plugin.runtime, file.path, fm);
      if ("error" in found) return void new Notice(found.error);
      const { spec, lists } = found;
      if (lists.length === 1) void offer(plugin, file, fm, spec, lists[0]);
      else new ListPicker(plugin.app, lists, (list) => void offer(plugin, file, fm, spec, list)).open();
      return true;
    },
  });
}
