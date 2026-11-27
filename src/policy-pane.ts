import { handler } from "./handler.ts";
import { violationText } from "./flows.ts";
import { describePermission } from "./permissions.ts";
import { POLICY_PATH, type AppliedPolicy } from "./policy.ts";
import type { GizmoRuntime } from "./runtime.ts";

export const POLICY_TITLE = "Your data policy";

/** What applying the policy note would change, app by app, with Apply, drawn into `el` (a window's content). */
export function drawPolicy(el: HTMLElement, rt: GizmoRuntime, host: { notify(message: string): void; close(): void }): void {
  el.addClass("gizmo", "gz-policy");
  const now = rt.readPolicyNote();
  const applied = rt.store.policy;

  const buttons = (next: AppliedPolicy | undefined, canApply: boolean) => {
    const row = el.createDiv({ cls: "gz-actions" });
    if (canApply) {
      row.createEl("button", { cls: "mod-cta", text: next ? "Apply" : "Stop using a policy" }).addEventListener("click", handler(async () => {
        await rt.applyPolicy(next);
        host.notify(next ? "Your data policy is applied" : "No data policy is used now");
        host.close();
      }));
    }
    row.createEl("button", { text: canApply ? "Cancel" : "Close" }).addEventListener("click", () => host.close());
  };

  if ("errors" in now) {
    el.createDiv({ text: `${POLICY_PATH} can't be applied until these are fixed:` });
    const ul = el.createEl("ul", { cls: "gz-error" });
    for (const e of now.errors) ul.createEl("li", { text: e });
    el.createDiv({ cls: "gz-muted", text: applied ? "Until then the policy applied before stays." : "Until then no policy is used." });
    return buttons(undefined, false);
  }
  if ("none" in now) {
    if (!applied) {
      el.createDiv({ text: `There's no ${POLICY_PATH} at the root of this vault.` });
      el.createDiv({ cls: "gz-muted", text: "Its properties say how private your notes are (labels), where data may go (sinks), and exceptions (release). Gizmo checks every app against it once you apply it here." });
      return buttons(undefined, false);
    }
    el.createDiv({ text: `${POLICY_PATH} is gone. Apply stops using a policy: apps ask for everything again, as before.` });
    return buttons(undefined, true);
  }
  if (applied?.hash === now.applied.hash) el.createDiv({ cls: "gz-muted", text: "This policy is applied. What it says of each app:" });
  drawEffects(el, rt, now.applied);
  buttons(now.applied, applied?.hash !== now.applied.hash);
}

/** Each app under the new rules: what stops, what no longer asks, what still does. */
function drawEffects(el: HTMLElement, rt: GizmoRuntime, next: AppliedPolicy): void {
  const judged = rt.background.judge(next.rules);
  const blocked = judged.filter((j) => j.verdict.violations.length);
  const fits = judged.filter((j) => !j.verdict.violations.length);
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
