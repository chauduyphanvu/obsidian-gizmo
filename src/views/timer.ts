import { ACTION_KEYS, heading, redraw } from "./common.ts";
import type { ViewDef } from "./registry.ts";

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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
    el.createDiv({ cls: "na-big na-clock", text: formatClock(remaining), attr: { "data-na-timer": key } });
    const row = el.createDiv({ cls: "na-row" });
    const toggle = row.createEl("button", { cls: "mod-cta", text: state.endsAt ? "Pause" : "Start" });
    toggle.addEventListener("click", () => (state.endsAt ? ctx.pauseTimer(key) : ctx.startTimer(key, p)));
    row.createEl("button", { text: "Reset" }).addEventListener("click", () => ctx.resetTimer(key, p));
    if (p.label) el.createDiv({ cls: "na-label", text: p.label });
  }),
};
