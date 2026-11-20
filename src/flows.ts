import { namesInTemplate } from "./data.ts";
import { selectOf, typedName } from "./expand.ts";
import { fieldsRead } from "./formula.ts";
import { isPlainObject } from "./keys.ts";
import {
  clearance, fieldLabel, hostLabel, join, noteLabels, rank, released, scopeLabels, topLabel, vaultLabels,
  type Label, type Labels, type Policy,
} from "./policy.ts";
import { sourceDef } from "./sources/registry.ts";
import { urlHost } from "./sources/url.ts";
import { saveTarget, type AppSpec, type Panel } from "./spec.ts";
import type { NoteReader } from "./expand.ts";
import { basename, dataPathOf, notePath, storeTarget } from "./store.ts";
import { InputRef, InputText, THIS } from "./template.ts";

/** What the flow check needs to know about where an app runs. */
export interface FlowContext {
  policy: Policy;
  appPath: string;
  /** The note its saved lists are read from and written to. */
  dataPath: string;
  /** The note `$this` reads: the app note, or the note an embed sits in. */
  hostPath: string;
  /** A lens's `for` scope: `$this` is any note there. */
  lensScope?: string;
  tags(path: string): string[];
  /** The data note of the app a `then` names, as its link resolves from this app; undefined when there's none. */
  thenData(app: string): string | undefined;
}

/** Data going somewhere its label may not go: what it is and its label, where to and what that place is cleared for. */
export interface Violation {
  panel: string;
  what: string;
  label: Label;
  to: string;
  cleared: Label | "nothing";
}

/**
 * What the policy says of an app: the flows it refuses (then the app doesn't run), the permissions
 * it covers (granted without asking) and the ones still asked for.
 */
export interface Verdict {
  violations: Violation[];
  covered: string[];
  asked: string[];
}

/** Where an app runs, for the flow check: its note, its data note, the note `$this` reads, a lens's scope. */
export interface FlowWhere {
  appPath: string;
  dataPath: string;
  hostPath: string;
  lensScope?: string;
}

/** A flow context from the vault's readers. */
export function flowContext(
  policy: Policy, where: FlowWhere, notes: NoteReader, storePath: (store: string, from: string) => string, tags: (path: string) => string[],
): FlowContext {
  return { policy, ...where, tags, thenData: (app) => thenDataPath(notes, storePath, app, where.appPath) };
}

/** The data note of the app a `then` names, as its link resolves from `from`; undefined when there's no such note. */
export function thenDataPath(notes: NoteReader, storePath: (store: string, from: string) => string, app: string, from: string): string | undefined {
  const path = notes.resolve(storeTarget(app), from);
  if (!path) return undefined;
  const store = notes.frontmatter(path)?.store;
  return dataPathOf(typeof store === "string" ? store : undefined, path, storePath);
}

/** A violation as one line: `Medication log data.med (private) → a notice (personal)`. */
export function violationText(v: Violation): string {
  return `${v.panel}: ${v.what} (${v.label}) → ${v.to} (${v.cleared === "nothing" ? "cleared for nothing" : v.cleared})`;
}

/** Names a template fills that come from the time, or from the note a save just made. */
const STAMPS = new Set(["date", "time", "at", "path"]);

/** A place data goes, with how it's named in a violation. */
const PLACES: Record<string, string> = { notify: "a notice", pin: "the status bar", answer: "a link's answer", images: "image cells", gizmod: "gizmod's answers" };

function placeName(place: string): string {
  return PLACES[place] ?? place;
}

const merged = (a: Labels, b: Labels): Labels => {
  const fields = { ...a.fields };
  for (const [f, l] of Object.entries(b.fields)) fields[f] = fields[f] ? join(fields[f], l) : l;
  return { base: join(a.base, b.base), fields };
};

/** Which fields a stage's keys read to choose, order or group rows: what they hold shows in what's kept. */
function chosenBy(stage: Partial<Panel>): string[] {
  const out: string[] = [];
  for (const map of [stage.where, stage.of]) if (isPlainObject(map)) out.push(...Object.keys(map));
  if (stage.group) out.push(stage.group);
  if (stage.sort) out.push(...stage.sort.split(",").map((s) => s.trim().replace(/^-/, "")));
  return out.map((f) => f.split(".")[0]).filter(Boolean);
}

/**
 * Checks an app's flows against the policy: every field of every panel gets a label from where it
 * comes from (its note, folder, tag or website, through blocks, formulas and what chooses its
 * rows), and every place a panel sends data (a website, a notice, the status bar, a link's answer,
 * another app, a note) takes only what it is cleared for. `wanted` is the app's permissions.
 */
export function checkFlows(spec: AppSpec, wanted: readonly string[], ctx: FlowContext): Verdict {
  const { policy } = ctx;
  const violations: Violation[] = [];
  const goodSends = new Set<string>();
  const badSends = new Set<string>();
  const dataLabels = merged(noteLabels(policy, ctx.dataPath, ctx.tags(ctx.dataPath)), noteLabels(policy, ctx.appPath, ctx.tags(ctx.appPath)));
  const thisLabels = ctx.lensScope ? scopeLabels(policy, ctx.lensScope) : noteLabels(policy, ctx.hostPath, ctx.tags(ctx.hostPath));
  const running = [...spec.panels, ...Object.values(spec.recorded)];

  /** The labels of a source's data, before a panel's own keys. */
  const sourceLabels = (p: Panel): Labels => {
    if (!p.source) return { base: "public", fields: {} };
    switch (sourceDef(p.source).id) {
      case "list": return dataLabels;
      case "notes": case "tasks": return p.from ? scopeLabels(policy, p.from) : vaultLabels(policy);
      case "base": return vaultLabels(policy);
      case "file": return noteLabels(policy, notePath(p.source), ctx.tags(notePath(p.source)));
      case "this": return thisLabels;
      case "url": {
        // What a website answers to a request made with a secret or a body is about you.
        const own = (p.secrets?.length ?? 0) > 0 || p.body !== undefined;
        return { base: hostLabel(policy, urlHost(p.source)) ?? (own ? "private" : "public"), fields: {} };
      }
      default: return { base: "personal", fields: {} };
    }
  };

  /** A panel's rows as labels: its source's, through the stages of the blocks above it and its own keys. */
  const rowLabels = (p: Panel): Labels => {
    let l = sourceLabels(p);
    for (const stage of [...(p.upstream ?? []), p]) {
      if (stage.compute) {
        const fields = { ...l.fields };
        for (const [name, text] of Object.entries(stage.compute)) {
          const read = fieldsRead(String(text));
          fields[name] = read === undefined || read === "*" ? topLabel(l) : read.map((f) => fieldLabel(l, f)).reduce(join, "public");
        }
        l = { base: l.base, fields };
      }
      const chosen = chosenBy(stage).map((f) => fieldLabel(l, f)).reduce(join, l.base);
      l = { base: chosen, fields: l.fields };
    }
    return l;
  };

  /** The one value a panel shows (a number, a progress bar): its field's label, or the rows' as a count. */
  const valueLabel = (p: Panel, l: Labels): Label => (p.field ? fieldLabel(l, p.field) : l.base);

  const selected = new Map<string, Labels>();
  for (const ps of spec.panels) {
    const name = selectOf(ps.template);
    if (name !== undefined && spec.selections.includes(name)) selected.set(name, rowLabels(ps.panel));
  }

  const check = (panel: string, what: string, label: Label, place: string, cleared: Label | undefined) => {
    if (cleared !== undefined && rank(label) <= rank(cleared)) return;
    violations.push({ panel, what, label, to: placeName(place), cleared: cleared ?? "nothing" });
  };

  for (const ps of running) {
    const p = ps.panel;
    const title = p.title ?? p.label ?? p.view;
    const where = ps.label || title;
    const rows = rowLabels(p);
    const from = sourceName(p, ctx);
    const formFields = new Set(p.view === "form" ? Object.keys(p.fields ?? p.schema ?? {}) : []);

    /** A name a template on this panel fills, as labels: typed into its form, a stamp, or a field of its rows. */
    const nameLabel = (name: string): Label => {
      if (STAMPS.has(name)) return "public";
      if (formFields.has(name)) return policy.typed;
      if (name === "value") return valueLabel(p, rows);
      return p.source ? fieldLabel(rows, name) : "public";
    };
    const templateLabel = (text: string | undefined): Label => (text ? namesInTemplate(text).map(nameLabel).reduce(join, "public") : "public");
    const fieldsWhat = (text: string) => {
      const names = namesInTemplate(text).filter((n) => !STAMPS.has(n) && !formFields.has(n));
      return names.length ? `${from}: ${names.join(", ")}` : from;
    };

    // A request: what it carries from a note, a picked row or a text input, to its website.
    if (p.source && sourceDef(p.source).id === "url") {
      const host = urlHost(p.source);
      const typed = new Set(spec.inputs.filter((d) => d.kind === "text").map((d) => d.name));
      const walk = (v: unknown): void => {
        if (v instanceof InputRef) {
          const path = v.path ? `.${v.path}` : "";
          const field = v.path?.split(".")[0] ?? "";
          let label: Label | undefined;
          let what = "";
          let perm = "";
          if (v.input === THIS) {
            label = field ? fieldLabel(thisLabels, field) : topLabel(thisLabels);
            what = `${ctx.lensScope ? `notes in ${ctx.lensScope}` : basename(ctx.hostPath)}${path}`;
            perm = `this${path}`;
          } else if (selected.has(v.input)) {
            const picked = selected.get(v.input)!;
            label = field ? fieldLabel(picked, field) : topLabel(picked);
            what = `the picked ${typedName(v.input)}${path}`;
            perm = `picked.${typedName(v.input)}${path}`;
          } else if (typed.has(v.input)) {
            label = policy.typed;
            what = `what you type in ${v.input}`;
            perm = `typed.${v.input}`;
          }
          if (!label) return;
          const send = `send:${host}|${perm}`;
          const cleared = clearance(policy, host);
          // A website the policy doesn't list may still be allowed by asking, for data no more than personal.
          const fits = cleared !== undefined ? rank(label) <= rank(cleared) : rank(label) <= rank("personal");
          if (fits && cleared !== undefined) goodSends.add(send);
          if (!fits) {
            badSends.add(send);
            check(where, what, label, host, cleared ?? "personal");
          }
        } else if (v instanceof InputText) v.parts.forEach(walk);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (isPlainObject(v) && !(v instanceof Date)) Object.values(v).forEach(walk);
      };
      for (const key of ["source", "headers", "body"]) walk(ps.template[key]);
    }

    if (p.notify && !released(policy, ctx.appPath, title, "notify")) check(where, fieldsWhat(p.notify), templateLabel(p.notify), "notify", clearance(policy, "notify"));
    const value = valueLabel(p, rows);
    const valueWhat = `${from}${p.field ? `.${p.field}` : ""}`;
    if (p.alert !== undefined && !released(policy, ctx.appPath, title, "notify")) check(where, valueWhat, typeof p.alert === "string" ? value : rows.base, "notify", clearance(policy, "notify"));
    if (p.pin && !released(policy, ctx.appPath, title, "pin")) check(where, valueWhat, value, "pin", clearance(policy, "pin"));
    if (p.shortcut !== undefined && (p.view === "number" || p.view === "progress") && !released(policy, ctx.appPath, title, "answer")) {
      check(where, valueWhat, value, "answer", clearance(policy, "answer"));
    }
    for (const [field, cell] of Object.entries(p.cells ?? {})) if (cell === "image") check(where, `${from}.${field}`, fieldLabel(rows, field), "images", clearance(policy, "images"));

    // Writes: what goes into a note keeps its label only if the note is labelled as high.
    if (p.then?.fill) {
      const target = ctx.thenData(p.then.app);
      const fills = Object.values(p.then.fill).map(String);
      if (target) {
        const label = fills.map(templateLabel).reduce(join, "public");
        check(where, fills.map(fieldsWhat).join(", "), label, `${basename(target)} (through then)`, noteLabels(policy, target, ctx.tags(target)).base);
      }
    }
    const target = p.target ?? (p.save && p.view !== "checklist" ? saveTarget(p.save) : undefined);
    // What a save writes, field by field: `row`'s values, else the whole row a row action was pressed on, else a form's typing.
    const saved: Labels = p.row
      ? { base: "public", fields: Object.fromEntries(Object.entries(p.row).map(([k, t]) => [k, templateLabel(String(t))])) }
      : p.action && p.source ? { base: rows.base, fields: Object.fromEntries(Object.keys(rows.fields).map((f) => [f, fieldLabel(rows, f)])) }
        : { base: p.view === "form" ? policy.typed : "public", fields: {} };
    /** A save into notes labelled `into`: each field it writes may hold no more than the notes' own label for that field. */
    const intoNotes = (place: string, into: Labels) => {
      if (rank(saved.base) > rank(into.base)) check(where, from, saved.base, place, into.base);
      for (const [f, l] of Object.entries(saved.fields)) if (rank(l) > rank(fieldLabel(into, f))) check(where, `${from}: ${f}`, l, place, fieldLabel(into, f));
    };
    if (target?.kind === "list") intoNotes(basename(ctx.dataPath), dataLabels);
    if (target?.kind === "folder") intoNotes(`notes in ${target.folder}`, scopeLabels(policy, target.folder));
    if (p.append) {
      const into = notePath(p.append);
      const label = p.line ? templateLabel(p.line) : topLabel(saved);
      check(where, p.line ? fieldsWhat(p.line) : from, label, `the note ${basename(into)}`, noteLabels(policy, into, ctx.tags(into)).base);
    }
  }

  const covered: string[] = [];
  const asked: string[] = [];
  for (const perm of wanted) {
    const [kind, ...rest] = perm.split(":");
    const what = rest.join(":");
    const ok = kind === "read" || (kind === "net" && Object.hasOwn(policy.sinks, what.toLowerCase())) || (kind === "send" && goodSends.has(perm) && !badSends.has(perm));
    (ok ? covered : asked).push(perm);
  }
  return { violations, covered, asked };
}

/** Where a panel's data comes from, as a violation names it. */
function sourceName(p: Panel, ctx: FlowContext): string {
  if (!p.source) return p.view === "form" ? "what you type" : "the panel";
  switch (sourceDef(p.source).id) {
    case "list": return basename(ctx.dataPath);
    case "notes": case "tasks": return p.from ? `notes in ${p.from}` : "notes anywhere";
    case "base": return "a base";
    case "file": return basename(notePath(p.source));
    case "this": return ctx.lensScope ? `notes in ${ctx.lensScope}` : basename(ctx.hostPath);
    case "url": return urlHost(p.source);
    default: return p.source;
  }
}
