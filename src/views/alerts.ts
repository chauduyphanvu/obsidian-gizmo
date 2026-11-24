import { heading, noteLink } from "./common.ts";
import type { ViewDef } from "./registry.ts";

/** `view: alerts`: every alert true now, across the vault, each linking to its app. */
export const alerts: ViewDef = {
  id: "alerts",
  keys: [],
  span: 2,
  examples: [
    { panel: { view: "alerts", title: "Needs attention" } },
    { panel: { view: "alerts", source: "doses" }, errors: ['"source" doesn\'t apply to alerts'] },
  ],
  mount(el, p, ctx) {
    const draw = () => {
      el.empty();
      heading(el, p);
      const items = ctx.alerts?.list() ?? [];
      if (items.length === 0) {
        el.createDiv({ cls: "gz-empty", text: "Nothing needs attention." });
        return;
      }
      const ul = el.createEl("ul", { cls: "gz-alerts" });
      for (const a of items) {
        const li = ul.createEl("li");
        noteLink(li, a.app, a.appPath, ctx);
        li.createSpan({ cls: "gz-alert-title", text: a.title });
        li.createSpan({ cls: "gz-alert-value", text: a.text });
      }
    };
    const stop = ctx.alerts?.subscribe(draw);
    return { update: draw, destroy: () => stop?.() };
  },
};
