import { FuzzySuggestModal, Notice, Platform, type App, type TFile } from "obsidian";
import type { AskHost } from "./ask-pane.ts";
import { obsidianAppEnv } from "./host.ts";
import { copyText } from "./clipboard.ts";
import type GizmoPlugin from "./main.ts";

/** The vault's apps, to add an answer to. */
class AppChooser extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private choose: (file: TFile) => void;

  constructor(app: App, files: TFile[], choose: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.choose = choose;
    this.setPlaceholder("Add the answer to an app: choose one");
    this.emptyStateText = "No apps in this vault yet";
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path.replace(/\.md$/i, "");
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

/** Do…'s `?` pane on Obsidian (see AskPane): answers drawn as the kind's note, apps picked from a list, notices. */
export function obsidianAskHost(plugin: GizmoPlugin): AskHost {
  const app = plugin.app;
  return {
    rt: plugin.runtime,
    env: (path) => obsidianAppEnv(plugin, undefined, app.vault.getFileByPath(path)!),
    chooseApp: (paths, choose) => new AppChooser(app, paths.flatMap((p) => app.vault.getFileByPath(p) ?? []), (file) => choose(file.path)).open(),
    notify: (message) => { new Notice(message); },
    copy: (text, done) => copyText(text, done),
    open: (path) => void app.workspace.openLinkText(path, "", false),
    modKey: Platform.isMacOS ? "⌘" : "Ctrl ",
  };
}
