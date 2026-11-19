import { extent, formatValue, getPath, seriesOf, toTime, type Per, type Point, type Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import { DATA_KEYS, GROUP_KEYS, groupedTotals, heading, selectable, seriesNames } from "./common.ts";
import type { PanelHandle, ViewDef } from "./registry.ts";

const NS = "http://www.w3.org/2000/svg";
const H = 220, L = 52, R = 14, T = 14, B = 26;
/** Most series one chart draws: past this, colours stop being told apart. */
export const MAX_SERIES = 6;
/** Bars are at most this wide, with a gap between neighbours and rounded data ends. */
const BAR_MAX = 24, GAP = 2, RADIUS = 4;

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.appendChild(el);
  return el;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

function formatTime(t: number, span: number, per?: Per): string {
  const d = new Date(t);
  if (per === "year") return String(d.getFullYear());
  if (per === "month") return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  if (per) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (span < 2 * 86_400_000) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (span < 400 * 86_400_000) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** A bar from the baseline y0 to the value at y1, square at the baseline and rounded at the value. */
function barPath(x: number, w: number, y0: number, y1: number): string {
  const r = Math.min(RADIUS, w / 2, Math.abs(y1 - y0));
  const s = y1 <= y0 ? 1 : -1;
  return `M${x},${y0}V${y1 + s * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + s * r}V${y0}Z`;
}

export interface Series { name: string; points: Point[] }

export interface ChartOptions {
  kind: "line" | "bar";
  /** Pixel width the chart will be shown at, so its text stays at its CSS size. */
  width: number;
  unit?: string;
  decimals?: number;
  /** Grouped by period: axis labels name the period. */
  per?: Per;
  /** Selection hook: called with each bar drawn and the x value it stands for. */
  mark?(el: SVGElement, x: unknown): void;
}

/** A colour swatch and name; text keeps the text colour, the swatch carries the series colour. */
export function legendItem(parent: HTMLElement, colour: string, name: string): HTMLElement {
  const item = parent.createSpan({ cls: "na-legend-item" });
  item.createSpan({ cls: `na-swatch ${colour}` });
  item.createSpan({ text: name });
  return item;
}

export function renderChart(parent: HTMLElement, series: Series[], opts: ChartOptions): void {
  const W = Math.max(280, Math.round(opts.width));
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) {
    parent.createDiv({ cls: "na-empty", text: "No data to chart yet." });
    return;
  }
  // One shared x axis: times in order, or categories in the order they first appear.
  const isTime = all.every((p) => toTime(p.x) !== undefined);
  const keyOf = (x: unknown) => (isTime ? toTime(x)! : String(x ?? ""));
  const keys: (number | string)[] = [];
  const label = new Map<number | string, unknown>();
  for (const p of all) {
    const k = keyOf(p.x);
    if (!label.has(k)) { label.set(k, p.x); keys.push(k); }
  }
  if (isTime) (keys as number[]).sort((a, b) => a - b);
  const index = new Map(keys.map((k, i) => [k, i]));
  const n = keys.length;

  let [yMin, yMax] = extent(all.map((p) => p.y));
  if (opts.kind === "bar") { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  if (opts.kind === "line") { yMin -= pad; yMax += pad; } else { yMax += pad; }

  const span = isTime ? (keys[n - 1] as number) - (keys[0] as number) : n - 1;
  const bandW = (W - L - R) / n;
  const pos = (i: number) => (isTime ? (keys[i] as number) - (keys[0] as number) : i);
  const sx = (i: number) => opts.kind === "bar" || span === 0 ? L + bandW * (i + 0.5) : L + (pos(i) / span) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
  const fmt = (v: number) => formatValue(v, opts.decimals) + (opts.unit ? ` ${opts.unit}` : "");
  const xLabel = (i: number) => (isTime ? formatTime(keys[i] as number, span, opts.per) : String(label.get(keys[i]) ?? ""));
  // One series wears the theme accent; several take the chart palette in a fixed order.
  const colour = (s: number) => (series.length === 1 ? "na-accent" : `na-s${s + 1}`);

  const wrap = parent.createDiv({ cls: "na-chart" });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "na-chart-svg", role: "img" }, wrap);

  for (const t of niceTicks(yMin, yMax)) {
    const y = sy(t);
    svg("line", { x1: L, x2: W - R, y1: y, y2: y, class: "na-gridline" }, root);
    svg("text", { x: L - 8, y: y + 4, class: "na-axis", "text-anchor": "end" }, root).textContent = formatValue(t);
  }
  // Categories each get a label while they fit; a time axis gets its ends and middle.
  const labelIdx = !isTime && opts.kind === "bar" && n <= 12 ? keys.map((_, i) => i)
    : n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const every = labelIdx.length > 3;
  for (const i of new Set(labelIdx)) {
    const anchor = every ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    svg("text", { x: sx(i), y: H - 6, class: "na-axis", "text-anchor": anchor }, root).textContent = xLabel(i);
  }

  // Each series' values by x position; a missing value leaves a gap (bars) or is joined across (lines).
  const values = series.map((s) => {
    const byIndex = new Map<number, number>();
    for (const p of s.points) byIndex.set(index.get(keyOf(p.x))!, p.y);
    return byIndex;
  });

  if (opts.kind === "line") {
    values.forEach((byIndex, s) => {
      const pts = [...byIndex].sort((a, b) => a[0] - b[0]);
      if (pts.length === 0) return;
      const d = pts.map(([i, y], j) => `${j ? "L" : "M"}${sx(i).toFixed(1)},${sy(y).toFixed(1)}`).join("");
      if (series.length === 1) {
        const base = sy(yMin);
        const [first, last] = [pts[0][0], pts[pts.length - 1][0]];
        svg("path", { d: `${d}L${sx(last).toFixed(1)},${base}L${sx(first).toFixed(1)},${base}Z`, class: `na-area ${colour(s)}` }, root);
      }
      svg("path", { d, class: `na-line ${colour(s)}` }, root);
      const [li, ly] = pts[pts.length - 1];
      svg("circle", { cx: sx(li), cy: sy(ly), r: 4, class: `na-dot ${colour(s)}` }, root);
    });
  } else {
    const m = series.length;
    const w = Math.max(1, Math.min(BAR_MAX, (bandW - GAP * m) / m));
    const zero = sy(0);
    values.forEach((byIndex, s) => {
      for (const [i, y] of byIndex) {
        if (y === 0) continue;
        const x = sx(i) - (m * w + (m - 1) * GAP) / 2 + s * (w + GAP);
        const bar = svg("path", { d: barPath(x, w, zero, sy(y)), class: `na-bar ${colour(s)}` }, root);
        opts.mark?.(bar, label.get(keys[i]));
      }
    });
  }

  if (series.length > 1) {
    const legend = wrap.createDiv({ cls: "na-legend" });
    series.forEach((s, i) => legendItem(legend, colour(i), s.name));
  }

  const cursor = svg("line", { y1: T, y2: H - B, class: "na-cursor", visibility: "hidden" }, root);
  const readout = wrap.createDiv({ cls: "na-readout" });
  const showPoint = (i: number) => {
    readout.empty();
    readout.createSpan({ text: xLabel(i) });
    values.forEach((byIndex, s) => {
      const y = byIndex.get(i);
      if (y === undefined) return;
      if (series.length === 1) readout.createSpan({ text: ` · ${fmt(y)}` });
      else legendItem(readout, colour(s), `${series[s].name} ${fmt(y)}`);
    });
    cursor.setAttribute("x1", String(sx(i)));
    cursor.setAttribute("x2", String(sx(i)));
  };
  showPoint(n - 1);
  root.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(sx(i) - px) < Math.abs(sx(best) - px)) best = i;
    cursor.setAttribute("visibility", "visible");
    showPoint(best);
  });
  root.addEventListener("pointerleave", () => {
    cursor.setAttribute("visibility", "hidden");
    showPoint(n - 1);
  });
}

/** The row behind a bar: the data (or group) row whose x is `at`, else one made of the series' values there. */
function rowAt(data: unknown, x: string, at: unknown, series: Series[]): Row {
  const found = Array.isArray(data) ? data.find((r) => r !== null && typeof r === "object" && String(getPath(r, x)) === String(at)) : undefined;
  return (found as Row | undefined) ?? Object.fromEntries([[x, at], ...series.map((s) => [s.name, s.points.find((pt) => pt.x === at)?.y ?? null])]);
}

function chartView(kind: "line" | "bar"): ViewDef {
  return {
    id: kind,
    keys: [...DATA_KEYS, ...GROUP_KEYS, "x", "y", "agg", "label", "unit", "decimals", "alert", ...(kind === "bar" ? ["select"] : [])],
    span: 4,
    needsSource: true,
    validate(p: Panel) {
      const ys = seriesNames(p);
      const many = ys.length > MAX_SERIES ? [`at most ${MAX_SERIES} series in y`] : [];
      if (p.group) return [...(p.x ? ["leave out x: the x axis is the group"] : []), ...groupedTotals(p, ys, "y"), ...many];
      return [...(p.x && ys.length ? [] : [`${kind} needs x and y`]), ...groupedTotals(p, [], "y"), ...many];
    },
    examples: [
      { panel: { view: kind, source: "weights", x: "at", y: "weight", unit: "kg" } },
      { panel: { view: kind, source: "https://api.example.com/hourly", pick: "hourly", x: "time", y: ["temperature_2m", "apparent_temperature"] } },
      { panel: { view: kind, source: "sessions", group: "at", per: "week", y: "minutes", agg: "sum", where: { at: "last 8 weeks" } } },
      { panel: { view: kind, source: "notes", from: "Books", group: "genre" } },
      { panel: { view: kind, source: "weights", x: "at" }, errors: [`${kind} needs x and y`] },
      { panel: { view: kind, source: "sessions", group: "at", per: "week", y: "minutes" }, errors: ["group with y needs agg (sum, avg, min, max, first or last)"] },
      { panel: { view: kind, source: "sessions", group: "at", x: "at" }, errors: ["leave out x: the x axis is the group"] },
      { panel: { view: kind, source: "s", x: "t", y: ["a", "b", "c", "d", "e", "f", "g"] }, errors: [`at most ${MAX_SERIES} series in y`] },
      kind === "bar"
        ? { panel: { view: kind, source: "notes", from: "Books", group: "genre", select: "genre" } }
        : { panel: { view: kind, source: "weights", x: "at", y: "weight", select: "day" }, errors: ['"select" doesn\'t apply to line'] },
    ],
    mount(el, p, ctx, key): PanelHandle {
      let last: unknown;
      let width: number | undefined;
      const draw = () => {
        el.empty();
        heading(el, p, p.label);
        const x = p.group ?? p.x!;
        const ys = seriesNames(p);
        const series = (ys.length ? ys : ["count"]).map((y) => ({ name: y, points: seriesOf(last, x, y) }));
        const mark = p.select ? (bar: SVGElement, at: unknown) => selectable(bar, p, ctx, rowAt(last, x, at, series), String(at)) : undefined;
        renderChart(el, series, { kind, unit: p.unit, decimals: p.decimals, width: width ?? ctx.width(key), per: p.per, mark });
      };
      return {
        update(data) { last = data; draw(); },
        resize(w) { width = w; draw(); },
      };
    },
  };
}

export const line = chartView("line");
export const bar = chartView("bar");
