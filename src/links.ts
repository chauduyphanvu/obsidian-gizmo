import { stampParts, type Row } from "./data.ts";
import { startOf } from "./keys.ts";
import type { Panel } from "./spec.ts";
import { basename } from "./store.ts";

/** A shortcut as a link from outside Obsidian (a phone's shortcut, a tag, a bookmark) runs it. */
export interface ShortcutLink {
  path: string;
  app: string;
  shortcut: string;
  label: string;
  /** A form's fields, each filled by `&field=value`; none for a button. */
  fields: string[];
  link: string;
  allowed: boolean;
}

/** A link's own parameters; a form field of one of these names can't be filled from a link. */
export const LINK_PARAMS = ["action", "app", "do"];

/** What a link asks: the app it names, the shortcut to run, and every other parameter, which fills a form's fields. */
export function readLink(params: Record<string, string>): { app: string; shortcut: string; fields: Record<string, string> } {
  const fields = Object.fromEntries(Object.entries(params).filter(([k]) => !LINK_PARAMS.includes(k)));
  return { app: params.app ?? "", shortcut: params.do ?? "", fields };
}

/** What copying a shortcut's link tells: which link, how a form's fields are filled, and what stops it. */
export function linkNotice(s: ShortcutLink): string {
  const parts = [`Copied the link to “${s.label}” in ${s.app}.`];
  const fillable = s.fields.filter((f) => !LINK_PARAMS.includes(f));
  if (fillable.length) parts.push(`Add ${fillable.map((f) => `&${f}=…`).join("")} to fill the form.`);
  const stuck = s.fields.filter((f) => LINK_PARAMS.includes(f));
  if (stuck.length) parts.push(`A link can't fill ${stuck.join(", ")}; rename ${stuck.length === 1 ? "that field" : "those fields"} to fill ${stuck.length === 1 ? "it" : "them"}.`);
  if (!s.allowed) parts.push(`Open ${s.app} once to allow it; until then the link is refused.`);
  return parts.join(" ");
}

/** The apps a link's `app=` names: the one at that path (`.md` optional), else every app of that name. */
export function appsNamed<T extends { path: string; name: string }>(apps: ReadonlyMap<string, T>, name: string): T[] {
  const exact = apps.get(name) ?? apps.get(`${name}.md`);
  return exact ? [exact] : [...apps.values()].filter((e) => e.name === name);
}

/** The link that runs an app's shortcut: it names the app by name, or by path when another app has that name. */
export function shortcutLink(apps: ReadonlyMap<string, { path: string; name: string }>, path: string, shortcut: string): string {
  const name = basename(path);
  const app = appsNamed(apps, name).length === 1 ? name : path.replace(/\.md$/i, "");
  return `obsidian://gizmo?app=${encodeURIComponent(app)}&do=${encodeURIComponent(shortcut)}`;
}
/**
 * A form's row from a link's parameters, each read as its field's type; a field the link doesn't
 * give is what an untouched form saves. Parameters that aren't fields are ignored.
 */
export function formRow(fields: Record<string, string | string[]>, info: Panel["fieldInfo"], params: Record<string, string>, now: Date): { row: Row } | { error: string } {
  const row: Row = {};
  for (const [name, type] of Object.entries(fields)) {
    if (!Object.hasOwn(params, name)) {
      row[name] = startOf(info?.[name], now) ?? (Array.isArray(type) ? type[0] ?? ""
        : type === "checkbox" ? false : type === "number" ? null : type === "date" ? stampParts(now).date : "");
      continue;
    }
    const value = typedValue(type, params[name]);
    if (value === undefined) return { error: `${name} ${expectedOf(type)}` };
    row[name] = value;
  }
  return { row };
}

/** Link text as a field of this type holds it; undefined when it can't. */
function typedValue(type: string | string[], raw: string): unknown {
  if (Array.isArray(type)) return type.find((o) => String(o) === raw);
  const word = raw.trim().toLowerCase();
  switch (type) {
    case "number": return word !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    case "checkbox": return ["true", "1", "yes"].includes(word) ? true : ["false", "0", "no"].includes(word) ? false : undefined;
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
    case "time": return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : undefined;
    default: return raw;
  }
}

function expectedOf(type: string | string[]): string {
  if (Array.isArray(type)) return `must be one of ${type.join(", ")}`;
  switch (type) {
    case "number": return "must be a number";
    case "checkbox": return "must be true or false";
    case "date": return "must be a date like 2026-11-18";
    default: return "must be a time like 08:30";
  }
}
