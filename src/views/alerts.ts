import type { Panel } from "../spec.ts";
import { heading, noteLink } from "./common.ts";
import type { ViewDef } from "./registry.ts";

/** One alert that is true now: the app it belongs to, its panel's title, and its value. */
export interface AlertItem {
  appPath: string;
  app: string;
  title: string;
  text: string;
}

/** The alerts true now across the vault, and word when that set changes. */
export interface AlertFeed {
  list(): AlertItem[];
  /** Calls back on every change; returns what stops it. */
  subscribe(cb: () => void): () => void;
}

const SHORTCUT = /^[a-z0-9-]+$/;

/**
 * Problems with the keys that make a panel work while its app is closed: `shortcut` (an id for a
 * command and a link), `pin` (to the status bar) and `alert`. A condition on the value is only for
 * views that show one value; others name a field.
 */
export function backgroundKeyErrors(p: Panel): string[] {
  return [
    ...(p.shortcut !== undefined && !SHORTCUT.test(p.shortcut) ? ["shortcut must be lowercase letters, digits and -"] : []),
    ...(p.pin !== undefined && p.pin !== "status" ? ["pin must be status"] : []),
    ...(typeof p.alert === "string" && p.view !== "number" && p.view !== "progress"
      ? [`alert on a ${p.view} needs a field, e.g. alert: {amount: "> 100"}`] : []),
    ...(p.alert !== undefined && !p.source && p.view === "text" ? ["alert needs a source"] : []),
  ];
}

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
