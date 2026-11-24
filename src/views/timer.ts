import { formatClock } from "../time.ts";
import { heading, redraw } from "./common.ts";
import { ACTION_KEYS } from "../keys.ts";
import type { ViewDef } from "./registry.ts";

export const timer: ViewDef = {
  id: "timer",
  keys: [...ACTION_KEYS, "minutes", "label"],
  span: 1,
  validate: (p) => (p.minutes && p.minutes > 0 ? [] : ["timer needs minutes"]),
  examples: [
    { panel: { view: "timer", minutes: 25, append: "Daily", line: "- Focus {time}" } },
    { panel: { view: "timer" }, errors: ["timer needs minutes"] },
  ],
  mount: (el, p, ctx, key) => redraw(el, () => {
    heading(el, p);
    const state = ctx.timer(key, p);
    const remaining = state.endsAt ? state.endsAt - Date.now() : state.remainingMs;
    const box = el.createDiv({ cls: "gz-timer" });
    box.createDiv({ cls: "gz-clock", text: formatClock(remaining), attr: { "data-gz-timer": key } });
    const row = box.createDiv({ cls: "gz-timer-actions" });
    const toggle = row.createEl("button", { cls: state.endsAt ? undefined : "mod-cta", text: state.endsAt ? "Pause" : "Start" });
    toggle.addEventListener("click", () => (state.endsAt ? ctx.pauseTimer(key) : ctx.startTimer(key, p)));
    row.createEl("button", { text: "Reset" }).addEventListener("click", () => ctx.resetTimer(key, p));
    if (p.label) box.createDiv({ cls: "gz-label", text: p.label });
  }),
};
