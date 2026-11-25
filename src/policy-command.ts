import { Modal, Notice } from "obsidian";
import { handler } from "./handler.ts";
import { violationText } from "./flows.ts";
import type GizmoPlugin from "./main.ts";
import { describePermission } from "./permissions.ts";
import { POLICY_PATH, type AppliedPolicy } from "./policy.ts";

/** What applying the policy note would change, app by app, with Apply. */
export class PolicyModal extends Modal {
  private plugin: GizmoPlugin;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gizmo", "gz-policy");
    this.titleEl.setText("Your data policy");
    const now = this.plugin.runtime.readPolicyNote();
    const applied = this.plugin.runtime.store.policy;
    if ("errors" in now) {
      contentEl.createDiv({ text: `${POLICY_PATH} can't be applied until these are fixed:` });
      const ul = contentEl.createEl("ul", { cls: "gz-error" });
      for (const e of now.errors) ul.createEl("li", { text: e });
      contentEl.createDiv({ cls: "gz-muted", text: applied ? "Until then the policy applied before stays." : "Until then no policy is used." });
      return this.buttons(undefined, false);
    }
    if ("none" in now) {
      if (!applied) {
        contentEl.createDiv({ text: `There's no ${POLICY_PATH} at the root of this vault.` });
        contentEl.createDiv({ cls: "gz-muted", text: "Its properties say how private your notes are (labels), where data may go (sinks), and exceptions (release). Gizmo checks every app against it once you apply it here." });
        return this.buttons(undefined, false);
      }
      contentEl.createDiv({ text: `${POLICY_PATH} is gone. Apply stops using a policy: apps ask for everything again, as before.` });
      return this.buttons(undefined, true);
    }
    if (applied?.hash === now.applied.hash) contentEl.createDiv({ cls: "gz-muted", text: "This policy is applied. What it says of each app:" });
    this.drawEffects(now.applied);
    this.buttons(now.applied, applied?.hash !== now.applied.hash);
  }

  /** Each app under the new rules: what stops, what no longer asks, what still does. */
  private drawEffects(next: AppliedPolicy): void {
    const judged = this.plugin.runtime.background.judge(next.rules);
    const blocked = judged.filter((j) => j.verdict.violations.length);
    const fits = judged.filter((j) => !j.verdict.violations.length);
    const el = this.contentEl;
    if (blocked.length) {
      el.createEl("h4", { text: `Stops: ${blocked.length} ${blocked.length === 1 ? "app" : "apps"} would send data where it may not go` });
      for (const j of blocked) {
        const card = el.createDiv({ cls: "gz-card gz-error" });
        card.createDiv({ cls: "gz-title", text: j.name });
        const ul = card.createEl("ul");
        for (const v of j.verdict.violations) ul.createEl("li", { text: violationText(v) });
      }
    }
    if (fits.length) {
      el.createEl("h4", { text: `Fits: ${fits.length} ${fits.length === 1 ? "app" : "apps"}` });
      const ul = el.createEl("ul");
      for (const j of fits) {
        const li = ul.createEl("li");
        li.createSpan({ cls: "gz-title", text: j.name });
        const covered = j.verdict.covered.map(describePermission);
        li.createSpan({
          cls: "gz-muted",
          text: covered.length ? ` — no longer asks to: ${covered.join("; ")}` : j.verdict.asked.length ? " — still asks for everything it needs" : " — asks for nothing",
        });
      }
    }
    if (!judged.length) el.createDiv({ cls: "gz-muted", text: "There are no apps in this vault yet." });
  }

  private buttons(next: AppliedPolicy | undefined, canApply: boolean): void {
    const row = this.contentEl.createDiv({ cls: "gz-actions" });
    if (canApply) {
      row.createEl("button", { cls: "mod-cta", text: next ? "Apply" : "Stop using a policy" }).addEventListener("click", handler(async () => {
        await this.plugin.runtime.applyPolicy(next);
        new Notice(next ? "Your data policy is applied" : "No data policy is used now");
        this.close();
      }));
    }
    row.createEl("button", { text: canApply ? "Cancel" : "Close" }).addEventListener("click", () => this.close());
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
