import type { Placement } from "../compose.ts";
import type { Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import { board } from "./board.ts";
import { calendar } from "./calendar.ts";
import { alerts, type AlertFeed } from "./alerts.ts";
import { bar, line } from "./chart.ts";
import { button, checklist, form } from "./inputs.ts";
import { pie } from "./pie.ts";
import { list, table } from "./rows.ts";
import { scatter } from "./scatter.ts";
import { timeline } from "./timeline.ts";
import { timer } from "./timer.ts";
import { countdown, number, progress, text } from "./value.ts";

export interface TimerState {
  remainingMs: number;
  endsAt?: number;
}

/** What a pick shows in the app's side sheet: the row, the element picked, and how to take the pick back. */
export interface SheetPick {
  row: Row;
  /** The element picked, which gets the focus back when the sheet closes. */
  el: Element;
  /** What the element says it is, when the view gave it a label. */
  label?: string;
  /** A record (a table row, list item, card or timeline mark), whose fields the sheet shows; not a day, bar, slice or dot. */
  record: boolean;
  /** Takes the pick back, as picking the element again would. */
  clear(): void;
}

/** What a mounted panel may ask of the app around it. */
export interface PanelCtx {
  now: Date;
  /** The drawing width inside the panel with this key. */
  width(key: string): number;
  /** Runs a panel's actions; says why when a value rule refused the row, so a form can keep what was typed. */
  runActions(p: Panel, row: Row): Promise<{ error?: string } | void>;
  toggleChecked(key: string, item: string): Promise<void>;
  clearChecked(key: string): Promise<void>;
  openNote(path: string): void;
  timer(key: string, p: Panel): TimerState;
  startTimer(key: string, p: Panel): void;
  pauseTimer(key: string): void;
  resetTimer(key: string, p: Panel): void;
  /** Sets the selection `name` (a panel's `select`) to a row, or clears it; panels reading it follow. */
  select(name: string, row: Row | undefined): void;
  selected(name: string): Row | undefined;
  /**
   * In an app's own tab, shows what was picked in this panel in the side sheet beside the app, or
   * closes the sheet (undefined); `redrawn`: the panel was drawn again, and this is its pick as it
   * shows it now. Absent elsewhere (the grid, embeds, lenses), where a pick stays in its panel.
   */
  open?(pick: SheetPick | undefined, redrawn?: boolean): void;
  /**
   * Writes one field of a row this panel shows back where the row came from: the note's
   * frontmatter (a notes row), or its place in the saved list. Problems are notified, not thrown;
   * the panel updates when the write lands.
   */
  editRow(row: Row, field: string, value: unknown): Promise<void>;
  /**
   * Writes one field of a `save: this` form as a property of the note the app sits in; the panel
   * updates when the write lands. Absent outside an app.
   */
  setProperty?(field: string, value: unknown): Promise<void>;
  /**
   * Where the panel sits in the composed layout (its role, and its part of the answer), for a view
   * that reads differently there; undefined on the grid. Asked each time, as editing the app can move it.
   */
  place?(): Placement | undefined;
  /** Alerts true now across the vault, when the plugin's background service runs. */
  alerts?: AlertFeed;
  /** In a try before Allow, where nothing drawn may reach out of Obsidian. */
  preview?: boolean;
}

export interface PanelHandle {
  update(data: unknown): void;
  resize?(width: number): void;
  destroy?(): void;
}

/**
 * Everything about one view in one place: the keys it accepts (besides `view` and `title`),
 * its own checks, worked examples (run as tests), and how it draws.
 */
export interface ViewDef {
  id: string;
  keys: readonly string[];
  /** Columns the view takes by default, out of 4 on a wide pane; `span:` overrides it. */
  span: number;
  needsSource?: boolean;
  /**
   * Pipeline keys this view fixes whatever was typed: a calendar always groups per day, and a
   * board (`group: undefined`) groups the raw rows itself.
   */
  pipeline?: Pick<Partial<Panel>, "group" | "per">;
  /** What this view shows when it has no `source:` (a checklist's ticked items), if anything. */
  implicitSource?(p: Panel): string | undefined;
  /** Problems beyond key types and applicability, as plain sentences. */
  validate?(p: Panel): string[];
  examples: { panel: Record<string, unknown>; errors?: string[] }[];
  mount(el: HTMLElement, p: Panel, ctx: PanelCtx, key: string): PanelHandle;
}

export const VIEW_DEFS: readonly ViewDef[] = [
  number, text, line, bar, pie, table, list, button, form, checklist, countdown, progress, timer,
  calendar, board, scatter, timeline,
  alerts,
];

const BY_ID = new Map(VIEW_DEFS.map((d) => [d.id, d]));

export function viewDef(id: string): ViewDef | undefined {
  return BY_ID.get(id);
}

/** Where a panel's data comes from: its `source`, else what its view reads without one. */
export function sourceOf(p: Panel): string | undefined {
  return p.source ?? viewDef(p.view)?.implicitSource?.(p);
}
