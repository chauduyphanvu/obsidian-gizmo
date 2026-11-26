import { Modal, Notice } from "obsidian";
import { drawActivity, type ActivityOpts } from "./activity-list.ts";
import type GizmoPlugin from "./main.ts";
import { openAppAt } from "./past-views.ts";
import { basename } from "./store.ts";

/** What one app (or every app) changed in the vault, in a window. */
class ActivityModal extends Modal {
  private plugin: GizmoPlugin;
  private opts: ActivityOpts;

  constructor(plugin: GizmoPlugin, appPath?: string, focus?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = {
      ...(appPath && { appPath, seeThen: (at: number) => { this.close(); void openAppAt(plugin, appPath, at); } }),
      ...(focus && { focus }),
    };
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.appPath ? `What ${basename(this.opts.appPath)} did` : "What your apps did");
    void drawActivity(this.contentEl, this.plugin.runtime, (message) => { new Notice(message); }, this.opts);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openActivity(plugin: GizmoPlugin, appPath?: string, focus?: string): void {
  new ActivityModal(plugin, appPath, focus).open();
}

/** "Show app activity": the open app's, or every app's when no app is open. */
export function registerActivity(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "show-activity",
    name: "Show app activity",
    callback: () => {
      const file = plugin.app.workspace.getActiveFile();
      openActivity(plugin, file && plugin.isApp(file) ? file.path : undefined);
    },
  });
}
