import { fillWith, rowsOf, toNumber, valueOf, type Row } from "./data.ts";
import { display, formatFor, mapped } from "./format.ts";
import { streak } from "./group.ts";
import type { Panel } from "./spec.ts";

/**
 * What a number, progress or text panel shows for its data: its value (a progress panel's is a
 * number, 0 when there is none; a text panel's is its text), that value as text under the panel's
 * `values`, `format` and `decimals`, and the `unit` that goes beside it (none when a format or
 * values already speak for it). A text panel with no rows says its `empty` text, when it has one.
 * The views draw this, and the status bar and alerts say it again.
 */
export function panelValue(p: Panel, data: unknown, now: Date): { value: unknown; text: string; unit?: string } {
  if (p.view === "text") {
    if (p.empty !== undefined && noRows(data)) return { value: p.empty, text: p.empty };
    const scope = Array.isArray(data) ? { ...(data[0] as Row), rows: data, count: data.length } : data;
    const text = fillWith(p.text ?? "", scope, (path, v) => display(p, path, v, now, "text"));
    return { value: text, text };
  }
  const found = p.agg === "streak" ? streak(rowsOf(data), p.group!, p.per!, now) : valueOf(p, data, now);
  const value = p.view === "progress" ? toNumber(found) ?? 0 : found;
  const unit = p.unit && formatFor(p, p.field) === undefined && mapped(p, p.field, value) === undefined ? p.unit : undefined;
  return { value, text: display(p, p.field, value, now), unit };
}

export const noRows = (data: unknown) => Array.isArray(data) && data.length === 0;
