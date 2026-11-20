import { FuzzySuggestModal, Modal, Notice, type App } from "obsidian";
import { linkNotice, type ShortcutLink } from "./links.ts";
import { copyText } from "./host.ts";
import type GizmoPlugin from "./main.ts";

export function copyShortcutLink(s: ShortcutLink): void {
  copyText(s.link, () => { new Notice(linkNotice(s)); });
}

/** Every app's shortcuts, each with its app and whether it's allowed yet. */
class ShortcutPicker extends FuzzySuggestModal<ShortcutLink> {
  private links: ShortcutLink[];

  constructor(app: App, links: ShortcutLink[]) {
    super(app);
    this.links = links;
    this.setPlaceholder("Copy the link that runs a shortcut");
  }

  getItems(): ShortcutLink[] {
    return this.links;
  }

  getItemText(s: ShortcutLink): string {
    return `${s.app} ${s.label} ${s.shortcut}`;
  }

  renderSuggestion(match: { item: ShortcutLink }, el: HTMLElement): void {
    const s = match.item;
    el.createDiv({ cls: "gz-suggest-key", text: `${s.app}: ${s.label}` });
    el.createDiv({ cls: "gz-suggest-hint", text: s.allowed ? s.link : `${s.link} (open ${s.app} once to allow it)` });
  }

  onChooseItem(s: ShortcutLink): void {
    copyShortcutLink(s);
  }
}

/** "Copy link to an app shortcut": the obsidian://gizmo link that runs a shortcut from outside Obsidian. */
export function registerLinkCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "copy-shortcut-link",
    name: "Copy link to an app shortcut",
    callback: () => {
      const links = plugin.background?.shortcutLinks() ?? [];
      if (!links.length) return void new Notice("No app has a shortcut yet; add shortcut: to a button or form");
      new ShortcutPicker(plugin.app, links).open();
    },
  });
}

/**
 * A link without its shortcut's key: what it would run and the values it gives, with Cancel
 * focused and Run beside it. Closing the window any other way is Cancel.
 */
class LinkRunModal extends Modal {
  private heading: string;
  private lines: string[];
  private done: (run: boolean) => void;
  private answered = false;

  constructor(app: App, heading: string, lines: string[], done: (run: boolean) => void) {
    super(app);
    this.heading = heading;
    this.lines = lines;
    this.done = done;
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share" });
    if (this.lines.length) {
      const ul = el.createEl("ul");
      for (const line of this.lines) ul.createEl("li", { text: line });
    }
    el.createEl("p", {
      cls: "gz-muted",
      text: "This link doesn't carry the key a copied link has, so it may come from anywhere: a web page, an email or a message. Run it only if you meant to.",
    });
    const row = el.createDiv({ cls: "modal-button-container" });
    const cancel = row.createEl("button", { text: "Cancel" });
    const run = row.createEl("button", { cls: "mod-warning", text: "Run" });
    cancel.addEventListener("click", () => this.close());
    run.addEventListener("click", () => {
      this.answered = true;
      this.done(true);
      this.close();
    });
    cancel.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done(false);
  }
}

/** Asks whether to run what a link without its key asks; true for Run. */
export function askToRun(app: App, heading: string, lines: string[]): Promise<boolean> {
  return new Promise((resolve) => new LinkRunModal(app, heading, lines, resolve).open());
}
