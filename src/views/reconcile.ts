import { renderReconcile } from "./reconcile-card.ts";
import { heading } from "./common.ts";
import type { ViewDef } from "./registry.ts";

/**
 * `view: reconcile`: the card a kind's own note shows when rows it read from a file wait to be
 * checked, in an app that reads the kind, with Accept and Not mine. It reads the rows itself, every
 * line of them, so it takes no other key of the rows; it is drawn again whenever they change.
 */
export const reconcile: ViewDef = {
  id: "reconcile",
  keys: ["source", "empty"],
  span: 4,
  needsSource: true,
  validate: (p) => (p.kind ? [] : [`reconcile checks the rows a kind read from a file; give it a source that links to a kind, e.g. source: "[[Spend]]"`]),
  examples: [
    { panel: { view: "reconcile", title: "Charges from the bank", source: "[[Spend]]" } },
    { panel: { view: "reconcile", source: "spend" }, errors: ['reconcile checks the rows a kind read from a file; give it a source that links to a kind, e.g. source: "[[Spend]]"'] },
  ],
  mount(el, p, ctx) {
    let drawn = 0;
    const show = (host: Awaited<ReturnType<NonNullable<typeof ctx.reconcile>>>) => {
      el.empty();
      heading(el, p);
      if (!host) el.createDiv({ cls: "gz-empty", text: "Rows from a file are checked in the app as it is now." });
      else if (!host.card) el.createDiv({ cls: "gz-empty", text: host.waiting ?? p.empty ?? "Nothing read from a file waits to be checked." });
      else renderReconcile(el, host.card, host.fields, host);
    };
    const draw = async () => {
      const n = ++drawn;
      if (!ctx.reconcile) return show(undefined);
      const host = await ctx.reconcile(p);
      if (n === drawn) show(host);
    };
    return { update: () => void draw() };
  },
};
