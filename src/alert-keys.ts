import type { Panel } from "./spec.ts";
import { secretIds } from "./template.ts";
import { isFigure, typedFields } from "./panel.ts";

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

export const SHORTCUT = /^[a-z0-9-]+$/;

/** An alias is typed at the start of a capture line: words of letters and digits, - and ', up to 40 characters. */
const ALIAS = /^[\p{L}\p{N}](?:[\p{L}\p{N}'’ -]{0,38}[\p{L}\p{N}])?$/u;

/**
 * The shortcut an alias makes when its panel has none: its words in lowercase joined by -, with
 * anything but a-z and 0-9 left out ("Resting heart rate" makes resting-heart-rate); undefined
 * when nothing is left.
 */
export function aliasShortcut(alias: string): string | undefined {
  const id = alias.toLowerCase().replace(/['’]/g, "").replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return id || undefined;
}

/** Why a shortcut or alias can't have this name: `what`, or words starting `what if`, which Do… reads as a what-if. */
export function whatIfProblem(key: "shortcut" | "alias", name: string): string | undefined {
  return /^what(?:\s+if(?:\s|$)|$)/i.test(name.trim()) ? `${key} can't be "${name}": Do… reads a line that starts with "what if" as a what-if` : undefined;
}

/**
 * Problems with the keys that make a panel work while its app is closed: `shortcut` (an id for a
 * command and a link), `pin` (to the status bar) and `alert`. A condition on the value is only for
 * views that show one value; others name a field.
 */
export function backgroundKeyErrors(p: Panel): string[] {
  return [
    ...(p.shortcut !== undefined && !SHORTCUT.test(p.shortcut) ? ["shortcut must be lowercase letters, digits and -"] : []),
    ...(p.alias !== undefined && !ALIAS.test(p.alias) ? ["alias must be words of letters and digits (with - and '), up to 40 characters"] : []),
    ...[p.shortcut === undefined ? undefined : whatIfProblem("shortcut", p.shortcut), p.alias === undefined ? undefined : whatIfProblem("alias", p.alias)]
      .filter((e): e is string => e !== undefined),
    ...(p.pin !== undefined && p.pin !== "status" ? ["pin must be status"] : []),
    ...(typeof p.alert === "string" && !isFigure(p)
      ? [`alert on a ${p.view} needs a field, e.g. alert: {amount: "> 100"}`] : []),
    ...(p.alert !== undefined && !p.source && p.view === "text" ? ["alert needs a source"] : []),
    ...(p.then && !SHORTCUT.test(p.then.do) ? ["then: do must be the other app's shortcut: lowercase letters, digits and -"] : []),
    ...(p.then && !/\S/.test(p.then.app.replace(/^\[\[|\]\]$/g, "")) ? ["then: app must name an app, e.g. \"[[Task inbox]]\""] : []),
    ...(p.then && p.view !== "button" && p.view !== "form" && p.alert === undefined
      ? [`then on a ${p.view} needs alert: it runs when the alert turns true`] : []),
    ...fillErrors(p),
  ];
}

/**
 * Mistakes in `then`'s fill that can be seen before it runs: a secret, which never fills there,
 * and on a form or button a {name} its run never has (its fields, `row` keys, the time, and after
 * a save to a folder the note's path). An alert's rows can hold anything, so a name a row lacks
 * fills as empty there, as in notify and line.
 */
function fillErrors(p: Panel): string[] {
  const texts = Object.values(p.then?.fill ?? {});
  const secret = texts.flatMap(secretIds)[0];
  if (secret !== undefined) return [`then: fill can't use {secret:${secret}}; secrets only go into web requests`];
  if (p.view !== "form" && p.view !== "button") return [];
  const fields = Object.keys(typedFields(p));
  const own = [...new Set([...fields, ...Object.keys(p.row ?? {}), ...(p.target?.kind === "folder" ? ["path"] : [])])];
  const known = new Set([...own, "date", "time", "at"]);
  for (const text of texts) {
    for (const [, raw] of text.matchAll(/\{([^{}]+)\}/g)) {
      const name = raw.trim();
      if (known.has(name.split(".")[0])) continue;
      return [`then: fill reads {${name}}, which this ${p.view} never has (it has ${own.length ? `${own.join(", ")}, and ` : ""}date, time, at)`];
    }
  }
  return [];
}
