import { extent, fillWith, formatValue, getPath, toNumber, toTime, type Row } from "../data.ts";
import { display, formatErrors, formatFor, formatWith, labelOf, mapped } from "../format.ts";
import { rowsFromArrays } from "../group.ts";
import type { Panel } from "../spec.ts";
import { timeTicks } from "./axis.ts";
import { B, H, L, R, T, niceTicks, svg } from "./chart.ts";
import { DATA_KEYS, heading, picks, rowsOf, selectable, seriesNames } from "./common.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "./registry.ts";

const RADIUS = 4;
/** Most dots drawn; a few thousand are as much as a person can read, and as many as a panel can hold. */
export const MAX_DOTS = 2000;
const DAY = 86_400_000;

interface Dot { row: Row; x: number; y: number }

/**
 * The rows that can be plotted: a numeric y, and an x that is a number or, when most of them are
 * dates, a time. Returns whether the x axis is time.
 */
function dotsOf(p: Panel, data: unknown): { dots: Dot[]; isTime: boolean } {
  const y = seriesNames(p)[0];
  const rows = Array.isArray(data) ? rowsOf(data) : rowsFromArrays(data, [p.x!, y]) ?? rowsOf(data);
  const found = rows.flatMap((row) => {
    const yv = toNumber(getPath(row, y));
    return yv === undefined ? [] : [{ row, xv: getPath(row, p.x), y: yv }];
  });
  const times = found.filter((f) => toTime(f.xv) !== undefined).length;
  const isTime = times > 0 && times >= found.filter((f) => toNumber(f.xv) !== undefined).length;
  const dots = found.flatMap((f) => {
    const x = isTime ? toTime(f.xv) : toNumber(f.xv);
    return x === undefined ? [] : [{ row: f.row, x, y: f.y }];
  });
  return { dots, isTime };
}

function drawScatter(el: HTMLElement, p: Panel, ctx: PanelCtx, data: unknown, width: number): void {
  const { dots, isTime } = dotsOf(p, data);
  if (dots.length === 0) {
    el.createDiv({ cls: "na-empty", text: "No data to chart yet." });
    return;
  }
  const W = Math.max(280, Math.round(width));
  const shown = dots.slice(0, MAX_DOTS);
  const [xMin, xMax] = pad(extent(shown.map((d) => d.x)), isTime ? DAY / 2 : 1, 0.04);
  const [yMin, yMax] = pad(extent(shown.map((d) => d.y)), 1, 0.08);
  const sx = (x: number) => L + ((x - xMin) / (xMax - xMin)) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
  const [xName, yName] = [p.x!, seriesNames(p)[0]];
  /** A value of an axis field as its `format` says; plain when the field has none. */
  const formatted = (field: string, v: unknown, plain: () => string) => {
    const f = formatFor(p, field);
    return f === undefined ? plain() : formatWith(v, f, ctx.now);
  };
  const tick = (field: string, v: number) => formatted(field, v, () => formatValue(v));
  const fmtY = (v: number) => mapped(p, yName, v) ?? formatted(yName, v, () => formatValue(v, p.decimals) + (p.unit ? ` ${p.unit}` : ""));
  const fmtX = (v: unknown) => mapped(p, xName, v) ?? formatted(xName, v, () => formatValue(v));

  const wrap = el.createDiv({ cls: "na-chart" });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "na-chart-svg", role: "group", "aria-label": `${labelOf(p, yName)} by ${labelOf(p, xName)}` }, wrap);
  for (const t of niceTicks(yMin, yMax)) {
    svg("line", { x1: L, x2: W - R, y1: sy(t), y2: sy(t), class: "na-gridline" }, root);
    svg("text", { x: L - 8, y: sy(t) + 4, class: "na-axis", "text-anchor": "end" }, root).textContent = tick(yName, t);
  }
  const xTicks = isTime
    ? timeTicks(xMin, xMax, Math.max(2, Math.floor((W - L - R) / 80)))
    : niceTicks(xMin, xMax, Math.max(2, Math.floor((W - L - R) / 80))).map((at) => ({ at, label: tick(xName, at) }));
  for (const t of xTicks) svg("text", { x: sx(t.at), y: H - 6, class: "na-axis", "text-anchor": "middle" }, root).textContent = t.label;

  const readout = wrap.createDiv({ cls: "na-readout" });
  const axes = `x: ${labelOf(p, xName)} · y: ${labelOf(p, yName)}`;
  readout.setText(axes);
  const texts = new WeakMap<Element, string>();
  for (const d of shown) {
    const text = p.item ? fillWith(p.item, d.row, (path, v) => display(p, path, v, ctx.now, "text")) : `${fmtX(getPath(d.row, xName))}, ${fmtY(d.y)}`;
    const dot = svg("circle", { cx: sx(d.x), cy: sy(d.y), r: RADIUS, class: "na-scatter-dot na-s1", tabindex: 0 }, root);
    svg("title", {}, dot).textContent = text;
    texts.set(dot, text);
    if (picks(p)) {
      selectable(dot, p, ctx, d.row, text);
    } else {
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", text);
    }
  }
  // One listener each rather than a pair per dot: what the pointer or focus is on is read out.
  for (const on of ["pointerover", "focusin"]) root.addEventListener(on, (e) => readout.setText(texts.get(e.target as Element) ?? axes));
  for (const off of ["pointerleave", "focusout"]) root.addEventListener(off, () => readout.setText(axes));
  if (dots.length > shown.length) {
    el.createDiv({ cls: "na-label", text: `Showing ${shown.length.toLocaleString()} of ${dots.length.toLocaleString()}` });
  }
}

/** A min and max with a margin of `by` of their range (or `flat` either side when they're equal). */
function pad([min, max]: [number, number], flat: number, by: number): [number, number] {
  if (min === max) return [min - flat, max + flat];
  const margin = (max - min) * by;
  return [min - margin, max + margin];
}

export const scatter: ViewDef = {
  id: "scatter",
  keys: [...DATA_KEYS, "x", "y", "item", "label", "unit", "decimals", "format", "labels", "values", "select", "detail"],
  span: 2,
  needsSource: true,
  validate(p: Panel) {
    const ys = seriesNames(p);
    return [...(p.x && ys.length ? [] : ["scatter needs x and y"]), ...(ys.length > 1 ? ["scatter takes one y"] : []), ...formatErrors(p)];
  },
  examples: [
    { panel: { view: "scatter", source: "cars", x: "weight", y: "mpg", item: "{name}: {mpg} mpg", unit: "mpg" } },
    { panel: { view: "scatter", source: "weights", x: "at", y: "weight", select: "day" } },
    { panel: { view: "scatter", source: "cars", x: "weight", y: "mpg", format: { weight: "0,0 lb", mpg: "0.0 mpg" }, labels: { weight: "Weight", mpg: "Efficiency" } } },
    { panel: { view: "scatter", source: "cars", x: "weight", y: "mpg", item: "{name} ({size})", values: { size: { 1: "small", 2: "large" } } } },
    { panel: { view: "scatter", source: "cars", x: "weight", y: "mpg", format: "dollars" }, errors: ['format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
    { panel: { view: "scatter", source: "cars", x: "weight" }, errors: ["scatter needs x and y"] },
    { panel: { view: "scatter", source: "cars", x: "weight", y: ["mpg", "price"] }, errors: ["scatter takes one y"] },
    { panel: { view: "scatter", source: "cars", x: "weight", y: "mpg", group: "make" }, errors: ['"group" doesn\'t apply to scatter'] },
  ],
  mount(el, p, ctx, key): PanelHandle {
    let last: unknown;
    let width: number | undefined;
    const draw = () => {
      el.empty();
      heading(el, p, p.label);
      drawScatter(el, p, ctx, last, width ?? ctx.width(key));
    };
    return {
      update(data) { last = data; draw(); },
      resize(w) { width = w; draw(); },
    };
  },
};
