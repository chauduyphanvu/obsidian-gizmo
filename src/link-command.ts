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
    el.createDiv({ cls: "gz-suggest-hint", text: s.allowed ? s.address : `${s.address} (open ${s.app} once to allow it)` });
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

/** A window a link opens before it runs: what it asks, then buttons, the first (Cancel) focused. Closing it any other way is Cancel. */
class LinkAskModal extends Modal {
  private heading: string;
  private lines: string[];
  private note: string;
  private choices: { label: string; cls?: string }[];
  private effects: string[] | undefined;
  private done: (choice: number | undefined) => void;
  private answered = false;

  constructor(
    app: App, heading: string, lines: string[], note: string, choices: { label: string; cls?: string }[],
    done: (choice: number | undefined) => void, effects?: string[],
  ) {
    super(app);
    this.heading = heading;
    this.lines = lines;
    this.note = note;
    this.choices = choices;
    this.done = done;
    this.effects = effects;
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share" });
    if (this.lines.length) {
      const ul = el.createEl("ul");
      for (const line of this.lines) ul.createEl("li", { text: line });
    }
    if (this.effects?.length) {
      el.createEl("h4", { text: "It will:" });
      const ul = el.createEl("ul", { cls: "gz-effects" });
      for (const line of this.effects) ul.createEl("li", { text: line });
    }
    el.createEl("p", { cls: "gz-muted", text: this.note });
    const row = el.createDiv({ cls: "modal-button-container" });
    const buttons = this.choices.map((c, i) => {
      const b = row.createEl("button", { cls: c.cls, text: c.label });
      b.addEventListener("click", () => {
        this.answered = true;
        this.done(i === 0 ? undefined : i);
        this.close();
      });
      return b;
    });
    buttons[0]?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done(undefined);
  }
}

/** Asks whether to run what a link without its key asks, showing what it would change; true for Run. */
export function askToRun(app: App, heading: string, lines: string[], effects?: string[]): Promise<boolean> {
  const note = "This link doesn't carry the key a copied link has, so it may come from anywhere: a web page, an email or a message. Run it only if you meant to.";
  const choices = [{ label: "Cancel" }, { label: "Run", cls: "mod-warning" }];
  return new Promise((resolve) => new LinkAskModal(app, heading, lines, note, choices, (c) => resolve(c === 1), effects).open());
}

/**
 * Asks where a keyed link may send word back: Cancel, Once, or Always (remembered with the link's
 * key). The index picked, or undefined for Cancel.
 */
export function askWhereTo(app: App, heading: string, lines: string[], choices: string[]): Promise<number | undefined> {
  const note = "This link carries its key, so it was copied in Obsidian. What it sends back leaves Obsidian for the app named above.";
  const styled = choices.map((label, i) => ({ label, cls: i === choices.length - 1 ? "mod-cta" : undefined }));
  return new Promise((resolve) => new LinkAskModal(app, heading, lines, note, styled, resolve).open());
}
