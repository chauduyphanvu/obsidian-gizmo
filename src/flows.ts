import { namesInTemplate } from "./data.ts";
import { selectOf, typedName } from "./expand.ts";
import { formulaReads } from "./formula.ts";
import { isPlainObject } from "./keys.ts";
import {
  clearance, fieldLabel, hostLabel, join, noteLabels, rank, released, scopeLabels, topLabel, vaultLabels,
  type Label, type Labels, type Policy,
} from "./policy.ts";
import { sourceDef } from "./sources/registry.ts";
import { urlHost } from "./sources/url.ts";
import { readSpec, saveTarget, type AppSpec, type Panel } from "./spec.ts";
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
  /** The app a `then` names, as its link resolves from `from`: its note, data note and keys; undefined when there's none. */
  thenTarget(app: string, from: string): ThenTarget | undefined;
}

/** An app another one runs a shortcut of with `then`. */
export interface ThenTarget {
  path: string;
  dataPath: string;
  spec: AppSpec;
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
  return { policy, ...where, tags, thenTarget: (app, from) => thenTargetOf(notes, storePath, app, from) };
}

/** The app a `then` names, as its link resolves from `from`; undefined when there's no such app. */
export function thenTargetOf(notes: NoteReader, storePath: (store: string, from: string) => string, app: string, from: string): ThenTarget | undefined {
  const path = notes.resolve(storeTarget(app), from);
  const spec = path ? readSpec(notes.frontmatter(path), { notes, path })?.spec : undefined;
  if (!path || !spec) return undefined;
  return { path, dataPath: dataPathOf(spec.store, path, storePath), spec };
}

/** A violation as one line: `Medication log data.med (private) → a notice (personal)`. */
export function violationText(v: Violation): string {
  return `${v.panel}: ${v.what} (${v.label}) → ${v.to} (${v.cleared === "nothing" ? "cleared for nothing" : v.cleared})`;
}

/** Names a template fills that come from the time, or from the note a save just made. */
const STAMPS = new Set(["date", "time", "at", "path"]);

/** How many apps deep a `then` is followed: A runs B, which runs C. */
const THEN_DEPTH = 3;

/** The `$name` references in a key's value as written, however deep. */
function refsIn(v: unknown, out: InputRef[] = []): InputRef[] {
  if (v instanceof InputRef) out.push(v);
  else if (v instanceof InputText) v.parts.forEach((p) => refsIn(p, out));
  else if (Array.isArray(v)) v.forEach((x) => refsIn(x, out));
  else if (isPlainObject(v) && !(v instanceof Date)) Object.values(v).forEach((x) => refsIn(x, out));
  return out;
}

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
      case "file": return noteLabels(policy, filePath(p.source), ctx.tags(filePath(p.source)));
      case "this": return thisLabels;
      case "url": {
        // What a website answers to a request made with a secret or a body is about you.
        const own = (p.secrets?.length ?? 0) > 0 || p.body !== undefined;
        return { base: hostLabel(policy, urlHost(p.source)) ?? (own ? "private" : "public"), fields: {} };
      }
      default: return { base: "personal", fields: {} };
    }
  };

  const typed = new Set(spec.inputs.filter((d) => d.kind === "text").map((d) => d.name));
  const selected = new Map<string, Labels>();

  /** What a `$name` reference reads, as a label, how a violation names it, and the send permission it is part of. */
  const refOf = (v: { input: string; path: string }): { label: Label; what: string; perm: string } | undefined => {
    const path = v.path ? `.${v.path}` : "";
    const field = v.path?.split(".")[0] ?? "";
    if (v.input === THIS) {
      return { label: field ? fieldLabel(thisLabels, field) : topLabel(thisLabels), what: `${ctx.lensScope ? `notes in ${ctx.lensScope}` : basename(ctx.hostPath)}${path}`, perm: `this${path}` };
    }
    const picked = selected.get(v.input);
    if (picked) return { label: field ? fieldLabel(picked, field) : topLabel(picked), what: `the picked ${typedName(v.input)}${path}`, perm: `picked.${typedName(v.input)}${path}` };
    if (typed.has(v.input)) return { label: policy.typed, what: `what you type in ${v.input}`, perm: `typed.${v.input}` };
    return undefined;
  };
  const refsLabel = (v: unknown): Label => refsIn(v).map((r) => refOf(r)?.label ?? "public").reduce(join, "public");

  /** A panel's rows as labels: its source's, through the stages of the blocks above it and its own keys. */
  const rowLabels = (p: Panel): Labels => {
    let l = sourceLabels(p);
    for (const stage of [...(p.upstream ?? []), p]) {
      if (stage.compute) {
        const fields = { ...l.fields };
        for (const [name, text] of Object.entries(stage.compute)) {
          const read = formulaReads(String(text));
          const fromRows = !read || read.fields === "*" ? topLabel(l) : read.fields.map((f) => fieldLabel(l, f)).reduce(join, "public");
          // A formula may read a note's property or a picked row as well as its own row.
          const fromVars = (read?.vars ?? []).map((v) => refOf({ input: v.name, path: v.path })?.label ?? "public").reduce(join, "public");
          fields[name] = join(fromRows, fromVars);
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

  // Twice, so a selection whose formulas read another selection gets that one's labels.
  for (let pass = 0; pass < 2; pass++) {
    for (const ps of spec.panels) {
      const name = selectOf(ps.template);
      if (name !== undefined && spec.selections.includes(name)) selected.set(name, rowLabels(ps.panel));
    }
  }

  const check = (panel: string, what: string, label: Label, place: string, cleared: Label | undefined) => {
    if (cleared !== undefined && rank(label) <= rank(cleared)) return;
    violations.push({ panel, what, label, to: placeName(place), cleared: cleared ?? "nothing" });
  };

  for (const ps of running) {
    const p = ps.panel;
    const title = p.title ?? p.label ?? p.view;
    // Named as the person titled it; a panel without a title by where it is written.
    const where = p.title ?? (ps.label || p.view);
    const rows = rowLabels(p);
    const from = sourceName(p, ctx);
    const formFields = new Set(p.view === "form" ? Object.keys(p.fields ?? p.schema ?? {}) : []);

    /** A name a template on this panel fills, as labels: typed into its form, a stamp, or a field of its rows. */
    const nameLabel = (name: string): Label => {
      if (STAMPS.has(name)) return "public";
      if (formFields.has(name)) return policy.typed;
      // `{value}` is a number's value, or a row's field of that name: either way, the higher label.
      if (name === "value") return join(valueLabel(p, rows), p.source ? fieldLabel(rows, name) : "public");
      return p.source ? fieldLabel(rows, name) : "public";
    };
    /** What a key fills from its `{fields}`, and from the `$references` written in it. */
    const keyLabel = (key: string, text: string | undefined): Label => join(text ? namesInTemplate(text).map(nameLabel).reduce(join, "public") : "public", refsLabel(ps.template[key]));
    const templateLabel = (text: string | undefined): Label => (text ? namesInTemplate(text).map(nameLabel).reduce(join, "public") : "public");
    const fieldsWhat = (text: string, key?: string) => {
      const names = namesInTemplate(text).filter((n) => !STAMPS.has(n) && !formFields.has(n));
      const refs = key ? refsIn(ps.template[key]).flatMap((r) => { const o = refOf(r); return o && o.label !== "public" ? [o.what] : []; }) : [];
      return [...(names.length ? [`${from}: ${names.join(", ")}`] : []), ...refs].join(", ") || from;
    };

    // A request: what it carries from a note, a picked row or a text input, to its website.
    if (p.source && sourceDef(p.source).id === "url") {
      const host = urlHost(p.source);
      const cleared = clearance(policy, host);
      for (const key of ["source", "headers", "body"]) {
        for (const r of refsIn(ps.template[key])) {
          const o = refOf(r);
          if (!o) continue;
          const send = `send:${host}|${o.perm}`;
          // A website the policy doesn't list may still be allowed by asking, for data no more than personal.
          const fits = cleared !== undefined ? rank(o.label) <= rank(cleared) : rank(o.label) <= rank("personal");
          if (fits && cleared !== undefined) goodSends.add(send);
          if (!fits) {
            badSends.add(send);
            check(where, o.what, o.label, host, cleared ?? "personal");
          }
        }
      }
    }

    if (p.notify && !released(policy, ctx.appPath, title, "notify")) check(where, fieldsWhat(p.notify, "notify"), keyLabel("notify", p.notify), "notify", clearance(policy, "notify"));
    const value = valueLabel(p, rows);
    const valueWhat = `${from}${p.field ? `.${p.field}` : ""}`;
    if (p.alert !== undefined && !released(policy, ctx.appPath, title, "notify")) check(where, valueWhat, typeof p.alert === "string" ? value : rows.base, "notify", clearance(policy, "notify"));
    if (p.pin && !released(policy, ctx.appPath, title, "pin")) check(where, valueWhat, value, "pin", clearance(policy, "pin"));
    if (p.shortcut !== undefined && (p.view === "number" || p.view === "progress") && !released(policy, ctx.appPath, title, "answer")) {
      check(where, valueWhat, value, "answer", clearance(policy, "answer"));
    }
    if (!released(policy, ctx.appPath, title, "images")) {
      for (const [field, cell] of Object.entries(p.cells ?? {})) if (cell === "image") check(where, `${from}.${field}`, fieldLabel(rows, field), "images", clearance(policy, "images"));
    }

    // Through `then`, what it fills goes on into the other app, and wherever that app sends it.
    if (p.then?.fill) {
      const fill = isPlainObject(ps.template.then) && isPlainObject(ps.template.then.fill) ? ps.template.then.fill : {};
      const labels = Object.fromEntries(Object.entries(p.then.fill).map(([k, t]) => [k, join(templateLabel(String(t)), refsLabel(fill[k]))]));
      const what = [...new Set(Object.entries(p.then.fill).flatMap(([k, t]) => {
        const names = namesInTemplate(String(t)).filter((n) => !STAMPS.has(n) && !formFields.has(n));
        const refs = refsIn(fill[k]).flatMap((r) => { const o = refOf(r); return o && o.label !== "public" ? [o.what] : []; });
        return [...(names.length ? [`${from}: ${names.join(", ")}`] : []), ...refs];
      }))].join(", ") || from;
      followThen(where, what, p.then, labels, ctx.appPath, 1);
    }
    const target = p.target ?? (p.save && p.view !== "checklist" ? saveTarget(p.save) : undefined);
    // What a save writes, field by field: `row`'s values, else the whole row a row action was pressed on, else a form's typing.
    const rowKeys = isPlainObject(ps.template.row) ? ps.template.row : {};
    const saved: Labels = p.row
      ? { base: "public", fields: Object.fromEntries(Object.entries(p.row).map(([k, t]) => [k, join(templateLabel(String(t)), refsLabel(rowKeys[k]))])) }
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
      const label = join(p.line ? keyLabel("line", p.line) : topLabel(saved), refsLabel(ps.template.append));
      check(where, p.line ? fieldsWhat(p.line, "line") : from, label, `the note ${basename(into)}`, noteLabels(policy, into, ctx.tags(into)).base);
    }
  }

  /**
   * Follows a `then` into the app it runs: the fields it fills carry their labels into that app's
   * shortcut, which may save them, tell them in a notice, add them to a note or fill another app
   * in turn. Each place takes only what it is cleared for, as if the first app sent it there.
   */
  function followThen(where: string, what: string, then: { app: string; do: string }, fields: Record<string, Label>, from: string, depth: number): void {
    const t = ctx.thenTarget(then.app, from);
    const ps = t?.spec.panels.find((x) => x.panel.shortcut === then.do);
    if (!t || !ps) return;
    const q = ps.panel;
    const via = `${basename(t.path)} (through then)`;
    const label = (text: string | undefined) => (text ? namesInTemplate(text).map((n) => fields[n] ?? "public").reduce(join, "public") : "public");
    const into = merged(noteLabels(policy, t.dataPath, ctx.tags(t.dataPath)), noteLabels(policy, t.path, ctx.tags(t.path)));
    const saveTo = q.target ?? (q.save && q.view !== "checklist" ? saveTarget(q.save) : undefined);
    const saved = q.row ? Object.fromEntries(Object.entries(q.row).map(([k, v]) => [k, label(String(v))])) : fields;
    const notes = saveTo?.kind === "list" ? into : saveTo?.kind === "folder" ? scopeLabels(policy, saveTo.folder) : undefined;
    if (notes) for (const [f, l] of Object.entries(saved)) if (rank(l) > rank(fieldLabel(notes, f))) check(where, what, l, via, fieldLabel(notes, f));
    if (q.notify && !released(policy, t.path, q.title ?? q.label ?? q.view, "notify")) {
      const l = label(q.notify);
      if (rank(l) > rank(clearance(policy, "notify")!)) check(where, what, l, `a notice from ${basename(t.path)} (through then)`, clearance(policy, "notify"));
    }
    if (q.append) {
      const note = notePath(q.append);
      const l = q.line ? label(q.line) : Object.values(saved).reduce(join, "public");
      check(where, what, l, `the note ${basename(note)} (through then)`, noteLabels(policy, note, ctx.tags(note)).base);
    }
    if (q.then?.fill && depth < THEN_DEPTH) {
      followThen(where, what, q.then, Object.fromEntries(Object.entries(q.then.fill).map(([k, v]) => [k, label(String(v))])), t.path, depth + 1);
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

/** The file a `file` source reads: its path, or the link as written. */
function filePath(source: string): string {
  return source.replace(/^\[\[|\]\]$/g, "");
}

/** Where a panel's data comes from, as a violation names it. */
function sourceName(p: Panel, ctx: FlowContext): string {
  if (!p.source) return p.view === "form" ? "what you type" : "the panel";
  switch (sourceDef(p.source).id) {
    case "list": return basename(ctx.dataPath);
    case "notes": case "tasks": return p.from ? `notes in ${p.from}` : "notes anywhere";
    case "base": return "a base";
    case "file": return basename(filePath(p.source));
    case "this": return ctx.lensScope ? `notes in ${ctx.lensScope}` : basename(ctx.hostPath);
    case "url": return urlHost(p.source);
    default: return p.source;
  }
}
