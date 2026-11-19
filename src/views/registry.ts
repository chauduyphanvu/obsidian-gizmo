import type { Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import { alerts, type AlertFeed } from "./alerts.ts";
import { bar, line } from "./chart.ts";
import { button, checklist, form } from "./inputs.ts";
import { pie } from "./pie.ts";
import { list, table } from "./rows.ts";
import { timer } from "./timer.ts";
import { countdown, number, progress, text } from "./value.ts";

export interface TimerState {
  remainingMs: number;
  endsAt?: number;
}

/** What a mounted panel may ask of the app around it. */
export interface PanelCtx {
  now: Date;
  /** The drawing width inside the panel with this key. */
  width(key: string): number;
  runActions(p: Panel, row: Row): Promise<void>;
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
   * Writes one field of a row this panel shows back where the row came from: the note's
   * frontmatter (a notes row), or its place in the saved list. Problems are notified, not thrown;
   * the panel updates when the write lands.
   */
  editRow(row: Row, field: string, value: unknown): Promise<void>;
  /** Alerts true now across the vault, when the plugin's background service runs. */
  alerts?: AlertFeed;
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
  /** The list this view shows when it has no `source:` (a checklist's ticked items). */
  implicitSource?(p: Panel): string;
  /** Problems beyond key types and applicability, as plain sentences. */
  validate?(p: Panel): string[];
  examples: { panel: Record<string, unknown>; errors?: string[] }[];
  mount(el: HTMLElement, p: Panel, ctx: PanelCtx, key: string): PanelHandle;
}

export const VIEW_DEFS: readonly ViewDef[] = [
  number, text, line, bar, pie, table, list, button, form, checklist, countdown, progress, timer,
  alerts,
];

const BY_ID = new Map(VIEW_DEFS.map((d) => [d.id, d]));

export function viewDef(id: string): ViewDef | undefined {
  return BY_ID.get(id);
}
