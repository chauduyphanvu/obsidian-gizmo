import { stableJson } from "./hash.ts";
import type { Panel } from "./spec.ts";
import { THIS } from "./template.ts";

/**
 * How an app reads in the composed layout: each panel takes a role from its view, and the roles
 * decide where it goes. The answer comes first (number, progress, countdown, text), then the line
 * to add things (button, form), then the evidence, the workspaces and the records, in the order
 * written. A panel that reads a pick waits for it in a sheet. Nothing in the app's keys changes.
 */
export type Role = "answer" | "verb" | "evidence" | "workspace" | "records" | "sheet";

/** Where a panel sits in the composed layout: its role, and its place among the panels of that role. */
export interface Placement {
  role: Role;
  slot: "headline" | "fact" | "meter" | "compose" | "flow" | "sheet";
}

/** Each view's role; a view not listed keeps records. */
const ROLES: Record<string, Role | ((p: Panel) => Role)> = {
  number: "answer",
  progress: "answer",
  countdown: "answer",
  text: "answer",
  button: "verb",
  // A form that writes the note's own properties is a place to work, not a line to add things.
  form: (p) => (p.save === THIS ? "workspace" : "verb"),
  line: "evidence",
  bar: "evidence",
  pie: "evidence",
  scatter: "evidence",
  calendar: (p) => (p.layout === "year" ? "evidence" : "workspace"),
  board: "workspace",
  timeline: "workspace",
  timer: "workspace",
  table: "records",
  list: "records",
  checklist: "records",
  alerts: "records",
  reconcile: "records",
};

/** A panel's role; `readsSelection`: it reads a name another panel selects, so it waits in the sheet. */
export function roleOf(p: Panel, readsSelection: boolean): Role {
  if (readsSelection) return "sheet";
  const role = ROLES[p.view] ?? "records";
  return typeof role === "function" ? role(p) : role;
}

/** The keys that say what value a number or a progress shows. */
export type ValueKeys = Pick<Panel, "view" | "source" | "where" | "field" | "agg">;

/** The answer panels of one scope, by their index in the list given. */
export interface AnswerGroups {
  /** The panel that leads: the first number, else the first progress, else the first. */
  headline: number | undefined;
  /** The others, in the order written, less the meters. */
  facts: number[];
  /** Each number that has a meter, and the progress drawn as it. */
  meters: Map<number, number>;
}

/** Whether two panels show the same value: the same rows (source, where), field and aggregate. */
function sameValue(a: ValueKeys, b: ValueKeys): boolean {
  return a.source === b.source && a.field === b.field && a.agg === b.agg && stableJson(a.where) === stableJson(b.where);
}

/**
 * Groups the answer panels of one scope, given in the order written. A progress over the same value
 * as a number is that number's meter rather than a fact of its own; each number takes the first
 * such progress, and a progress goes to the first number it matches.
 */
export function answerGroups(panels: readonly ValueKeys[]): AnswerGroups {
  const meters = new Map<number, number>();
  const metered = new Set<number>();
  panels.forEach((p, i) => {
    if (p.view !== "progress") return;
    const n = panels.findIndex((q, j) => q.view === "number" && !meters.has(j) && sameValue(q, p));
    if (n < 0) return;
    meters.set(n, i);
    metered.add(i);
  });
  const first = (view: string) => panels.findIndex((p, i) => p.view === view && !metered.has(i));
  const lead = [first("number"), first("progress"), panels.length ? 0 : -1].find((i) => i >= 0);
  const facts = panels.map((_, i) => i).filter((i) => i !== lead && !metered.has(i));
  return { headline: lead, facts, meters };
}

/** One part of an app laid out on its own: the panels outside any tab, or one tab's. Indices are the app's. */
export interface Scope {
  tab: string | undefined;
  answer: AnswerGroups;
  compose: number[];
  flow: number[];
  sheet: number[];
}

/** A panel as the composer needs it: its checked keys, and the names it reads. */
export interface Composable {
  panel: Panel;
  inputs: readonly string[];
}

/**
 * The app as scopes, the panels outside any tab first and then each tab in the order its first
 * panel is written, with every panel's placement. `selections` are the names the app's panels select.
 */
export function compose(panels: readonly Composable[], selections: readonly string[]): { scopes: Scope[]; placements: Placement[] } {
  const roles = panels.map((ps) => roleOf(ps.panel, ps.inputs.some((n) => selections.includes(n))));
  const named = [...new Set(panels.map((ps) => ps.panel.tab).filter((t) => t !== undefined))];
  const tabs = panels.some((ps) => ps.panel.tab === undefined) ? [undefined, ...named] : named;
  const placements: Placement[] = roles.map((role) => ({ role, slot: role === "verb" ? "compose" : role === "sheet" ? "sheet" : "flow" }));
  const scopes = tabs.map((tab): Scope => {
    const own = panels.map((_, i) => i).filter((i) => panels[i].panel.tab === tab);
    const of = (...wanted: Role[]) => own.filter((i) => wanted.includes(roles[i]));
    const answers = of("answer");
    const local = answerGroups(answers.map((i) => panels[i].panel));
    const answer: AnswerGroups = {
      headline: local.headline === undefined ? undefined : answers[local.headline],
      facts: local.facts.map((i) => answers[i]),
      meters: new Map([...local.meters].map(([n, m]) => [answers[n], answers[m]])),
    };
    if (answer.headline !== undefined) placements[answer.headline].slot = "headline";
    for (const i of answer.facts) placements[i].slot = "fact";
    for (const i of answer.meters.values()) placements[i].slot = "meter";
    return { tab, answer, compose: of("verb"), flow: of("evidence", "workspace", "records"), sheet: of("sheet") };
  });
  return { scopes, placements };
}
