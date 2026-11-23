import { Modal, type App } from "obsidian";
import { drawExplain, type ExplainSource } from "./explain-view.ts";

/** The Explain window of one figure, opened from the figure itself or with `=` (see explain-view.ts). */
export class ExplainModal extends Modal {
  private src: ExplainSource;

  constructor(app: App, src: ExplainSource) {
    super(app);
    this.src = src;
  }

  onOpen(): void {
    this.titleEl.setText("Where this figure comes from");
    void drawExplain(this.contentEl.createDiv({ cls: "gizmo" }), this.src);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
