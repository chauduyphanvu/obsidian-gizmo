import { Modal, Notice } from "obsidian";
import { obsidianLineHost } from "./capture-command.ts";
import type GizmoPlugin from "./main.ts";
import { NextPane } from "./next-pane.ts";

/** "Next" in a window of Obsidian's (see NextPane). */
class NextModal extends Modal {
  private plugin: GizmoPlugin;
  private pane: NextPane | undefined;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Next");
    this.modalEl.addClass("gz-next-modal");
    const body = this.contentEl.createDiv({ cls: "gizmo gz-share gz-capture gz-next" });
    const pane = new NextPane(body, {
      ...obsidianLineHost(this.plugin),
      notify: (message) => { new Notice(message); },
      open: (path) => void this.app.workspace.openLinkText(path, "", false),
      close: () => this.close(),
    });
    this.pane = pane;
    this.modalEl.addEventListener("keydown", (e) => pane.key(e));
  }

  /** Obsidian puts the keys in the window's first input as it opens it; the ask decides where they go. */
  open(): void {
    super.open();
    this.pane?.aim();
  }

  onClose(): void {
    this.pane?.stop();
    this.contentEl.empty();
  }
}

export function openNext(plugin: GizmoPlugin): void {
  new NextModal(plugin).open();
}

/** "Next", and the status bar's count that opens it (see background-glue.ts). */
export function registerNextCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({ id: "next", name: "Next", callback: () => openNext(plugin) });
}
