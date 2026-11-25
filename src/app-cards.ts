import { handler } from "./handler.ts";
import type { AppEnv } from "./app.ts";
import { VIEW_HINTS } from "./hints.ts";
import { skeleton } from "./insert.ts";
import type { Op } from "./ledger.ts";
import { describePermission } from "./permissions.ts";
import { askGroup, type AskGroup } from "./map.ts";
import { svg } from "./views/chart.ts";
import { isListName, savedFields, type AppSpec, type ComponentPreview } from "./spec.ts";
import { basename } from "./store.ts";
import { ROW_FIELDS } from "./kind.ts";
import type { Row } from "./data.ts";
import { viewDef } from "./views/registry.ts";
import { labelOf, lineOf } from "./yamlpos.ts";
import { checklistList } from "./panel.ts";

/** What the cards above an app's panels read of the app, and do when they are used. */
export interface CardApp {
  env: AppEnv;
  appPath: string;
  hostPath: string;
  grantKey: string;
  /** In an embed or a lens: not an app note opened on its own. */
  hosted: boolean;
  /** A lens's `for` scope: its grant covers every note there. */
  scope?: string;
  /** Draws the app from scratch, as once it is allowed. */
  load(): void;
}

/** An icon for each kind of thing an app asks to do, drawn as Obsidian's (Lucide) are. */
const ASK_ICONS: Record<AskGroup, string[]> = {
  Reads: ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"],
  Fetches: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z", "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
  Sends: ["M22 2 11 13", "M22 2 15 22 11 13 2 9z"],
  Changes: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"],
  Runs: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
};

function askIcon(parent: Element, perm: string): void {
  const s = svg("svg", {
    class: "gz-ask-icon", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  }, parent);
  for (const d of ASK_ICONS[askGroup(perm)]) svg("path", { d }, s);
}

/**
 * `covered`: how many more of its permissions the data policy grants, so they aren't asked for.
 * Nothing of the app is read or drawn behind it until Allow, or a try on copies of its notes.
 */
export function renderPermissionPrompt(header: HTMLElement, wanted: string[], askers: Map<string, Set<string>>, app: CardApp, covered = 0): void {
  const card = header.createDiv({ cls: "gz-card gz-permission" });
  card.createDiv({ cls: "gz-title", text: "This app needs your OK to:" });
  const ul = card.createEl("ul", { cls: "gz-permission-list" });
  const before = new Set(app.env.granted(app.grantKey));
  for (const p of wanted) {
    const li = ul.createEl("li");
    askIcon(li, p);
    if (before.size && !before.has(p)) li.createSpan({ cls: "gz-new", text: "New" });
    const who = [...(askers.get(p) ?? [])];
    const others = who.filter((path) => path !== app.appPath).map((path) => `[[${basename(path)}]]`);
    const names = [...(others.length && who.includes(app.appPath) ? ["this note"] : []), ...others];
    li.createSpan({ text: describePermission(p) + (others.length ? ` — for ${names.join(", ")}` : "") });
  }
  if (covered) card.createDiv({ cls: "gz-label gz-covered", text: `Your data policy covers ${covered} more.` });
  if (app.scope) card.createDiv({ cls: "gz-label gz-scope", text: `It shows on every note in ${app.scope}; this OK covers all of them.` });
  const row = card.createDiv({ cls: "gz-actions" });
  row.createEl("button", { cls: "mod-cta", text: "Allow" }).addEventListener("click", handler(async () => {
    await app.env.grant(app.grantKey, wanted);
    app.load();
  }));
  // In an embed or a lens `$this` is a real note, which a try must not read; there it isn't offered.
  if (!app.hosted && app.env.tryFirst) row.createEl("button", { text: "Try it first" }).addEventListener("click", () => app.env.tryFirst?.());
  // An embed's keys are in the note it is drawn in, and a lens's in its component.
  if (!app.hosted) row.createEl("button", { text: "Edit source" }).addEventListener("click", () => app.env.showSource());
}

/** A kind an app reads that isn't allowed yet: what allowing it adds, what Allow grants, and whether the data policy blocks it. */
export interface KindToAllow {
  path: string;
  name: string;
  /** What allowing it lets the kind do, in words: each permission it asks for, and its asks in Next. */
  adds: string[];
  /** What the kind's own note would ask for, which Allow grants. */
  asked: string[];
  blocked: boolean;
}

/**
 * A kind the app reads whose own note isn't allowed yet: the app shows its rows, but the kind's own
 * work (reading its import folders, asking in Next) waits until it is. Says what allowing it adds,
 * with Allow, which grants just what the kind's own note asks for, and a way to open the kind.
 */
export function renderKindToAllow(header: HTMLElement, k: KindToAllow, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card gz-kind-allow" });
  card.createDiv({ cls: "gz-title", text: `${k.name} isn't allowed yet` });
  const me = basename(app.appPath);
  card.createDiv({
    cls: "gz-muted",
    text: k.blocked ? `${me} reads the rows of ${k.name}, but your data policy blocks ${k.name}; open it to see why.`
      : `${me} reads the rows of ${k.name}, but ${k.name} runs nothing of its own until you allow it. Allowing it lets ${k.name}:`,
  });
  if (!k.blocked) {
    const ul = card.createEl("ul");
    for (const a of k.adds) ul.createEl("li", { text: a });
  }
  const row = card.createDiv({ cls: "gz-actions" });
  if (!k.blocked) {
    row.createEl("button", { cls: "mod-cta", text: `Allow ${k.name}` }).addEventListener("click", handler(async () => {
      await app.env.grant(k.path, k.asked);
      // Allowed as if its note were opened: it reads its folders now, and its asks come with the next round.
      app.env.opened?.(k.path);
      app.load();
    }));
  }
  row.createEl("button", { text: `Open ${k.name}` }).addEventListener("click", () => app.env.openNote(k.path, app.hostPath));
}

/** An app whose data would go somewhere the data policy keeps it from: it runs nothing, and says each flow. */
export function renderBlocked(header: HTMLElement, violations: string[], pending: boolean, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card gz-error gz-blocked" });
  card.createDiv({ cls: "gz-title", text: "Blocked by your data policy" });
  card.createDiv({ cls: "gz-muted", text: "It runs nothing while it would send data where your policy keeps it from going:" });
  const ul = card.createEl("ul");
  for (const v of violations) ul.createEl("li", { text: v });
  card.createDiv({
    cls: "gz-muted",
    text: pending
      ? "Gizmo policy.md has changes not applied yet; review and apply them from the automation map."
      : "Change the app, or change Gizmo policy.md and apply it from the automation map.",
  });
  if (!app.hosted) card.createDiv({ cls: "gz-actions" }).createEl("button", { text: "Edit source" }).addEventListener("click", () => app.env.showSource());
}

/**
 * The data note was edited by hand since the app last wrote it: the app shows what its log holds,
 * and nothing in the note is taken in until the person says so.
 */
export function renderHandEdit(header: HTMLElement, note: string, changes: string[], act: { import: () => Promise<void>; discard: () => Promise<void> }): HTMLElement {
  const card = header.createDiv({ cls: "gz-card gz-hand-edit" });
  card.createDiv({ cls: "gz-title", text: `${note} was edited by hand` });
  card.createDiv({ cls: "gz-muted", text: "The app shows its data as it keeps it, not as the note says now. The note differs by:" });
  const ul = card.createEl("ul");
  for (const c of changes) ul.createEl("li", { text: c });
  const row = card.createDiv({ cls: "gz-actions" });
  const button = (text: string, cta: boolean, run: () => Promise<void>) => {
    const b = row.createEl("button", { text, ...(cta && { cls: "mod-cta" }) });
    b.addEventListener("click", handler(async () => {
      for (const x of row.querySelectorAll("button")) x.disabled = true;
      await run();
    }));
  };
  button("Import the edit", true, act.import);
  button("Discard it", false, act.discard);
  return card;
}

/**
 * What a hand edit changed, list by list, in words. A list of text is ticked and unticked only when
 * it is one of `checklists`, the lists a checklist panel of the app reads; any other has its items
 * added and removed.
 */
export function editWords(ops: Op[], checklists: ReadonlySet<string>): string[] {
  const by = new Map<string, { added: number; removed: number; changed: Set<string>; ticked: string[]; unticked: string[] }>();
  for (const o of ops) {
    if (!("l" in o)) continue;
    const s = by.get(o.l) ?? { added: 0, removed: 0, changed: new Set(), ticked: [], unticked: [] };
    if (o.op === "add") s.added++;
    else if (o.op === "del") s.removed++;
    else if (o.op === "set") s.changed.add(o.row);
    else if (o.op === "tick") s.ticked.push(o.item);
    else if (o.op === "untick") s.unticked.push(o.item);
    by.set(o.l, s);
  }
  const rows = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
  return [...by].map(([list, s]) => `${list}: ${[
    ...(s.changed.size ? [`${rows(s.changed.size)} changed`] : []),
    ...(s.added ? [`${rows(s.added)} added or changed`] : []),
    ...(s.removed ? [`${rows(s.removed)} taken out or changed`] : []),
    ...(s.ticked.length ? [`${s.ticked.join(", ")} ${checklists.has(list) ? "ticked" : "added"}`] : []),
    ...(s.unticked.length ? [`${s.unticked.join(", ")} ${checklists.has(list) ? "unticked" : "removed"}`] : []),
  ].join("; ")}`);
}

/**
 * A name the app's keys changed while its saved rows kept the old one: a field of a list, a choice of
 * a field, or the list itself; `rows`, how many rows have the old name.
 */
export type Rename =
  | { kind: "field"; list: string; from: string; to: string; rows: number }
  /** `value` is the choice as typed in the keys, which a row is changed to. */
  | { kind: "choice"; list: string; field: string; from: string; to: string; value: unknown; rows: number }
  | { kind: "list"; from: string; to: string; rows: number };

/** What a form saves for a field left empty, which is no choice. */
const blank = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Whether a row still has the old name: it has the old field, even empty as a form saves a field
 * left empty; or the old choice; every row of an old list does.
 */
export function leftBehind(r: Rename, row: Row): boolean {
  if (r.kind === "field") return row[r.from] !== undefined;
  if (r.kind === "choice") return !blank(row[r.field]) && String(row[r.field]) === r.from;
  return true;
}

/** What a rename the person chose to leave as it is is kept under: the app, and exactly what changed. */
export function renameKey(appPath: string, r: Rename): string {
  return [appPath, r.kind, ...(r.kind === "list" ? [] : [r.list]), ...(r.kind === "choice" ? [r.field] : []), r.from, r.to].join("\n");
}

/**
 * The renames the app's saved rows don't follow, each one to one: a single old name the rows have
 * that the keys no longer have, and a single new name the keys have that no row has. With two on
 * either side, nothing is guessed. Fields and choices are only those of lists the app saves to whose
 * fields its keys declare, as the field checker knows them (see savedFields); a list is only looked
 * for in a data note that no other app shares.
 */
export function findRenames(spec: AppSpec, lists: ReadonlyMap<string, { rows: Row[] }>, appFm: Record<string, unknown>): Rename[] {
  const { written, whole } = savedFields(spec.panels, new Map(Object.entries(spec.blocks)), spec.store !== undefined, spec.kind?.path);
  const out: Rename[] = [];
  // What Gizmo keeps on a kind's rows is no field of the person's.
  const kept = (field: string) => spec.kind !== undefined && ROW_FIELDS.includes(field);
  for (const [list, known] of written) {
    const rows = lists.get(list)?.rows ?? [];
    if (whole.has(list) || !rows.length) continue;
    // A field saved empty is still there: an optional field nobody filled in isn't taken for a new name.
    const had = new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined && !kept(k))));
    const gone = [...had].filter((f) => f !== "at" && !known.has(f));
    const fresh = [...known].filter((f) => f !== "at" && !had.has(f));
    if (gone.length === 1 && fresh.length === 1) out.push({ kind: "field", list, from: gone[0], to: fresh[0], rows: rows.filter((r) => r[gone[0]] !== undefined).length });
    for (const [field, choices] of choicesOf(spec, list)) {
      const values = rows.map((r) => r[field]).filter((v) => !blank(v));
      // A list or a map isn't any one choice.
      if (!values.every((v): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v))) continue;
      const counts = new Map<string, number>();
      for (const v of values) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const stray = [...counts.keys()].filter((v) => !choices.some((c) => String(c) === v));
      const unused = choices.filter((c) => !counts.has(String(c)));
      if (stray.length === 1 && unused.length === 1) out.push({ kind: "choice", list, field, from: stray[0], to: String(unused[0]), value: unused[0], rows: counts.get(stray[0])! });
    }
  }
  const moved = listRename(spec, lists, appFm, whole);
  return moved ? [...out, moved] : out;
}

/** Each choice field of the rows a list's writers save, with its choices; one they give different choices for is left out. */
function choicesOf(spec: AppSpec, list: string): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  const mixed = new Set<string>();
  for (const { panel: p } of spec.panels) {
    if (p.target?.kind !== "list" || (p.target.at !== undefined && p.target.at !== spec.kind?.path) || p.target.name !== list) continue;
    for (const [field, type] of [...Object.entries(p.schema ?? {}), ...Object.entries(p.fields ?? {})]) {
      if (!Array.isArray(type)) continue;
      const had = out.get(field);
      if (had && JSON.stringify(had) !== JSON.stringify(type)) mixed.add(field);
      out.set(field, type);
    }
  }
  for (const field of mixed) out.delete(field);
  return out;
}

/** A list of the data note that no panel reads or saves to, whose rows belong in the one list the app saves to that has none. */
function listRename(spec: AppSpec, lists: ReadonlyMap<string, { rows: Row[] }>, appFm: Record<string, unknown>, whole: ReadonlySet<string>): Rename | undefined {
  if (spec.store !== undefined) return undefined;
  const panels = [...spec.panels, ...Object.values(spec.recorded), ...Object.values(spec.expected)];
  const used = new Set(whole);
  const saved = new Set<string>();
  for (const { panel: p } of panels) {
    if (isListName(p.source)) used.add(p.source);
    if (p.view === "checklist") used.add(checklistList(p));
    // A kind's rows are the kind's, kept in its own data note.
    if (p.target?.kind !== "list" || (p.target.at !== undefined && p.target.at !== spec.kind?.path)) continue;
    used.add(p.target.name);
    saved.add(p.target.name);
  }
  const empty = [...saved].filter((l) => !lists.get(l)?.rows.length);
  // A list typed in the app note is the app's own, not one left in the data note.
  const unread = [...lists].filter(([name, l]) => l.rows.length && !used.has(name) && !Object.hasOwn(appFm, name));
  // A list whole rows are saved to (an archive) is often empty; it isn't where a renamed list went.
  if (empty.length !== 1 || unread.length !== 1 || whole.has(empty[0])) return undefined;
  return { kind: "list", from: unread[0][0], to: empty[0], rows: unread[0][1].rows.length };
}

/** A rename as the card says it, naming the data note as the reader sees it. */
export function renameWords(note: string, r: Rename): string {
  const n = `${r.rows} ${r.rows === 1 ? "row" : "rows"}`;
  const have = r.rows === 1 ? "has" : "have";
  const them = r.rows === 1 ? "it" : "them";
  if (r.kind === "field") return `${n} of ${r.list} ${have} ${r.from}, which is no longer a field. It now has ${r.to}. Move ${r.from} into ${r.to}?`;
  if (r.kind === "choice") return `${n} of ${r.list} ${have} ${r.field} ${r.from}, which is no longer a choice. Change ${them} to ${r.to}?`;
  return `${note} has a list ${r.from} that no panel reads (${n}). Move ${them} to ${r.to}?`;
}

/** The app's keys renamed something its saved rows still use: what, with a way to bring the rows along or to leave them. */
export function renderRename(header: HTMLElement, note: string, r: Rename, act: { fix: () => Promise<void>; leave: () => void }): HTMLElement {
  const card = header.createDiv({ cls: "gz-card gz-hand-edit gz-rename" });
  card.createDiv({ text: renameWords(note, r) });
  const row = card.createDiv({ cls: "gz-actions" });
  const fix = row.createEl("button", { cls: "mod-cta", text: r.kind === "choice" ? "Change" : "Move" });
  fix.addEventListener("click", handler(async () => {
    const buttons = [...row.querySelectorAll("button")];
    for (const b of buttons) b.disabled = true;
    await act.fix();
    // Once the rows are moved, the card goes; one that stays can be used again.
    for (const b of buttons) b.disabled = false;
  }));
  row.createEl("button", { text: r.rows === 1 ? "Leave it" : "Leave them" }).addEventListener("click", () => act.leave());
  return card;
}

/** In an embed of an app that isn't allowed yet: the app asks for itself when it is opened. */
export function renderOpenOnce(header: HTMLElement, app: CardApp): void {
  const line = header.createDiv({ cls: "gz-waiting" });
  line.createSpan({ text: "Open " });
  const link = line.createEl("a", { cls: "internal-link", text: `[[${basename(app.appPath)}]]`, href: "#" });
  link.addEventListener("click", (e) => {
    e.preventDefault();
    app.env.openNote(app.appPath, app.hostPath);
  });
  line.createSpan({ text: " once to allow it" });
}

export function renderErrors(header: HTMLElement, errors: string[], app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card gz-error" });
  card.createDiv({ cls: "gz-title", text: "This app's keys have problems" });
  const ul = card.createEl("ul");
  for (const e of errors) renderError(ul, e, app);
}

/** An error that names a panel, a data block or an input is a link to that place in the note's source. */
function renderError(ul: HTMLElement, error: string, app: CardApp): void {
  const li = ul.createEl("li");
  if (!labelOf(error)) return li.setText(error);
  const link = li.createEl("button", { cls: "gz-error-link", text: error, title: "Show it in the note" });
  link.addEventListener("click", () => void showErrorSource(error, app));
}

/** Reads the note when the link is used, since it may have changed since the card was drawn. */
async function showErrorSource(error: string, app: CardApp): Promise<void> {
  const line = lineOf(await app.env.sourceLines(), error);
  if (line === undefined) app.env.showSource();
  else app.env.showSourceAt(line);
}

export function renderUsage(header: HTMLElement, c: ComponentPreview, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card" });
  card.createDiv({ text: "A component. Use it in an app's panels:" });
  card.createEl("pre", { cls: "gz-example", text: c.usage });
  const copy = card.createDiv({ cls: "gz-actions" }).createEl("button", { text: "Copy" });
  copy.addEventListener("click", () => {
    app.env.copy(c.usage);
    copy.setText("Copied");
    window.setTimeout(() => copy.setText("Copy"), 1000);
  });
  if (c.lens) card.createDiv({ cls: "gz-label", text: `It is also a lens: it shows above every note in ${c.lens}.` });
  else if (c.missing.length) card.createDiv({ cls: "gz-label", text: "Give every param a default to preview it here." });
}

/** Views whose starter panel works alone in a new app: none reads a list that another panel must save first. */
export const STARTERS = ["button", "form", "checklist", "countdown", "timer"];

/** The two panels of the first app the reference writes (its "Write an app"). */
export const WATER = [
  ["view: button", "label: Drank a glass", "save: water"],
  ["view: progress", "title: Today", "source: water", "where: {at: today}", "max: 8", "unit: glasses"],
];

/**
 * An app with nothing but its `app:` line. In the app's own tab, a button per starter panel adds it
 * to the note, as Insert panel would, and shows it in the source; so does the Water example's.
 */
export function renderEmpty(header: HTMLElement, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card gz-empty-app" });
  card.createDiv({ text: "No panels yet. Add them under panels:, for example:" });
  card.createEl("pre", { cls: "gz-example", text: "panels:\n  - view: countdown\n    to: 2027-01-01\n    label: New year" });
  if (app.hosted) return;
  // An app shown as it was is read only.
  const add = app.env.data.at === undefined ? app.env.addPanels?.bind(app.env) : undefined;
  if (add) {
    card.createDiv({ cls: "gz-label", text: "Or add a starter panel:" });
    const row = card.createDiv({ cls: "gz-actions gz-starters" });
    const offer = (text: string, panels: string[][], title?: string, cta = false) => {
      const b = row.createEl("button", { text, ...(title && { title }), ...(cta && { cls: "mod-cta" }) });
      b.addEventListener("click", handler(async () => {
        const buttons = [...row.querySelectorAll("button")];
        for (const x of buttons) x.disabled = true;
        const done = await add(panels).catch((e: Error) => ({ refusal: `Couldn't add it: ${e.message}` }));
        if ("refusal" in done) {
          for (const x of buttons) x.disabled = false;
          return app.env.notify(done.refusal);
        }
        app.env.showSourceAt(done.cursor.line, done.cursor.ch);
      }));
    };
    for (const id of STARTERS) {
      const def = viewDef(id);
      if (def) offer(id[0].toUpperCase() + id.slice(1), [skeleton(def)], VIEW_HINTS[id]);
    }
    offer("Start from the Water example", WATER, "A button that saves a glass of water, and a bar that counts today's", true);
  }
  card.createDiv({ cls: "gz-actions" }).createEl("button", { text: "Edit source" })
    .addEventListener("click", () => app.env.showSource());
}

/** Where a note's properties stop parsing: the note's 0-based line when the parser names one, and what it says. */
export interface YamlProblem {
  line?: number;
  message: string;
}

/**
 * Why a note that opens with properties gives Obsidian no keys from them: where the YAML parser
 * stopped and what it says, or that they aren't names with values. Undefined when the note has no
 * properties, or they hold keys or nothing at all.
 */
export function yamlProblem(lines: string[], parse: (text: string) => unknown): YamlProblem | undefined {
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return undefined;
  let value: unknown;
  try {
    value = parse(lines.slice(1, end).join("\n"));
  } catch (e) {
    // The parser Obsidian falls back on counts the block's lines from 1, which makes them the note's
    // lines counted from 0, after the opening fence. Its place in the block, which isn't the note's, goes.
    const at = (e as { linePos?: { line?: unknown }[] }).linePos?.[0]?.line;
    const message = (e instanceof Error ? e.message : String(e)).split("\n")[0].replace(/ at line \d+, column \d+:?$/, "").replace(/:$/, "").trim();
    return { ...(typeof at === "number" && { line: Math.min(Math.max(at, 1), end - 1) }), message };
  }
  if (value === null || value === undefined || (typeof value === "object" && !Array.isArray(value))) return undefined;
  return { message: "each one needs a name and a colon, like app: …" };
}

/** The properties don't parse: where and why, and a way to that line. */
export function renderYamlError(header: HTMLElement, problem: YamlProblem, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card gz-error gz-yaml-error" });
  const where = problem.line === undefined ? "" : `: line ${problem.line + 1}`;
  card.createDiv({ text: `The properties aren't valid YAML${where}${problem.message ? `: ${problem.message}` : ""}` });
  card.createDiv({ cls: "gz-actions" }).createEl("button", { text: "Show it" })
    .addEventListener("click", () => app.env.showSourceAt(problem.line ?? 1));
}
