import { extent, formatValue, seriesOf, toTime, type Per, type Point } from "../data.ts";
import type { Panel } from "../spec.ts";
import { DATA_KEYS, GROUP_KEYS, groupedTotals, heading } from "./common.ts";
import type { PanelHandle, ViewDef } from "./registry.ts";

const NS = "http://www.w3.org/2000/svg";
const H = 220, L = 52, R = 14, T = 14, B = 26;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
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

export interface ChartOptions {
  kind: "line" | "bar";
  /** Pixel width the chart will be shown at, so its text stays at its CSS size. */
  width: number;
  unit?: string;
  decimals?: number;
  /** Grouped by period: axis labels name the period. */
  per?: Per;
}

export function renderChart(parent: HTMLElement, points: Point[], opts: ChartOptions): void {
  const W = Math.max(280, Math.round(opts.width));
  if (points.length === 0) {
    parent.createDiv({ cls: "na-empty", text: "No data to chart yet." });
    return;
  }
  const times = points.map((p) => toTime(p.x));
  const isTime = times.every((t) => t !== undefined);
  const xs = isTime ? (times as number[]) : points.map((_, i) => i);
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const pts = order.map((i) => ({ x: xs[i], y: points[i].y, label: points[i].x }));

  let [yMin, yMax] = extent(pts.map((p) => p.y));
  if (opts.kind === "bar") { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  if (opts.kind === "line") { yMin -= pad; yMax += pad; } else { yMax += pad; }

  const xMin = pts[0].x, xMax = pts[pts.length - 1].x;
  const span = xMax - xMin;
  const bandW = (W - L - R) / pts.length;
  const sx = (x: number, i: number) =>
    opts.kind === "bar" || span === 0 ? L + bandW * (i + 0.5) : L + ((x - xMin) / span) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
  const fmt = (v: number) => formatValue(v, opts.decimals) + (opts.unit ? ` ${opts.unit}` : "");
  const xLabel = (p: (typeof pts)[number]) => (isTime ? formatTime(p.x, span, opts.per) : String(p.label ?? ""));

  const wrap = parent.createDiv({ cls: "na-chart" });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "na-chart-svg", role: "img" }, wrap);

  for (const t of niceTicks(yMin, yMax)) {
    const y = sy(t);
    svg("line", { x1: L, x2: W - R, y1: y, y2: y, class: "na-gridline" }, root);
    svg("text", { x: L - 8, y: y + 4, class: "na-axis", "text-anchor": "end" }, root).textContent = formatValue(t);
  }
  // Categories each get a label while they fit; a time axis gets its ends and middle.
  const labelIdx = !isTime && opts.kind === "bar" && pts.length <= 12 ? pts.map((_, i) => i)
    : pts.length <= 1 ? [0] : [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const every = labelIdx.length > 3;
  for (const i of new Set(labelIdx)) {
    const anchor = every ? "middle" : i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle";
    svg("text", { x: sx(pts[i].x, i), y: H - 6, class: "na-axis", "text-anchor": anchor }, root).textContent = xLabel(pts[i]);
  }

  if (opts.kind === "line") {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x, i).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
    const base = sy(yMin);
    svg("path", { d: `${d}L${sx(xMax, pts.length - 1).toFixed(1)},${base}L${sx(xMin, 0).toFixed(1)},${base}Z`, class: "na-area" }, root);
    svg("path", { d, class: "na-line" }, root);
    const last = pts[pts.length - 1];
    svg("circle", { cx: sx(last.x, pts.length - 1), cy: sy(last.y), r: 3.5, class: "na-dot" }, root);
  } else {
    const zero = sy(0);
    pts.forEach((p, i) => {
      const y = sy(p.y);
      svg("rect", {
        x: L + bandW * i + bandW * 0.15, width: Math.max(1, bandW * 0.7),
        y: Math.min(y, zero), height: Math.max(1, Math.abs(zero - y)), class: "na-bar", rx: 2,
      }, root);
    });
  }

  const cursor = svg("line", { y1: T, y2: H - B, class: "na-cursor", visibility: "hidden" }, root);
  const readout = wrap.createDiv({ cls: "na-readout" });
  const showPoint = (i: number) => {
    const p = pts[i];
    readout.setText(`${xLabel(p)} · ${fmt(p.y)}`);
    cursor.setAttribute("x1", String(sx(p.x, i)));
    cursor.setAttribute("x2", String(sx(p.x, i)));
  };
  showPoint(pts.length - 1);
  root.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(sx(p.x, i) - px) < Math.abs(sx(pts[best].x, best) - px)) best = i; });
    cursor.setAttribute("visibility", "visible");
    showPoint(best);
  });
  root.addEventListener("pointerleave", () => {
    cursor.setAttribute("visibility", "hidden");
    showPoint(pts.length - 1);
  });
}

function chartView(kind: "line" | "bar"): ViewDef {
  return {
    id: kind,
    keys: [...DATA_KEYS, ...GROUP_KEYS, "x", "y", "agg", "label", "unit", "decimals"],
    wide: true,
    needsSource: true,
    validate: (p: Panel) => p.group
      ? [...(p.x ? ["leave out x: the x axis is the group"] : []), ...groupedTotals(p, p.y ? [p.y] : [], "y")]
      : [...(p.x && p.y ? [] : [`${kind} needs x and y`]), ...groupedTotals(p, [], "y")],
    examples: [
      { panel: { view: kind, source: "sessions", group: "at", per: "week", y: "minutes", agg: "sum", where: { at: "last 8 weeks" } } },
      { panel: { view: kind, source: "notes", from: "Books", group: "genre" } },
      { panel: { view: kind, source: "sessions", group: "at", per: "week", y: "minutes" }, errors: ["group with y needs agg (sum, avg, min, max, first or last)"] },
      { panel: { view: kind, source: "sessions", group: "at", x: "at" }, errors: ["leave out x: the x axis is the group"] },
      { panel: { view: kind, source: "weights", x: "at", y: "weight", unit: "kg" } },
      { panel: { view: kind, source: "https://api.example.com/hourly", pick: "hourly", x: "time", y: "temperature_2m" } },
      { panel: { view: kind, source: "weights", x: "at" }, errors: [`${kind} needs x and y`] },
    ],
    mount(el, p, ctx): PanelHandle {
      let last: unknown;
      let width = ctx.chartWidth;
      const draw = () => {
        el.empty();
        heading(el, p, p.label);
        const x = p.group ?? p.x!;
        const y = p.y ?? "count";
        renderChart(el, seriesOf(last, x, y), { kind, unit: p.unit, decimals: p.decimals, width, per: p.per });
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
