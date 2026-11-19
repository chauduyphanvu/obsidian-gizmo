import { extent, toNumber, type Row } from "../data.ts";
import { display } from "../format.ts";
import type { Panel } from "../spec.ts";
import { svg } from "./chart.ts";
import { noteLink } from "./common.ts";
import type { PanelCtx } from "./registry.ts";

/** How a table column can be drawn besides plain text (`cells: {field: kind}`). */
export const CELL_KINDS = ["progress", "sparkline", "link", "image", "check"];

const SPARK_W = 80, SPARK_H = 20, SPARK_PAD = 2;

/** The URL if the text is an https one; nothing else (no http, no javascript:, no data:) is ever linked or loaded. */
function httpsUrl(text: string): URL | undefined {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.host ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The note a `[[link]]` or a path ending in `.md` names, with the text to show for it. */
function noteTarget(text: string): { path: string; text: string } | undefined {
  const link = text.match(/^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/);
  if (link) return { path: link[1].trim(), text: (link[2] ?? link[1]).trim() };
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || !/\.md$/i.test(text)) return undefined;
  return { path: text, text: text.replace(/^.*\//, "").replace(/\.md$/i, "") };
}

const numberOf = (v: unknown) => (typeof v === "boolean" ? undefined : toNumber(v));

/** A bar for 0–1, or 0–`max` when the panel has one; the formatted value is its label. */
function progressCell(td: HTMLElement, value: unknown, p: Panel, shown: (v: unknown) => string): void {
  const n = numberOf(value);
  if (n === undefined) return td.setText(shown(value));
  const max = p.max ?? 1;
  const label = shown(n);
  const bar = td.createDiv({
    cls: "gz-cell-bar",
    attr: { role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": max, "aria-valuenow": n, title: label },
  });
  bar.createDiv({ cls: "gz-cell-fill" }).style.width = `${max > 0 ? Math.max(0, Math.min(1, n / max)) * 100 : 0}%`;
}

/** A small line through a list of numbers; fewer than two show as the plain value. */
function sparklineCell(td: HTMLElement, value: unknown, shown: (v: unknown) => string): void {
  const nums = Array.isArray(value) ? value.map(numberOf).filter((n): n is number => n !== undefined) : [];
  if (nums.length < 2) return td.setText(shown(value));
  const [lo, hi] = extent(nums);
  const at = (n: number, i: number): [number, number] => [
    SPARK_PAD + (i / (nums.length - 1)) * (SPARK_W - 2 * SPARK_PAD),
    hi === lo ? SPARK_H / 2 : SPARK_H - SPARK_PAD - ((n - lo) / (hi - lo)) * (SPARK_H - 2 * SPARK_PAD),
  ];
  const points = nums.map((n, i) => at(n, i).map((v) => v.toFixed(1)).join(",")).join(" ");
  const root = svg("svg", {
    viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, width: SPARK_W, height: SPARK_H, class: "gz-spark", role: "img",
    "aria-label": `${nums.length} values, from ${shown(nums[0])} to ${shown(nums[nums.length - 1])}`,
  }, td);
  svg("polyline", { points, class: "gz-spark-line gz-s1" }, root);
  const [x, y] = at(nums[nums.length - 1], nums.length - 1);
  svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 2, class: "gz-spark-dot gz-s1" }, root);
}

/** An https address opens outside Obsidian; a note path or `[[link]]` opens the note; anything else is text. */
function linkCell(td: HTMLElement, value: unknown, ctx: PanelCtx, shown: (v: unknown) => string): void {
  const text = typeof value === "string" ? value.trim() : "";
  const url = httpsUrl(text);
  if (url) {
    td.createEl("a", { cls: "external-link", text: text.replace(/^https:\/\//i, ""), href: url.href, attr: { target: "_blank", rel: "noopener" } });
    return;
  }
  const note = noteTarget(text);
  if (note) return noteLink(td, note.text, note.path, ctx);
  td.setText(shown(value));
}

/** The picture at an https address, named by the row; anything else draws nothing. */
function imageCell(td: HTMLElement, value: unknown, row: Row): void {
  const url = typeof value === "string" ? httpsUrl(value.trim()) : undefined;
  if (!url) return;
  const alt = String(row.name ?? row.title ?? "");
  td.createEl("img", { cls: "gz-cell-img", attr: { src: url.href, alt, loading: "lazy", referrerpolicy: "no-referrer" } });
}

/** A tick, or an empty box, that reads out as yes or no. */
function checkCell(td: HTMLElement, value: unknown): void {
  const on = value === true || String(value).toLowerCase() === "true";
  td.createSpan({ cls: `gz-check${on ? " is-on" : ""}`, text: on ? "✓" : "", attr: { role: "img", "aria-label": on ? "yes" : "no" } });
}

/**
 * Draws one table cell as a `cells` kind. `field` is the column, for its format and values; the
 * view draws a column that is also in `edit` as an input instead.
 */
export function drawCell(td: HTMLElement, kind: string, value: unknown, row: Row, p: Panel, ctx: PanelCtx, field?: string): void {
  const shown = (v: unknown) => display(p, field, v, ctx.now, "cell");
  switch (kind) {
    case "progress": return progressCell(td, value, p, shown);
    case "sparkline": return sparklineCell(td, value, shown);
    case "link": return linkCell(td, value, ctx, shown);
    case "image": return imageCell(td, value, row);
    case "check": return checkCell(td, value);
  }
}
