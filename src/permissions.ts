import { hasControl } from "./control.ts";
import { editableSource } from "./edit.ts";
import { typedName } from "./expand.ts";
import { isPlainObject } from "./keys.ts";
import { sourceDef } from "./sources/registry.ts";
import { urlHost } from "./sources/url.ts";
import type { AppSpec, Panel, PanelSpec } from "./spec.ts";
import { appendPath, basename, defaultDataPath, notePath, storeTarget } from "./store.ts";
import { InputRef, InputText, THIS } from "./template.ts";

/** A panel's permissions, each with the key that asks for it. */
function panelPermissions(p: Panel, selfPath: string): [string, keyof Panel][] {
  const out: [string, keyof Panel][] = p.source ? sourceDef(p.source).permissions(p, selfPath) : [];
  if (p.append && appendPath(p.append) !== selfPath) out.push([`write:${appendPath(p.append)}`, "append"]);
  // Named as typed, like the notes it writes: the app it names is looked up when it runs.
  if (p.then) out.push([`run:${storeTarget(p.then.app)}#${p.then.do}`, "then"]);
  // Its link sends the panel's value out of Obsidian, to whatever app opened it.
  if (p.shortcut !== undefined && (p.view === "number" || p.view === "progress")) out.push([`answer:${p.shortcut}`, "shortcut"]);
  // A lens writes the properties of whichever note in its scope it is shown on.
  if (p.target?.kind === "this" && p.target.scope) out.push([`edit:${p.target.scope}`, "save"]);
  if (p.target?.kind === "folder") {
    out.push([`create:${p.target.folder}`, "save"]);
    if (p.template) out.push([`read:${notePath(storeTarget(p.template))}`, "template"]);
  }
  // Saving to a kind adds to rows other apps read; it reads them too, to guess what a line leaves out.
  if (p.target?.kind === "list" && p.target.at !== undefined && p.target.at !== selfPath) {
    out.push([`kind:${p.target.at}`, "save"], [`kind-write:${p.target.at}`, "save"]);
  }
  // Accept and Not mine on the reconcile card change the kind's rows.
  if (p.view === "reconcile" && p.kind && p.kind.path !== selfPath) out.push([`kind-write:${p.kind.path}`, "source"]);
  // The browser fetches an image from whatever host the row's data names, so no host can be settled from the keys.
  if (Object.values(p.cells ?? {}).includes("image")) out.push(["images", "cells"]);
  // A board moves cards by changing their group field, so it edits without an `edit` key.
  if (p.edit?.length) out.push(...editPermissions(p, "edit", selfPath));
  else if (p.view === "board") out.push(...editPermissions(p, "group", selfPath));
  return out;
}

/** Why a key can't hold a control character: it would make one permission read as several lines of a prompt. */
export const CONTROL_PROBLEM = "can't hold a line break or other control character";

/** The key that asks for a permission holding a control character, if any: such a panel isn't drawn. */
export function controlKey(p: Panel, selfPath: string): keyof Panel | undefined {
  return panelPermissions(p, selfPath).find(([perm]) => hasControl(perm))?.[1];
}

/**
 * What a web request carries that comes from someone rather than the app's keys, as
 * `send:<host>|<what>`: a note's property (`this.<path>`), a picked row (`picked.<name>[.<path>]`)
 * or typed text (`typed.<name>`), wherever it goes in the address, the headers or the body. A
 * dropdown's or date bar's value is one the app's author typed or a date, and isn't named.
 */
function sendPermissions(ps: PanelSpec, spec: Pick<AppSpec, "inputs" | "selections">): string[] {
  const source = ps.panel.source;
  if (!source || sourceDef(source).id !== "url") return [];
  const host = urlHost(source);
  const typed = new Set(spec.inputs.filter((d) => d.kind === "text").map((d) => d.name));
  const picked = new Set(spec.selections);
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (v instanceof InputRef) {
      const path = v.path ? `.${v.path}` : "";
      const what = v.input === THIS ? `this${path}` : picked.has(v.input) ? `picked.${typedName(v.input)}${path}` : typed.has(v.input) ? `typed.${v.input}` : undefined;
      if (what) out.add(`send:${host}|${what}`);
    } else if (v instanceof InputText) {
      v.parts.forEach(walk);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (isPlainObject(v) && !(v instanceof Date)) {
      Object.values(v).forEach(walk);
    }
  };
  for (const key of ["source", "headers", "body"]) walk(ps.template[key]);
  return [...out];
}

/**
 * Everything that runs for an app: its panels, and its recorded blocks, which are fetched even when
 * no panel shows them. What it may do is asked from exactly these.
 */
function running(spec: AppSpec): PanelSpec[] {
  return [...spec.panels, ...Object.values(spec.recorded), ...Object.values(spec.expected)];
}

/** What an app is allowed to do, as stable strings. Writes to the note itself need no grant. */
export function permissionsOf(spec: AppSpec, selfPath: string): string[] {
  const out = new Set<string>();
  for (const ps of running(spec)) {
    for (const [perm] of panelPermissions(ps.panel, selfPath)) out.add(perm);
    for (const perm of sendPermissions(ps, spec)) out.add(perm);
  }
  if (spec.store) out.add(`store:${notePath(storeTarget(spec.store))}`);
  for (const perm of importPermissions(spec)) out.add(perm);
  for (const perm of sharePermissions(spec)) out.add(perm);
  for (const perm of sealPermissions(spec)) out.add(perm);
  return [...out].sort();
}

/** A shared kind sends and takes rows through its relay, with the key its secret holds. */
function sharePermissions(spec: AppSpec): string[] {
  const share = spec.kind?.share;
  return share ? [`share:${spec.kind!.path}|${share.host}`, `secret:${share.secret}`] : [];
}

/** A kind sealed with an authority sends it a hash of its event logs; sealing on this device alone sends nothing and asks nothing. */
function sealPermissions(spec: AppSpec): string[] {
  const seal = spec.kind?.seal;
  return seal?.host ? [`seal:${spec.kind!.path}|${seal.host}`] : [];
}

/** A kind reads the new files in each folder its `import:` names. */
function importPermissions(spec: AppSpec): string[] {
  return (spec.kind?.imports ?? []).flatMap((m) => (m.folder === undefined ? [] : [`read:${m.folder}`]));
}

/** For each permission, the notes whose keys ask for it: the app itself or the components it uses. */
export function askersOf(spec: AppSpec, selfPath: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (perm: string, path: string) => {
    if (!out.has(perm)) out.set(perm, new Set());
    out.get(perm)!.add(path);
  };
  for (const ps of spec.panels) {
    for (const [perm, key] of panelPermissions(ps.panel, selfPath)) add(perm, ps.writtenIn[key] ?? selfPath);
    for (const perm of sendPermissions(ps, spec)) add(perm, ps.writtenIn.source ?? selfPath);
  }
  // Blocks that record, and what the app expects, are the app's own.
  for (const ps of [...Object.values(spec.recorded), ...Object.values(spec.expected)]) {
    for (const [perm] of panelPermissions(ps.panel, selfPath)) add(perm, selfPath);
    for (const perm of sendPermissions(ps, spec)) add(perm, selfPath);
  }
  if (spec.store) add(`store:${notePath(storeTarget(spec.store))}`, selfPath);
  for (const perm of importPermissions(spec)) add(perm, selfPath);
  for (const perm of sharePermissions(spec)) add(perm, selfPath);
  for (const perm of sealPermissions(spec)) add(perm, selfPath);
  return out;
}

/**
 * The permission changing a panel's rows needs, asked by `key`: notes in its `from` (any note,
 * for a base), ticking tasks in its `from`, or a kind's rows; a saved list is the app's own.
 */
export function editPermissions(p: Panel, key: keyof Panel, selfPath?: string): [string, keyof Panel][] {
  const kind = p.kind;
  if (kind) return kind.path === selfPath ? [] : [[`kind-write:${kind.path}`, key]];
  if (editableSource(p) === "tasks") return p.from ? [[`tasks:${p.from}`, key]] : [];
  if (editableSource(p) === "notes" && sourceDef(p.source!).id === "base") return [["edit:*", key]];
  return editableSource(p) === "notes" && p.from ? [[`edit:${p.from}`, key]] : [];
}

/** Where a permission points on the map's canvas: a node, and the label of the line to it. */
export interface PermissionTarget { side: "in" | "out"; key: string; label: string; file?: string; text: string }

/**
 * One kind of permission (`<kind>:<what>`): how the Allow card says it, where the canvas draws it,
 * and whether it lets an app change a given note (for the map's "who changes this note").
 */
interface PermissionKind {
  describe(what: string): string;
  target?(what: string): PermissionTarget;
  changes?(what: string, path: string, inScope: (scope: string, path: string) => boolean): boolean;
}

/** A host in a `send` permission: what's before its last `|`. */
const sentTo = (what: string) => what.slice(0, what.lastIndexOf("|"));

const PERMISSIONS: Record<string, PermissionKind> = {
  send: {
    describe(what) {
      const cut = what.lastIndexOf("|");
      const [from, ...path] = what.slice(cut + 1).split(".");
      const to = what.slice(0, cut);
      if (from === "typed") return `Send what you type in ${path.join(".")} to ${to}`;
      if (from === "picked") return `Send the picked ${path[0]}${path.length > 1 ? `'s ${path.slice(1).join(".")}` : ""} to ${to}`;
      return `Send the note's ${path.length ? path.join(".") : "properties"} to ${to}`;
    },
    target: (what) => ({ side: "out", key: `host:${sentTo(what)}`, label: "sends to", text: sentTo(what) }),
  },
  net: {
    describe: (what) => `Fetch data from ${what}`,
    target: (what) => ({ side: "in", key: `host:${what}`, label: "fetches", text: what }),
  },
  post: {
    describe: (what) => `Send a request body to ${what}`,
    target: (what) => ({ side: "out", key: `host:${what}`, label: "sends to", text: what }),
  },
  secret: { describe: (what) => `Use your saved secret "${what}"` },
  // A file (a template note) or a scope of notes (a folder or #tag).
  read: {
    describe: (what) => (what === "*" ? "Read any note in the vault" : /\.[A-Za-z0-9]+$/.test(what) ? `Read ${what}` : `Read notes in ${what}`),
    target: (what) => (what === "*" ? { side: "in", key: "notes:*", label: "reads", text: "Every note" }
      : /\.[A-Za-z0-9]+$/.test(what) ? { side: "in", key: `file:${what}`, label: "reads", file: what, text: what }
      : { side: "in", key: `notes:${what}`, label: "reads", text: `Notes in ${what}` }),
  },
  write: {
    describe: (what) => `Add lines to ${what}`,
    target: (what) => ({ side: "out", key: `file:${notePath(what)}`, label: "adds lines", file: notePath(what), text: notePath(what) }),
    changes: (what, path) => notePath(what) === path,
  },
  store: {
    describe: (what) => `Save its data in ${what}`,
    target: (what) => ({ side: "out", key: `file:${what}`, label: "saves data", file: what, text: what }),
    changes: (what, path) => what === path,
  },
  create: {
    describe: (what) => `Create notes in ${what}`,
    target: (what) => ({ side: "out", key: `notes:${what}`, label: "creates notes", text: `Notes in ${what}` }),
    changes: (what, path) => path.startsWith(`${what.replace(/\/+$/, "")}/`),
  },
  edit: {
    describe: (what) => (what === "*" ? "Change properties of notes anywhere in the vault" : `Change properties of notes in ${what}`),
    target: (what) => ({ side: "out", key: `notes:${what}`, label: "changes", text: what === "*" ? "Every note" : `Notes in ${what}` }),
    changes: (what, path, inScope) => what === "*" || inScope(what, path),
  },
  tasks: {
    describe: (what) => `Tick tasks in notes in ${what}`,
    target: (what) => ({ side: "out", key: `notes:${what}`, label: "ticks tasks", text: `Notes in ${what}` }),
    changes: (what, path, inScope) => what === "*" || inScope(what, path),
  },
  // A kind's rows, named by the kind's note: read by any app that links to it, changed by those that save or edit.
  kind: {
    describe: (what) => `Read the rows of ${basename(what)}`,
    target: (what) => ({ side: "in", key: `file:${what}`, label: "reads rows", file: what, text: basename(what) }),
  },
  "kind-write": {
    describe: (what) => `Add and change rows of ${basename(what)}`,
    target: (what) => ({ side: "out", key: `file:${what}`, label: "saves rows", file: what, text: basename(what) }),
    changes: (what, path) => defaultDataPath(what) === path,
  },
  // A shared kind: its note and its relay's host, after the last `|`.
  share: {
    describe(what) {
      const cut = what.lastIndexOf("|");
      return `Share the rows of ${basename(what.slice(0, cut))} through ${what.slice(cut + 1)}: each row you add goes there sealed, and rows from the people you share it with come in`;
    },
    target: (what) => ({ side: "out", key: `host:${what.slice(what.lastIndexOf("|") + 1)}`, label: "shares rows with", text: what.slice(what.lastIndexOf("|") + 1) }),
  },
  // A sealed kind with an authority: its note and the authority's host, after the last `|`.
  seal: {
    describe(what) {
      const cut = what.lastIndexOf("|");
      return `Send a hash of the event logs of ${basename(what.slice(0, cut))} to ${what.slice(cut + 1)} for a time stamp: 32 bytes that give back nothing of the rows`;
    },
    target: (what) => ({ side: "out", key: `host:${what.slice(what.lastIndexOf("|") + 1)}`, label: "asks a time stamp from", text: what.slice(what.lastIndexOf("|") + 1) }),
  },
  answer: { describe: (what) => `Send its “${what}” value to the app that opens its link` },
  run: {
    describe(what) {
      const cut = what.lastIndexOf("#");
      return `Run “${what.slice(cut + 1)}” in ${what.slice(0, cut)}`;
    },
  },
};

/** A permission's kind, and what it's about. */
function kindOf(perm: string): [PermissionKind | undefined, string] {
  const cut = perm.indexOf(":");
  return cut < 0 ? [undefined, ""] : [PERMISSIONS[perm.slice(0, cut)], perm.slice(cut + 1)];
}

export function describePermission(perm: string): string {
  if (perm === "images") return "Load images from any site (image cells)";
  const [kind, what] = kindOf(perm);
  return kind ? kind.describe(what) : perm;
}

/** Where the canvas draws a permission; undefined for one it doesn't draw. */
export function permissionTarget(perm: string): PermissionTarget | undefined {
  const [kind, what] = kindOf(perm);
  return kind?.target?.(what);
}

/** Whether a permission lets an app change the note at `path`. */
export function permissionChanges(perm: string, path: string, inScope: (scope: string, path: string) => boolean): boolean {
  const [kind, what] = kindOf(perm);
  return kind?.changes?.(what, path, inScope) ?? false;
}
