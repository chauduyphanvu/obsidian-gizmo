/**
 * Ahead: an app as it would be at a time still to come. It runs on a data layer of its own, as the
 * past does (see replay.ts), whose ledger also folds this device's branch for the app (see Ledger's
 * `branch`): what the app saves there are what-if rows, which no other ledger reads. Panels read
 * the lists at the time shown, counting planned rows and what-if rows as having happened by their
 * time; web answers are the latest kept, notes are as they are now. Until Keep, nothing real is
 * written or logged and a `then` is only named; Keep makes the what-if rows of kinds planned rows,
 * for real, and Discard empties the branch.
 */
import { runActions, actionDepsOf } from "./actions.ts";
import type { Change } from "./activity.ts";
import type { AppEnv } from "./app.ts";
import { alertsOf, backtest, rhythmsOf, type BacktestResult, type Fire } from "./backtest.ts";
import { dayText, logTime, parseLine, whenText, type CaptureIndex, type Parsed } from "./capture.ts";
import { compose } from "./compose.ts";
import type { Row } from "./data.ts";
import type { AppFiles, DataLayer } from "./datalayer.ts";
import { ledgerStore, type DataStore } from "./datastore.ts";
import { lineOf } from "./kind.ts";
import { rowId } from "./ledger.ts";
import { AHEAD, rowIdOf, type Ledger } from "./ledger-store.ts";
import { isWhatIf } from "./row-marks.ts";
import { formRow } from "./links.ts";
import { shownAsNow } from "./replay.ts";
import { kindFiles, kindOfPanel } from "./sources/kind.ts";
import { sourceDef } from "./sources/registry.ts";
import { thisValues } from "./sources/this.ts";
import { resolvePanel, startingValues, type AppSpec, type Then } from "./spec.ts";
import { basename } from "./store.ts";
import { THIS } from "./template.ts";
import { dateWindow, periodStart, shiftPeriod, toTime } from "./time.ts";
import { formFields } from "./panel.ts";

/** How far ahead a what-if looks at most: a year, as a backtest looks back. */
export const AHEAD_MS = 365 * 86_400_000;
const MINUTE = 60_000;

/** What an app shown ahead knows of it: the time shown, and the app as it is now, which Keep writes through. */
export interface Ahead {
  at: number;
  live: AppEnv;
  /** Where the person is, for the days and deadlines of the look ahead, as background work works them out. */
  zone?: string;
  /** Shows the app at another time still to come. */
  show(at: number): void;
  /** Hears the times of the what-if rows whenever they change, for the time rail to mark. */
  marked?(times: number[]): void;
}

/**
 * The name an app's what-if is kept under, one per app and device, as its branch files carry it:
 * its note's name, for a person looking at the files, and a hash of its path, so two notes of one
 * name in two folders keep two what-ifs.
 */
export function branchName(appPath: string): string {
  return `${basename(appPath).replace(/[^\p{L}\p{N} _-]/gu, "-")}-${rowId(appPath).slice(0, 8)}`;
}

/**
 * The app on a what-if's layer at `at`: what it saves goes to the branch as what-if rows, of which
 * only those can be changed or taken out; anything else it would write is refused, and nothing is
 * logged or run.
 */
export function aheadEnv(live: AppEnv, data: DataLayer, at: number, opts: { show(at: number): void; back(): void; zone?: string; marked?(times: number[]): void }): AppEnv {
  const ledger = data.ledger!;
  const refuse = () => Promise.reject(new Error(AHEAD));
  return {
    ...live,
    data,
    now: () => new Date(at),
    writeFrontmatter: refuse,
    updateFrontmatter: refuse,
    appendLine: refuse,
    createNote: refuse,
    setTaskDone: refuse,
    store: (dataPath, appPath) => whatIfStore(ledgerStore(ledger, dataPath, () => live.frontmatter(appPath) ?? {})),
    addPanels: undefined,
    log: undefined,
    undo: undefined,
    trigger: undefined,
    opened: undefined,
    asks: undefined,
    headline: undefined,
    backToNow: () => opts.back(),
    ahead: { at, live, zone: opts.zone, show: (t) => opts.show(t), ...(opts.marked && { marked: (times: number[]) => opts.marked!(times) }) },
  };
}

/** A branch's store: rows are added as what-ifs; a row that is real can't be changed or taken out, and nothing is ticked. */
function whatIfStore(store: DataStore): DataStore {
  const real = async (list: string, id: string | undefined) => {
    const row = (await store.rows(list)).find((r) => rowIdOf(r) === id);
    return row !== undefined && !isWhatIf(row);
  };
  const refuse = () => Promise.reject(new Error(AHEAD));
  return {
    ...store,
    async set(list, ref, field, value) {
      if (await real(list, ref.id)) throw new Error(AHEAD);
      return store.set(list, ref, field, value);
    },
    async delete(list, ref) {
      if (await real(list, ref.id)) throw new Error(AHEAD);
      return store.delete(list, ref);
    },
    async batch(edits) {
      for (const e of edits) if (e.op !== "add" && (await real(e.list, e.ref.id))) throw new Error(AHEAD);
      return store.batch(edits);
    },
    tick: refuse,
    untick: refuse,
    clear: refuse,
    undo: refuse,
  };
}

/** A data note a what-if can add rows to: the app's own, or a kind's, with the note that owns it and the kind's name. */
export interface WhatIfNote {
  dataPath: string;
  owner: string;
  kind?: string;
}

/** The app's own data note, then each kind's it reads or saves to. */
export function whatIfNotes(spec: AppSpec, appPath: string, dataPath: string): WhatIfNote[] {
  const out: WhatIfNote[] = [{ dataPath, owner: appPath, ...(spec.kind && { kind: spec.kind.name }) }];
  for (const { panel } of spec.panels) {
    const ref = kindOfPanel(panel);
    const files = ref && kindFiles(ref);
    if (files && !out.some((n) => n.dataPath === files.dataPath)) out.push({ dataPath: files.dataPath, owner: ref.path, kind: ref.name });
  }
  return out;
}

/** A what-if row, where it is kept, and whether it is a kind's (only those can be kept). */
export interface WhatIfRow {
  note: WhatIfNote;
  list: string;
  row: Row;
}

/** Every row the notes hold, as the what-if's ledger folds them, with the note and list each is in. */
async function rowsOf(ledger: Ledger, notes: WhatIfNote[], frontmatter: (path: string) => Record<string, unknown> | undefined) {
  const out: { note: WhatIfNote; list: string; row: Row }[] = [];
  for (const note of notes) {
    const st = await ledger.state(note.dataPath, frontmatter(note.owner) ?? {});
    for (const [list, l] of st.lists) for (const row of l.rows) out.push({ note, list, row });
  }
  return out;
}

const timeOf = (row: Row) => toTime(row.at) ?? 0;

/** The what-if rows in the app's notes, in the order of their time. */
export async function whatIfRows(ledger: Ledger, notes: WhatIfNote[], frontmatter: (path: string) => Record<string, unknown> | undefined): Promise<WhatIfRow[]> {
  return (await rowsOf(ledger, notes, frontmatter)).filter((r) => isWhatIf(r.row)).sort((a, b) => timeOf(a.row) - timeOf(b.row));
}

/** The times a look ahead steps at besides days and deadlines: each what-if row's, and each planned row's of a kind not settled yet. */
async function timesAhead(ledger: Ledger, notes: WhatIfNote[], frontmatter: (path: string) => Record<string, unknown> | undefined): Promise<number[]> {
  return (await rowsOf(ledger, notes, frontmatter))
    .filter(({ note, list, row }) => isWhatIf(row) || (note.kind === list && lineOf(row) === "planned" && !row.matched))
    .map(({ row }) => toTime(row.at))
    .filter((t): t is number => t !== undefined);
}

/**
 * When an app shown ahead is shown at first: the end of the window its headline panel reads (`this
 * month`: its last minute), at the latest what-if row's time when that is later than now; the end of
 * that month when it reads none. At most a year ahead.
 */
export function defaultHorizon(spec: AppSpec, now: number, latest?: number): number {
  const at = Math.max(now, latest ?? now);
  const end = headlineEnd(spec, at);
  const t = end !== undefined && end > at ? end : shiftPeriod(periodStart(at, "month"), "month", 1) - MINUTE;
  return Math.min(t, now + AHEAD_MS);
}

function headlineEnd(spec: AppSpec, at: number): number | undefined {
  const i = compose(spec.panels, spec.selections).scopes[0]?.answer.headline;
  if (i === undefined) return undefined;
  for (const cond of Object.values(spec.panels[i].panel.where ?? {})) {
    if (typeof cond !== "string") continue;
    const w = dateWindow(cond, new Date(at));
    if (w && Number.isFinite(w[0]) && Number.isFinite(w[1])) return w[1] - MINUTE;
  }
  return undefined;
}

/**
 * What the app's alerts, state rules and rhythms would do from now to the time shown, with what-if
 * and planned rows as having happened by their time. `live` is the app as it is now, what is true
 * of it is noted, not counted, so a what-if that tips an alert now is told.
 */
export async function lookAhead(env: AppEnv, live: DataLayer, spec: AppSpec, files: AppFiles, notes: WhatIfNote[]): Promise<BacktestResult | undefined> {
  const ahead = env.ahead!;
  const now = ahead.live.now().getTime();
  const times = await timesAhead(env.data.ledger!, notes, (path) => env.frontmatter(path));
  return backtest({
    layer: env.data, appPath: files.appPath, dataPath: files.dataPath, devices: files.devices, after: spec, to: ahead.at,
    ahead: { from: now, times, zone: ahead.zone, base: live },
  });
}

/**
 * What the look ahead found, a line for each alert or rule: when it would first go off, how often,
 * and what its `then` would run. An alert's condition is said with `values` filled in (`$this`).
 */
export function aheadLines(r: BacktestResult, spec: AppSpec, now: Date, values: Readonly<Record<string, unknown>> = {}): string[] {
  const watched = new Map(alertsOf(spec).map((w) => [w.key, w]));
  const rhythms = new Map(rhythmsOf(spec).map((rule) => [`expect:${rule.id}`, rule]));
  const groups = new Map<string, Fire[]>();
  for (const f of r.after) groups.set(f.key, [...(groups.get(f.key) ?? []), f]);
  return [...groups.values()].map((fires) => {
    const [first] = fires;
    const when = fires.length === 1 ? dayText(new Date(first.at), now) : `${fires.length} times, first ${dayText(new Date(first.at), now)}`;
    const w = watched.get(first.key);
    const rhythm = rhythms.get(first.key);
    const alert = w && (resolvePanel(w.ps, values).panel ?? w.ps.panel).alert;
    const said = rhythm || first.key.startsWith("expect:") ? `“${first.what}” would be told ${when}` : `“${first.what}”${typeof alert === "string" ? ` (${alert})` : ""} would go on ${when}`;
    const then = thenOf(w?.then ?? rhythm?.then);
    return then ? `${said}; it would run ${then}` : said;
  });
}

const thenOf = (then: Then | undefined) => then && `“${then.do}” in ${basename(then.app.replace(/^\[\[|\]\]$/g, ""))}`;

/** A what-if row as the banner lists it: its values, then when it is for. */
export function whatIfText(row: Row, now: Date): string {
  const values = Object.entries(row).filter(([k, v]) => !["at", "line", "matched", "by"].includes(k) && v !== null && v !== undefined && v !== "").map(([, v]) => String(v));
  const at = toTime(row.at);
  return [...values, ...(at === undefined ? [] : [whenText(new Date(at), now)])].join(" · ");
}

/**
 * The panels the time shown doesn't reach: notes, tasks and files read as they are now, and web
 * answers that are the latest kept.
 */
export function readAsNow(spec: AppSpec): { now: string[]; kept: string[] } {
  const kept = spec.panels.filter(({ panel: p }) => p.source && sourceDef(p.source).id === "url").map(({ panel: p }) => p.title ?? p.label ?? p.view);
  return { now: shownAsNow(spec), kept };
}

/** What Keep did: how many rows it made planned, and how many it found kept already, or kept and undone. */
export interface Kept {
  kept: number;
  already: number;
  gone: number;
  entry?: string;
}

/**
 * Keep: each what-if row of a kind the card showed becomes a planned row of the kind, under the
 * what-if row's own id, as it is when Keep runs, all in one change of the activity; then those rows
 * leave the branch, and only those, so a what-if added meanwhile stays one. The same id makes a
 * second Keep (a retry) add nothing, and stops a kept row being counted twice beside its what-if
 * meanwhile.
 */
export async function keep(env: AppEnv, appPath: string, rows: WhatIfRow[]): Promise<Kept> {
  const { live } = env.ahead!;
  const ledger = env.data.ledger!;
  const out: Kept = { kept: 0, already: 0, gone: 0 };
  const changes: Change[] = [];
  const notes = [...new Map(rows.map((r) => [r.note.dataPath, r.note])).values()];
  const now = new Map((await whatIfRows(ledger, notes, (path) => env.frontmatter(path))).map((r) => [rowIdOf(r.row), r]));
  const byNote = new Map<string, WhatIfRow[]>();
  for (const shown of rows) {
    const r = now.get(rowIdOf(shown.row)) ?? shown;
    if (r.note.kind === r.list) byNote.set(r.note.dataPath, [...(byNote.get(r.note.dataPath) ?? []), r]);
  }
  for (const group of byNote.values()) {
    const { note } = group[0];
    const store = live.store!(note.dataPath, note.owner);
    const done = await store.batch(group.map(({ list, row }) => ({ op: "add", list, row: { ...row, line: "planned" }, id: rowIdOf(row)! })));
    if ("refused" in done) continue;
    done.forEach((d, i) => {
      if (d.already === "there") out.already++;
      else if (d.already === "gone") out.gone++;
      else {
        out.kept++;
        changes.push({ kind: "row-added", path: store.dataPath, list: group[i].list, row: d.row, ...(d.event && { event: d.event }) });
      }
    });
    await ledger.prune(note.dataPath, new Set(group.map(({ row }) => rowIdOf(row)!)));
  }
  if (changes.length) {
    const n = changes.length;
    out.entry = (await live.log?.({ app: appPath, actor: "you", what: `Kept ${n === 1 ? "a what-if row" : `${n} what-if rows`} as planned`, changes }))?.id;
  }
  return out;
}

/** Discard: every what-if row of the app goes. */
export async function discard(env: AppEnv, notes: WhatIfNote[]): Promise<void> {
  for (const note of notes) await env.data.ledger!.discard(note.dataPath);
}

/** A Do… line that starts `what if`: the line after it, or undefined for any other line. */
export function whatIfLine(line: string): string | undefined {
  const m = /^\s*what\s+if(?:\s+(.*)|\s*)$/i.exec(line);
  return m ? (m[1] ?? "") : undefined;
}

/** A line read as Do… reads it, every shortcut taking a time still to come, as a what-if does. */
export function parseWhatIf(line: string, index: CaptureIndex, now: Date): Parsed {
  const names = new Map([...index.names].map(([name, t]) => [name, { ...t, ahead: true }]));
  return parseLine(line, { names, clashes: index.clashes }, now);
}

/**
 * Saves the row a what-if line gives, through the shortcut it names, on the app shown ahead: `params`
 * as Do… read them, a time in `at=` read from `now`. An error says why nothing was saved.
 */
export async function addWhatIf(env: AppEnv, target: { path: string; dataPath: string; spec: AppSpec; shortcut: string }, params: Record<string, string>, now: Date): Promise<{ ok: true } | { error: string }> {
  const ps = target.spec.panels.find((x) => x.panel.shortcut === target.shortcut);
  const values = { ...startingValues(target.spec.inputs, now), [THIS]: thisValues(target.path, env.frontmatter(target.path), env.data.host.tags(target.path)) };
  const p = ps && resolvePanel(ps, values).panel;
  if (!p) return { error: `“${target.shortcut}” can't run here` };
  if (p.view === "checklist") return { error: "a what-if holds rows; a checklist's ticks can't be tried" };
  const { at: raw, ...given } = params;
  const when = raw === undefined ? { at: now } : logTime(raw, now, true);
  if ("error" in when) return { error: when.error };
  const read = p.view === "form" ? formRow(formFields(p), p.fieldInfo, given, when.at) : { row: {} };
  if ("error" in read) return { error: read.error };
  const r = await runActions(p, read.row, {
    ...actionDepsOf(env, target.path, target.dataPath),
    expect: target.spec.expect,
    at: when.at,
    ...(when.plan && { plan: when.plan }),
    whatIf: true,
    tellsFailure: true,
  });
  return r.ok ? { ok: true } : { error: r.error ?? "it didn't save" };
}
