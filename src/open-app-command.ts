import { FuzzySuggestModal, Keymap, Modal, Notice, Platform, Setting, type App, type Editor, type FuzzyMatch } from "obsidian";
import type GizmoPlugin from "./main.ts";
import { blockAt, embedBlock, embedChoices, embedPanels, orderApps, type AppItem, type EmbedChoice } from "./open-app.ts";

/** Every app in the vault, those used lately first (see orderApps). */
async function appItems(plugin: GizmoPlugin): Promise<AppItem[]> {
  const apps = plugin.runtime.background.list().map(({ name, description, path }) => ({ name, description, path }));
  const lastActive = new Map<string, number>();
  for (const e of await plugin.runtime.activity.list().catch(() => [])) if (!lastActive.has(e.app)) lastActive.set(e.app, e.at);
  return orderApps(apps, plugin.app.workspace.getLastOpenFiles(), lastActive);
}

/** The apps of the vault by name, each with its `app:` sentence; with `aside`, Mod+Enter picks one for the sidebar. */
class AppPicker extends FuzzySuggestModal<AppItem> {
  private items: AppItem[];
  private choose: (item: AppItem, aside: boolean) => void;

  constructor(app: App, items: AppItem[], placeholder: string, aside: boolean, choose: (item: AppItem, aside: boolean) => void) {
    super(app);
    this.items = items;
    this.choose = choose;
    this.setPlaceholder(placeholder);
    this.emptyStateText = "No apps in this vault yet";
    if (!aside) return;
    this.setInstructions([
      { command: "↵", purpose: "to open" },
      { command: `${Platform.isMacOS ? "⌘" : "ctrl"} ↵`, purpose: "to open in the right sidebar" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    this.scope.register(["Mod"], "Enter", (evt) => {
      this.selectActiveSuggestion(evt);
      return false;
    });
  }

  getItems(): AppItem[] {
    return this.items;
  }

  getItemText(item: AppItem): string {
    return `${item.name} ${item.description}`;
  }

  renderSuggestion(match: FuzzyMatch<AppItem>, el: HTMLElement): void {
    el.createDiv({ cls: "gz-suggest-key", text: match.item.name });
    if (match.item.description) el.createDiv({ cls: "gz-suggest-hint", text: match.item.description });
  }

  onChooseItem(item: AppItem, evt: MouseEvent | KeyboardEvent): void {
    this.choose(item, Keymap.isModifier(evt, "Mod"));
  }
}

/** Opens the app picker once the apps are read. */
function pickApp(plugin: GizmoPlugin, placeholder: string, aside: boolean, choose: (item: AppItem, aside: boolean) => void): void {
  void appItems(plugin).then((items) => new AppPicker(plugin.app, items, placeholder, aside, choose).open());
}

/** Opens an app in the current tab, or in the right sidebar. */
async function openApp(plugin: GizmoPlugin, item: AppItem, aside: boolean): Promise<void> {
  const { vault, workspace } = plugin.app;
  const file = vault.getFileByPath(item.path);
  if (!file) return void new Notice(`Can't find ${item.name}`);
  const leaf = aside ? workspace.getRightLeaf(false) : workspace.getLeaf(false);
  if (!leaf) return;
  await leaf.openFile(file);
  if (aside) await workspace.revealLeaf(leaf);
}

/** "Open an app…", which the ribbon's button runs too. */
export function openAppPicker(plugin: GizmoPlugin): void {
  pickApp(plugin, "Open an app", true, (item, aside) => void openApp(plugin, item, aside));
}

/** Asks which of an app's panels an embed shows: every one an embed can name, all chosen to start with. */
class PanelsModal extends Modal {
  private name: string;
  private choices: EmbedChoice[];
  private insert: (panels: string[] | undefined) => void;

  constructor(app: App, name: string, choices: EmbedChoice[], insert: (panels: string[] | undefined) => void) {
    super(app);
    this.name = name;
    this.choices = choices;
    this.insert = insert;
  }

  onOpen(): void {
    this.titleEl.setText(`Embed ${this.name}`);
    const el = this.contentEl.createDiv({ cls: "gizmo" });
    const nameable = this.choices.some((c) => "name" in c);
    el.createEl("p", { text: nameable ? "Choose the panels to show here." : "None of its panels has a title or label to name it by, so the block shows the whole app." });
    const chosen = new Set<string>();
    let insertButton: HTMLButtonElement | undefined;
    for (const c of this.choices) {
      const setting = new Setting(el);
      const box = setting.controlEl.createEl("input", { type: "checkbox" });
      if ("name" in c) {
        setting.setName(c.name);
        if (c.panels > 1) setting.setDesc(`Shows the ${c.panels} panels with this name`);
        box.checked = true;
        chosen.add(c.name);
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(c.name);
          else chosen.delete(c.name);
          if (insertButton) insertButton.disabled = chosen.size === 0;
        });
        // The whole row toggles its box, which on a phone is far easier to hit.
        setting.settingEl.addEventListener("click", (e) => { if (e.target !== box) box.click(); });
      } else {
        setting.setName(`${c.view} panel`).setDesc(`${c.reason}, so an embed can't name it.`).setDisabled(true);
        box.disabled = true;
      }
    }
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    insertButton = row.createEl("button", { cls: "mod-cta", text: "Insert" });
    insertButton.disabled = nameable && chosen.size === 0;
    insertButton.addEventListener("click", () => {
      this.close();
      this.insert(embedPanels(this.choices, [...chosen]));
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Puts a block at the cursor, on lines of its own, in place of what is selected. */
function insertBlock(editor: Editor, block: string): void {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  editor.replaceSelection(blockAt(editor.getLine(from.line).slice(0, from.ch), editor.getLine(to.line).slice(to.ch), block));
  editor.focus();
}

/** Asks for an app, then for which of its panels to show, and puts a `gizmo` block for them at the cursor. */
function embedHere(plugin: GizmoPlugin, editor: Editor, sourcePath: string): void {
  pickApp(plugin, "Embed an app's panels here", false, (item) => {
    const spec = plugin.runtime.background.spec(item.path);
    const file = plugin.app.vault.getFileByPath(item.path);
    if (!spec || !file) return void new Notice(`Can't read ${item.name}`);
    const link = plugin.app.metadataCache.fileToLinktext(file, sourcePath);
    new PanelsModal(plugin.app, item.name, embedChoices(spec), (panels) => insertBlock(editor, embedBlock(link, panels))).open();
  });
}

/** "Open an app…" and "Embed an app's panels here". */
export function registerOpenApp(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "open-app",
    name: "Open an app…",
    callback: () => openAppPicker(plugin),
  });
  plugin.addCommand({
    id: "embed-app-panels",
    name: "Embed an app's panels here",
    editorCallback: (editor, ctx) => embedHere(plugin, editor, ctx.file?.path ?? ""),
  });
}
