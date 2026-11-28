import { Modal, Notice, type App } from "obsidian";
import { toBundle, type BundleNote } from "./bundle.ts";
import { installAndOpen } from "./gallery-command.ts";
import { copyText } from "./clipboard.ts";
import { notesToShare } from "./install.ts";
import type GizmoPlugin from "./main.ts";
import { INSTALL_TITLE, drawInstall, drawShare, shareTitle } from "./share-pane.ts";
import { tryBundle } from "./try-modal.ts";

/** Shows the shared text before it leaves (see drawShare). */
class ShareModal extends Modal {
  private name: string;
  private notes: BundleNote[];
  private text: string;
  private warnings: string[];

  constructor(app: App, name: string, notes: BundleNote[], text: string, warnings: string[]) {
    super(app);
    this.name = name;
    this.notes = notes;
    this.text = text;
    this.warnings = warnings;
  }

  onOpen(): void {
    this.titleEl.setText(shareTitle(this.name));
    drawShare(this.contentEl, this.name, this.notes, this.text, this.warnings, {
      copy: (text, done) => copyText(text, done),
      notify: (message) => new Notice(message),
      close: () => this.close(),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Reads shared text or a link and installs it (see drawInstall). */
class InstallModal extends Modal {
  private plugin: GizmoPlugin;
  private start: string;

  constructor(plugin: GizmoPlugin, start = "") {
    super(plugin.app);
    this.plugin = plugin;
    this.start = start;
  }

  onOpen(): void {
    this.titleEl.setText(INSTALL_TITLE);
    drawInstall(this.contentEl, this.plugin.runtime, {
      start: this.start,
      tryIt: (notes, folder, install) => tryBundle(this.plugin, notes, folder, install),
      install: (plan, name) => installAndOpen(this.plugin, plan, name),
      close: () => this.close(),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Opens the install window, reading `start` (a link or shared text) right away when given. */
export function openInstall(plugin: GizmoPlugin, start = ""): void {
  new InstallModal(plugin, start).open();
}

/** "Share this app" and "Install an app from a link or text". */
export function registerShareCommands(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "share-app",
    name: "Share this app",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || !plugin.isApp(file)) return false;
      if (!checking) {
        void (async () => {
          const got = await notesToShare(plugin.runtime, file.path);
          if ("error" in got) return void new Notice(got.error);
          const bundle = toBundle(got.notes, got.about);
          if ("error" in bundle) return void new Notice(`Can't share ${file.basename}: ${bundle.error}`);
          new ShareModal(plugin.app, file.basename, got.notes, bundle.text, got.runs).open();
        })();
      }
      return true;
    },
  });
  plugin.addCommand({
    id: "install-app",
    name: "Install an app from a link or text",
    callback: () => openInstall(plugin),
  });
}
