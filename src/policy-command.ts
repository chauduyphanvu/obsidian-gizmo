import { Modal, Notice } from "obsidian";
import type GizmoPlugin from "./main.ts";
import { POLICY_TITLE, drawPolicy } from "./policy-pane.ts";

/** What applying the policy note would change, app by app, with Apply (see drawPolicy). */
export class PolicyModal extends Modal {
  private plugin: GizmoPlugin;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText(POLICY_TITLE);
    drawPolicy(this.contentEl, this.plugin.runtime, { notify: (message) => new Notice(message), close: () => this.close() });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function registerPolicyCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "apply-policy",
    name: "Review and apply data policy",
    callback: () => new PolicyModal(plugin).open(),
  });
}
