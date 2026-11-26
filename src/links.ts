import { type Row } from "./data.ts";
import { stampParts } from "./time.ts";
import { startOf } from "./keys.ts";
import type { Panel } from "./spec.ts";
import { basename } from "./store.ts";
import { asField } from "./units.ts";

/** Where every Gizmo link starts: what the program it opens in answers. */
export const GIZMO_LINK = "obsidian://gizmo";

/** A shortcut as a link from outside Obsidian (a phone's shortcut, a tag, a bookmark) runs it. */
export interface ShortcutLink {
  path: string;
  app: string;
  shortcut: string;
  label: string;
  /** The shortcut's panel: a form, button or checklist, or a number or progress panel that answers. */
  view: string;
  /** A form's fields, each filled by `&field=value`, or a checklist's `item`; none for a button. */
  fields: string[];
  /** The link with its key; reading it makes the key when there is none yet, so only copy it. */
  readonly link: string;
  /** The link without its key, for showing which shortcut it runs. */
  address: string;
  allowed: boolean;
  /** It answers with a value (a number or progress panel) instead of acting. */
  answers: boolean;
}

/** A link's own parameters; a form field of one of these names can't be filled from a link. */
export const LINK_PARAMS = ["action", "app", "do", "key", "x-success", "x-error", "x-cancel", "x-source"];

/** The apps a link may hand its answer back to (x-callback-url), by URL scheme; any other is refused. */
export const CALLBACK_SCHEMES = ["shortcuts", "raycast", "alfred", "kmtrigger", "drafts", "https"];

/** Where a link wants its answer, or word that it's done, sent: x-success, x-error and x-cancel. */
export interface Callbacks {
  success?: string;
  error?: string;
  cancel?: string;
  /** The app they all go to, as `scheme://host`, shown when asking and remembered with the link's key. */
  to?: string;
}

/** A callback's app as a person can check it: its scheme and host, never what the link calls itself. */
export function destinationOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * A link's callbacks, each a URL with a scheme Gizmo answers to, all going to one app; or the problem with them.
 * `x-source` (what the caller calls itself) is never trusted to say where an answer goes.
 */
export function readCallbacks(params: Record<string, string>): Callbacks | { problem: string } {
  const out: Callbacks = {};
  for (const [param, key] of [["x-success", "success"], ["x-error", "error"], ["x-cancel", "cancel"]] as const) {
    const text = params[param];
    if (text === undefined) continue;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { problem: `${param} isn't a link` };
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (!CALLBACK_SCHEMES.includes(scheme)) return { problem: `${param} goes to ${scheme}:, and Gizmo only answers to ${CALLBACK_SCHEMES.join(", ")}` };
    const to = destinationOf(url);
    if (out.to !== undefined && out.to !== to) return { problem: "x-success, x-error and x-cancel must all go to one app" };
    out.to = to;
    out[key] = text;
  }
  return out;
}

/** A callback with its parameters set (replacing any of those names it already had). */
export function withParams(callback: string, params: Record<string, string>): string {
  const url = new URL(callback);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** What an answer sends back: its value as shown, cut to a few hundred characters, and the value itself when it is a plain one. */
export function answerParams(shown: string, value: unknown): Record<string, string> {
  const result = shown.length > MAX_ANSWER ? `${shown.slice(0, MAX_ANSWER - 1)}…` : shown;
  const plain = typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= MAX_ANSWER);
  return plain ? { result, value: String(value) } : { result };
}

const MAX_ANSWER = 200;

/**
 * What a link asks: the app it names, the shortcut to run, the key it carries, and every other
 * parameter, which fills a form's fields.
 */
export function readLink(params: Record<string, string>): { app: string; shortcut: string; key: string | undefined; fields: Record<string, string> } {
  const fields = Object.fromEntries(Object.entries(params).filter(([k]) => !LINK_PARAMS.includes(k)));
  return { app: params.app ?? "", shortcut: params.do ?? "", key: params.key, fields };
}

/** A shortcut's id across the vault, as data.json's keys and a `then` chain name it: `<app path>#<shortcut>`. */
export function shortcutId(path: string, shortcut: string): string {
  return `${path}#${shortcut}`;
}

/** The app note a shortcut id names. */
export function appOfShortcut(id: string): string {
  return id.slice(0, id.lastIndexOf("#"));
}

/** Whether a capture key's names (name → shortcut id) cover this name, while it still reaches the shortcut it was made for. */
export function captureCovers(names: Record<string, string> | undefined, target: { name: string; path: string; shortcut: string }): boolean {
  return !!names && Object.hasOwn(names, target.name) && names[target.name] === shortcutId(target.path, target.shortcut);
}

/**
 * A new key for a shortcut's link: 16 random bytes as URL-safe text. Any web page, email or chat
 * message can send an obsidian:// link; only a link copied in Obsidian carries the key, and only
 * such a link runs without asking.
 */
export function newLinkKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What copying a shortcut's link tells: which link, how a form's fields are filled, and what stops it. */
export function linkNotice(s: ShortcutLink): string {
  if (s.answers) {
    const parts = [`Copied the link that answers with “${s.label}” from ${s.app}. Use it in an app that opens x-callback-url links (Shortcuts' Open X-Callback URL); the value comes back as result.`];
    if (!s.allowed) parts.push(`Open ${s.app} once to allow it; until then the link is refused.`);
    return parts.join(" ");
  }
  const parts = [`Copied the link to “${s.label}” in ${s.app}.`];
  const fillable = s.fields.filter((f) => !LINK_PARAMS.includes(f));
  if (s.view === "checklist") parts.push("Add &item=… to say which item to tick.");
  else if (fillable.length) parts.push(`Add ${fillable.map((f) => `&${f}=…`).join("")} to fill the form.`);
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

/** The link that runs an app's shortcut, with its key: it names the app by name, or by path when another app has that name. */
export function shortcutLink(apps: ReadonlyMap<string, { path: string; name: string }>, path: string, shortcut: string, key: string): string {
  const name = basename(path);
  const app = appsNamed(apps, name).length === 1 ? name : path.replace(/\.md$/i, "");
  return `${GIZMO_LINK}?app=${encodeURIComponent(app)}&do=${encodeURIComponent(shortcut)}&key=${encodeURIComponent(key)}`;
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
    // What a value typed in another unit was, with the rate it was converted at (see units.ts).
    if ((info?.[name]?.unit !== undefined || info?.[name]?.unitBy) && typeof params[asField(name)] === "string") row[asField(name)] = params[asField(name)];
  }
  return { row };
}

/**
 * The checklist item a link or a capture line names with `item`: the one with that text, else the
 * only one starting with it, case aside. A checklist takes no other values.
 */
export function pickItem(items: readonly string[], params: Record<string, string>): { row: Row } | { error: string } {
  const extra = Object.keys(params).filter((k) => k !== "item");
  if (extra.length) return { error: `a checklist takes only item, not ${extra.join(", ")}` };
  const raw = (params.item ?? "").trim();
  if (!raw) return { error: "say which item to tick: item=…" };
  const word = raw.toLowerCase();
  const exact = items.find((i) => i.toLowerCase() === word);
  if (exact !== undefined) return { row: { item: exact } };
  const starting = items.filter((i) => i.toLowerCase().startsWith(word));
  if (starting.length === 1) return { row: { item: starting[0] } };
  return { error: starting.length ? `“${raw}” could be ${starting.join(" or ")}` : `no item “${raw}”; the items are ${items.join(", ")}` };
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

/** The link a phone's shortcut or a launcher opens with a capture line after `line=`. */
export function captureLinkOf(key: string): string {
  return `${GIZMO_LINK}?key=${encodeURIComponent(key)}&line=`;
}
