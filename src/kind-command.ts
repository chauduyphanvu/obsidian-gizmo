import { FuzzySuggestModal, Modal, Notice, type App, type TFile } from "obsidian";
import { vaultNotes } from "./host.ts";
import { convertible, type KindPlan } from "./kind-convert.ts";
import { offerKind } from "./kind-make.ts";
import type GizmoPlugin from "./main.ts";
import { readSpec, type AppSpec } from "./spec.ts";
import { basename, isApp } from "./store.ts";

/** Says what making the kind does, line by line, before anything is written. */
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
    const { plan, appName } = this;
    const kind = basename(plan.path);
    this.titleEl.setText(`Make ${plan.list} a kind`);
    const el = this.contentEl.createDiv({ cls: "gizmo gz-kind-plan" });
    el.createEl("p", { text: `Any app can then read these rows with source: "[[${kind}]]" and add to them with save: "[[${kind}]]".` });
    const list = el.createEl("ul");
    list.createEl("li", { text: `Makes the note ${plan.path}, with the fields ${appName} gives ${plan.list}.` });
    list.createEl("li", { text: this.rows === 1 ? "Carries its 1 row over." : `Carries its ${this.rows} rows over.` });
    const lines = list.createEl("li", { text: `Changes ${plan.changed.length === 1 ? "this line" : "these lines"} of ${appName}:` });
    for (const c of plan.changed) lines.createEl("pre", { text: `${c.from.trim()}  →  ${c.to.trim()}` });
    list.createEl("li", { text: `${appName} then asks once for your OK to read and change the rows of ${kind}.` });
    el.createEl("p", {
      cls: "gz-muted",
      text: `${appName}'s own copy of the rows stays in ${appName} data, where nothing reads it any more. To go back, put the ${plan.changed.length === 1 ? "line" : "lines"} back and delete ${kind}.`,
    });
    const said = el.createDiv({ cls: "gz-new-app-problem" });
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const go = row.createEl("button", { cls: "mod-cta", text: "Make the kind" });
    go.addEventListener("click", () => {
      go.disabled = true;
      void this.make().then((failed) => {
        if (!failed) return this.close();
        said.setText(failed);
        go.disabled = false;
      });
    });
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
  const offered = await offerKind(plugin.runtime, file.path, await plugin.app.vault.read(file), fm, spec, list);
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
      const spec = readSpec(fm, { notes: vaultNotes(plugin.app), path: file.path })?.spec;
      if (!spec) return void new Notice(`${file.basename} has a problem to fix before one of its lists can become a kind`);
      const lists = convertible(spec);
      if (!lists.length) return void new Notice(`${file.basename} saves no rows of its own to make a kind of`);
      if (lists.length === 1) void offer(plugin, file, fm, spec, lists[0]);
      else new ListPicker(plugin.app, lists, (list) => void offer(plugin, file, fm, spec, list)).open();
      return true;
    },
  });
}
