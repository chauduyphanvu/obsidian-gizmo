import { editableSource } from "./edit.ts";
import { typedName } from "./expand.ts";
import { isPlainObject } from "./keys.ts";
import { sourceDef } from "./sources/registry.ts";
import { urlHost } from "./sources/url.ts";
import type { AppSpec, Panel, PanelSpec } from "./spec.ts";
import { notePath, splitFolder, storeTarget } from "./store.ts";
import { InputRef, InputText, THIS } from "./template.ts";

/** A panel's permissions, each with the key that asks for it. */
function panelPermissions(p: Panel, selfPath: string): [string, keyof Panel][] {
  const out: [string, keyof Panel][] = p.source ? sourceDef(p.source).permissions(p, selfPath) : [];
  if (p.append && notePath(p.append) !== selfPath) out.push([`write:${notePath(p.append)}`, "append"]);
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
  // The browser fetches an image from whatever host the row's data names, so no host can be settled from the keys.
  if (Object.values(p.cells ?? {}).includes("image")) out.push(["images", "cells"]);
  // A board moves cards by changing their group field, so it edits without an `edit` key.
  if (p.edit?.length) out.push(...editPermissions(p, "edit"));
  else if (p.view === "board") out.push(...editPermissions(p, "group"));
  return out;
}

/** A line break, tab or other control character: it would make one permission read as several lines of a prompt. */
const CONTROL = /[\u0000-\u001f\u007f]/;

export const CONTROL_PROBLEM = "can't hold a line break or other control character";

/** Whether text holds a control character (see CONTROL). */
export function hasControl(text: string): boolean {
  return CONTROL.test(text);
}

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
  return [...spec.panels, ...Object.values(spec.recorded)];
}

/** What an app is allowed to do, as stable strings. Writes to the note itself need no grant. */
export function permissionsOf(spec: AppSpec, selfPath: string): string[] {
  const out = new Set<string>();
  for (const ps of running(spec)) {
    for (const [perm] of panelPermissions(ps.panel, selfPath)) out.add(perm);
    for (const perm of sendPermissions(ps, spec)) out.add(perm);
  }
  if (spec.store) out.add(`store:${notePath(storeTarget(spec.store))}`);
  if (spec.split) out.add(`split:${splitFolder(spec.store, selfPath)}`);
  return [...out].sort();
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
  // Blocks that record are the app's own.
  for (const ps of Object.values(spec.recorded)) {
    for (const [perm] of panelPermissions(ps.panel, selfPath)) add(perm, selfPath);
    for (const perm of sendPermissions(ps, spec)) add(perm, selfPath);
  }
  if (spec.store) add(`store:${notePath(storeTarget(spec.store))}`, selfPath);
  if (spec.split) add(`split:${splitFolder(spec.store, selfPath)}`, selfPath);
  return out;
}

/**
 * The permission changing a panel's rows needs, asked by `key`: notes in its `from` (any note,
 * for a base), or ticking tasks in its `from`; a saved list is the app's own.
 */
export function editPermissions(p: Panel, key: keyof Panel): [string, keyof Panel][] {
  if (editableSource(p) === "tasks") return p.from ? [[`tasks:${p.from}`, key]] : [];
  if (editableSource(p) === "notes" && sourceDef(p.source!).id === "base") return [["edit:*", key]];
  return editableSource(p) === "notes" && p.from ? [[`edit:${p.from}`, key]] : [];
}

export function describePermission(perm: string): string {
  if (perm === "read:*") return "Read any note in the vault";
  if (perm === "edit:*") return "Change properties of notes anywhere in the vault";
  if (perm === "images") return "Load images from any site (image cells)";
  const [kind, ...rest] = perm.split(":");
  const what = rest.join(":");
  switch (kind) {
    case "send": {
      const cut = what.lastIndexOf("|");
      const [from, ...path] = what.slice(cut + 1).split(".");
      const to = what.slice(0, cut);
      if (from === "typed") return `Send what you type in ${path.join(".")} to ${to}`;
      if (from === "picked") return `Send the picked ${path[0]}${path.length > 1 ? `'s ${path.slice(1).join(".")}` : ""} to ${to}`;
      return `Send the note's ${path.length ? path.join(".") : "properties"} to ${to}`;
    }
    case "net": return `Fetch data from ${what}`;
    case "post": return `Send a request body to ${what}`;
    case "secret": return `Use your saved secret "${what}"`;
    // A file (a template note) or a scope of notes (a folder or #tag).
    case "read": return /\.[A-Za-z0-9]+$/.test(what) ? `Read ${what}` : `Read notes in ${what}`;
    case "write": return `Add lines to ${what}`;
    case "store": return `Save its data in ${what}`;
    case "split": return `Keep a note of its own for each device in ${what}`;
    case "create": return `Create notes in ${what}`;
    case "edit": return `Change properties of notes in ${what}`;
    case "tasks": return `Tick tasks in notes in ${what}`;
    case "answer": return `Send its “${what}” value to the app that opens its link`;
    case "run": {
      const cut = what.lastIndexOf("#");
      return `Run “${what.slice(cut + 1)}” in ${what.slice(0, cut)}`;
    }
    default: return perm;
  }
}
