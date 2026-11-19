import { FuzzySuggestModal, Notice, type App } from "obsidian";
import { linkNotice, type ShortcutLink } from "./background.ts";
import type GizmoPlugin from "./main.ts";

export function copyShortcutLink(s: ShortcutLink): void {
  navigator.clipboard.writeText(s.link).then(
    () => { new Notice(linkNotice(s)); },
    () => { new Notice("Couldn't copy to the clipboard"); },
  );
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
