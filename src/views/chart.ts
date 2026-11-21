import { textOf } from "../text.ts";
import { extent, formatValue, getPath, seriesOf, type Point, type Row } from "../data.ts";
import { periodStart, shiftPeriod, toTime, type Per } from "../time.ts";
import { formatErrors, formatFor, formatWith, labelFor, mapped } from "../format.ts";
import type { Panel } from "../spec.ts";
import { groupedTotals, heading, picks, selectable, seriesNames } from "./common.ts";
import { DATA_KEYS, GROUP_KEYS } from "../keys.ts";
import type { PanelHandle, ViewDef } from "./registry.ts";

const NS = "http://www.w3.org/2000/svg";
/** The frame of a chart: height, and room left, right, top and bottom for the axes. Scatter shares it. */
export const H = 220, L = 52, R = 14, T = 14, B = 26;
/** The room a goal's label gets right of the plot, at least. */
const GUTTER = 64;
/** Most series one chart draws: past this, colours stop being told apart. */
export const MAX_SERIES = 6;
/** Bars are at most this wide, with a gap between neighbours and rounded data ends. */
const BAR_MAX = 46, GAP = 2, RADIUS = 4;

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  // In the parent's own document: a pop-out window has its own.
  const el = parent.ownerDocument.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}

/** Round tick values from `min` to `max`, about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
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

/**
 * A bar from the baseline y0 to the value at y1, square at the baseline and rounded at the value;
 * square at both ends when `round` is false (a segment inside a stack).
 */
function barPath(x: number, w: number, y0: number, y1: number, round = true): string {
  if (!round) return `M${x},${y0}V${y1}H${x + w}V${y0}Z`;
  const r = Math.min(RADIUS, w / 2, Math.abs(y1 - y0));
  const s = y1 <= y0 ? 1 : -1;
  return `M${x},${y0}V${y1 + s * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + s * r}V${y0}Z`;
}

/** `name` is the field; `label` is what to call it when the panel says so. */
export interface Series { name: string; label?: string; points: Point[] }

export interface ChartOptions {
  kind: "line" | "bar";
  /** Pixel width the chart will be shown at, so its text stays at its CSS size. */
  width: number;
  unit?: string;
  decimals?: number;
  /** A series' value as text in the panel's `format`; undefined leaves it to `unit` and `decimals`. */
  format?(value: number, series: number): string | undefined;
  /** Grouped by period: axis labels name the period. */
  per?: Per;
  /** The text of a category on the x axis (not a time axis). */
  category?(x: unknown): string;
  /** Selection hook: called with each bar drawn and the x value it stands for. */
  mark?(el: SVGElement, x: unknown): void;
  /** A dashed line at this value, labelled in a gutter right of the plot, inside the axis range. */
  goal?: number;
  /** Bars of several series become one bar each, their total, with the parts told above. */
  stack?: boolean;
  /** The moment it is: the last bar of a time axis is the current one while its period holds this. */
  now?: Date;
}

/** Each x's total across the series. */
function totalsOf(values: Map<number, number>[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const byIndex of values) for (const [i, y] of byIndex) totals.set(i, (totals.get(i) ?? 0) + y);
  return totals;
}

/** A colour swatch and name; text keeps the text colour, the swatch carries the series colour. */
export function legendItem(parent: HTMLElement, colour: string, name: string): HTMLElement {
  const item = parent.createSpan({ cls: "gz-legend-item" });
  item.createSpan({ cls: `gz-swatch ${colour}` });
  item.createSpan({ cls: "gz-legend-name", text: name });
  return item;
}

export function renderChart(parent: HTMLElement, series: Series[], opts: ChartOptions): void {
  const W = Math.max(280, Math.round(opts.width));
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) {
    parent.createDiv({ cls: "gz-empty", text: "No data to chart yet." });
    return;
  }
  // One shared x axis: times in order, or categories in the order they first appear.
  const isTime = all.every((p) => toTime(p.x) !== undefined);
  const keyOf = (x: unknown) => (isTime ? toTime(x)! : textOf(x ?? ""));
  const keys: (number | string)[] = [];
  const label = new Map<number | string, unknown>();
  for (const p of all) {
    const k = keyOf(p.x);
    if (!label.has(k)) { label.set(k, p.x); keys.push(k); }
  }
  if (isTime) (keys as number[]).sort((a, b) => a - b);
  const index = new Map(keys.map((k, i) => [k, i]));
  const n = keys.length;

  // Each series' values by x position; a missing value leaves a gap (bars) or is joined across (lines).
  const values = series.map((s) => {
    const byIndex = new Map<number, number>();
    for (const p of s.points) byIndex.set(index.get(keyOf(p.x))!, p.y);
    return byIndex;
  });
  const isLine = opts.kind === "line";
  const stacked = !isLine && !!opts.stack && series.length > 1;
  // A bar chart of one series, or a stack, draws one bar per x: the value, or the total.
  const totals = stacked ? totalsOf(values) : values[0];
  const oneBar = !isLine && (stacked || series.length === 1);

  let [yMin, yMax] = stacked ? extent([0, ...totals.values()]) : extent(all.map((p) => p.y));
  if (opts.goal !== undefined) { yMin = Math.min(yMin, opts.goal); yMax = Math.max(yMax, opts.goal); }
  if (!isLine) { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  if (isLine) { yMin -= pad; yMax += pad; } else { yMax += pad; }

  const fmt = (v: number, s = 0) => opts.format?.(v, s) ?? formatValue(v, opts.decimals) + (opts.unit ? ` ${opts.unit}` : "");
  // The last point of each line; the first series' value is written beside it.
  const ends = isLine ? values.map((byIndex) => {
    const i = Math.max(...byIndex.keys());
    const y = byIndex.get(i);
    return y === undefined ? undefined : { i, y };
  }) : [];
  const end = ends[0];
  const endText = end && fmt(end.y);
  const goalText = opts.goal === undefined ? undefined : isLine ? `Goal ${fmt(opts.goal)}` : `${fmt(opts.goal)} goal`;
  // Labels at the end of the plot get a gutter of their own, so they never sit on bars or the line.
  const room = (text: string | undefined, em: number) => (text ? Math.ceil(text.length * em) + 14 : R);
  const right = Math.max(goalText ? GUTTER : R, room(goalText, 6.4), room(endText, 7.2));

  const span = isTime ? (keys[n - 1] as number) - (keys[0] as number) : n - 1;
  const bandW = (W - L - right) / n;
  const pos = (i: number) => (isTime ? (keys[i] as number) - (keys[0] as number) : i);
  const sx = (i: number) => !isLine || span === 0 ? L + bandW * (i + 0.5) : L + (pos(i) / span) * (W - L - right);
  const sy = (y: number) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
  const xLabel = (i: number) => (isTime ? formatTime(keys[i] as number, span, opts.per) : opts.category?.(label.get(keys[i])) ?? textOf(label.get(keys[i]) ?? ""));
  const name = (s: number) => series[s].label ?? series[s].name;
  // Several series take the chart palette in a fixed order; one is drawn in ink and pencil.
  const colour = (s: number) => (series.length === 1 ? "" : `gz-s${s + 1}`);
  const classes = (...cls: (string | false)[]) => cls.filter(Boolean).join(" ");
  /** Whether the period of the bar at i holds the present: only the last bar of a time axis can. */
  const current = (i: number) => {
    if (!isTime || i !== n - 1 || opts.now === undefined) return false;
    const per = opts.per ?? "day";
    const start = periodStart(keys[i] as number, per);
    return +opts.now >= start && +opts.now < shiftPeriod(start, per, 1);
  };

  const wrap = parent.createDiv({ cls: "gz-chart" });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "gz-chart-svg", role: "img" }, wrap);

  for (const t of niceTicks(yMin, yMax)) {
    const y = sy(t);
    svg("line", { x1: L, x2: W - right, y1: y, y2: y, class: "gz-gridline" }, root);
    svg("text", { x: L - 8, y: y + 4, class: "gz-axis", "text-anchor": "end" }, root).textContent = opts.format?.(t, 0) ?? formatValue(t);
  }
  // Bars each get a label while they fit (a date needs about 52 px); otherwise the ends and middle.
  const labelIdx = !isLine && n <= 12 && (!isTime || bandW >= 52) ? keys.map((_, i) => i)
    : n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const every = labelIdx.length > 3;
  for (const i of new Set(labelIdx)) {
    const anchor = every ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    svg("text", { x: sx(i), y: H - 6, class: "gz-axis", "text-anchor": anchor }, root).textContent = xLabel(i);
  }

  const barAt = new Map<number, SVGElement>();
  if (isLine) {
    values.forEach((byIndex, s) => {
      const pts = [...byIndex].sort((a, b) => a[0] - b[0]);
      if (pts.length === 0) return;
      const d = pts.map(([i, y], j) => `${j ? "L" : "M"}${sx(i).toFixed(1)},${sy(y).toFixed(1)}`).join("");
      if (series.length === 1) {
        const base = sy(yMin);
        const [first, last] = [pts[0][0], pts[pts.length - 1][0]];
        svg("path", { d: `${d}L${sx(last).toFixed(1)},${base}L${sx(first).toFixed(1)},${base}Z`, class: "gz-area" }, root);
      }
      svg("path", { d, class: classes("gz-line", colour(s)) }, root);
    });
  } else if (oneBar) {
    const w = Math.max(1, Math.min(BAR_MAX, bandW - GAP));
    const zero = sy(0);
    for (const [i, y] of totals) {
      if (y === 0) continue;
      const over = opts.goal !== undefined && y > opts.goal;
      const bar = svg("path", { d: barPath(sx(i) - w / 2, w, zero, sy(y)), class: classes("gz-bar", current(i) && "is-now", over && "is-over") }, root);
      barAt.set(i, bar);
      opts.mark?.(bar, label.get(keys[i]));
    }
  } else {
    const m = series.length;
    const w = Math.max(1, Math.min(BAR_MAX, (bandW - GAP * m) / m));
    const zero = sy(0);
    values.forEach((byIndex, s) => {
      for (const [i, y] of byIndex) {
        if (y === 0) continue;
        const x = sx(i) - (m * w + (m - 1) * GAP) / 2 + s * (w + GAP);
        const bar = svg("path", { d: barPath(x, w, zero, sy(y)), class: classes("gz-bar", colour(s)) }, root);
        opts.mark?.(bar, label.get(keys[i]));
      }
    });
  }

  if (opts.goal !== undefined) {
    const y = sy(opts.goal);
    svg("line", { x1: L, x2: W - right, y1: y, y2: y, class: "gz-goal" }, root);
    root.setAttribute("aria-label", `goal ${fmt(opts.goal)}`);
  }
  const hoverDots = isLine ? series.map((_, s) => svg("circle", { r: 4, class: classes("gz-hover-dot", colour(s)), visibility: "hidden" }, root)) : [];
  if (isLine) {
    ends.forEach((e, s) => e && svg("circle", { cx: sx(e.i), cy: sy(e.y), r: 4.5, class: classes("gz-dot", colour(s)) }, root));
  }
  // The end label and the goal's share the gutter; a line ending near its goal parts them around their midpoint.
  let endY = end ? sy(end.y) + 4 : 0;
  let goalY = opts.goal === undefined ? 0 : sy(opts.goal) + 4;
  if (end && goalText && Math.abs(endY - goalY) < 14) {
    const mid = (endY + goalY) / 2;
    [endY, goalY] = endY <= goalY ? [mid - 7, mid + 7] : [mid + 7, mid - 7];
  }
  if (end) svg("text", { x: sx(end.i) + 9, y: endY, class: "gz-end-label" }, root).textContent = endText!;
  if (goalText) svg("text", { x: W - right + 8, y: goalY, class: "gz-goal-label" }, root).textContent = goalText;

  // Above the chart, the point shown (the last, or the one under the pointer). A stack tells the
  // composition of its bar: when and total, a strip of the parts, then each part with its value.
  // Several series, or one the panel names, get a legend that carries each value; one unnamed
  // series, a readout.
  const cursor = isLine || !oneBar ? svg("line", { y1: T, y2: H - B, class: "gz-cursor", visibility: "hidden" }, root) : undefined;
  let showValues: (i: number) => void;
  if (stacked) {
    const head = createDivBefore(wrap, root, "gz-stack-head");
    const when = head.createSpan({ cls: "gz-stack-when" });
    const total = head.createSpan({ cls: "gz-stack-total" });
    const strip = createDivBefore(wrap, root, "gz-strip");
    const legend = createDivBefore(wrap, root, "gz-legend");
    const cells = series.map((_, s) => legendItem(legend, colour(s), name(s)).createSpan({ cls: "gz-legend-value" }));
    showValues = (i) => {
      const sum = totals.get(i) ?? 0;
      when.textContent = opts.per === "week" ? `Week of ${xLabel(i)}` : xLabel(i);
      total.empty();
      total.createEl("b", { text: fmt(sum) });
      if (opts.goal !== undefined) total.createSpan({ cls: "gz-stack-of", text: ` of ${fmt(opts.goal)}` });
      if (opts.goal !== undefined && sum > opts.goal) total.createSpan({ cls: "gz-stack-over", text: ` · ${fmt(sum - opts.goal)} over` });
      strip.empty();
      values.forEach((byIndex, s) => {
        const y = byIndex.get(i);
        if (y !== undefined && y > 0) strip.createSpan({ cls: colour(s) }).style.flexGrow = String(y);
        cells[s].textContent = y === undefined ? "–" : fmt(y, s);
        cells[s].parentElement!.classList.toggle("gz-zero", !y);
      });
    };
  } else if (series.length > 1 || series[0].label !== undefined) {
    const legend = createDivBefore(wrap, root, "gz-legend");
    const at = legend.createSpan({ cls: "gz-legend-at" });
    const cells = series.map((_, s) => legendItem(legend, colour(s), name(s)).createSpan({ cls: "gz-legend-value" }));
    showValues = (i) => {
      at.textContent = xLabel(i);
      values.forEach((byIndex, s) => {
        const y = byIndex.get(i);
        cells[s].textContent = y === undefined ? "–" : fmt(y, s);
        cells[s].parentElement!.classList.toggle("gz-zero", !y);
      });
    };
  } else {
    const readout = createDivBefore(wrap, root, "gz-readout");
    showValues = (i) => {
      readout.empty();
      readout.createSpan({ text: xLabel(i) });
      const y = values[0].get(i);
      if (y !== undefined) readout.createSpan({ text: ` · ${fmt(y)}` });
    };
  }
  let hovered: SVGElement | undefined;
  /** Shows the point at x position i, as under the pointer; none shows the last one. */
  const showPoint = (i?: number) => {
    showValues(i ?? n - 1);
    hovered?.classList.remove("is-hover");
    hovered = i === undefined ? undefined : barAt.get(i);
    hovered?.classList.add("is-hover");
    cursor?.setAttribute("visibility", i === undefined ? "hidden" : "visible");
    if (i !== undefined) {
      cursor?.setAttribute("x1", String(sx(i)));
      cursor?.setAttribute("x2", String(sx(i)));
    }
    hoverDots.forEach((dot, s) => {
      const y = i === undefined ? undefined : values[s].get(i);
      dot.setAttribute("visibility", y === undefined ? "hidden" : "visible");
      if (i !== undefined && y !== undefined) {
        dot.setAttribute("cx", String(sx(i)));
        dot.setAttribute("cy", String(sy(y)));
      }
    });
  };
  showPoint();
  root.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(sx(i) - px) < Math.abs(sx(best) - px)) best = i;
    showPoint(best);
  });
  // A bar under the pointer or focused is the point shown, wherever in its band the pointer is.
  for (const on of ["pointerover", "focusin"]) {
    root.addEventListener(on, (e) => {
      const at = [...barAt].find(([, bar]) => bar === e.target);
      if (at) showPoint(at[0]);
    });
  }
  for (const off of ["pointerleave", "focusout"]) root.addEventListener(off, () => showPoint());
}

function createDivBefore(parent: HTMLElement, before: Element, cls: string): HTMLElement {
  const el = parent.createDiv({ cls });
  parent.insertBefore(el, before);
  return el;
}

/** The row behind a bar: the data (or group) row whose x is `at`, else one made of the series' values there. */
function rowAt(data: unknown, x: string, at: unknown, series: Series[]): Row {
  const found: unknown = Array.isArray(data) ? (data as unknown[]).find((r) => r !== null && typeof r === "object" && String(getPath(r, x)) === String(at)) : undefined;
  const values = series.map((s): [string, unknown] => [s.name, s.points.find((pt) => pt.x === at)?.y ?? null]);
  return (found as Row | undefined) ?? Object.fromEntries<unknown>([[x, at], ...values]);
}

function chartView(kind: "line" | "bar"): ViewDef {
  return {
    id: kind,
    keys: [...DATA_KEYS, ...GROUP_KEYS, "x", "y", "agg", "of", "label", "unit", "decimals", "format", "labels", "values", "goal", "alert", ...(kind === "bar" ? ["select", "detail", "stack"] : [])],
    span: 4,
    needsSource: true,
    validate(p: Panel) {
      const ys = seriesNames(p);
      const many = ys.length > MAX_SERIES ? [`at most ${MAX_SERIES} series in y`] : [];
      const other = [...formatErrors(p), ...(p.stack && ys.length < 2 ? ["stack needs two or more y series"] : [])];
      if (p.group) return [...(p.x ? ["leave out x: the x axis is the group"] : []), ...groupedTotals(p, ys, "y"), ...many, ...other];
      return [...(p.x && ys.length ? [] : [`${kind} needs x and y`]), ...groupedTotals(p, [], "y"), ...many, ...other];
    },
    examples: [
      { panel: { view: kind, source: "weights", x: "at", y: "weight", unit: "kg" } },
      { panel: { view: kind, source: "https://api.example.com/hourly", pick: "hourly", x: "time", y: ["temperature_2m", "humidity"], format: { temperature_2m: "0.0 °C", humidity: "0 %" } } },
      { panel: { view: kind, source: "weights", x: "at", y: "weight", unit: "kg", goal: 70 } },
      { panel: { view: kind, source: "weights", x: "at", y: "weight", goal: "light" }, errors: ['"goal" has the wrong type (expected number)'] },
      { panel: { view: kind, source: "weights", x: "at", y: "weight", format: "kilos" }, errors: ['format "kilos" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
      { panel: { view: kind, source: "https://api.example.com/daily", pick: "daily", x: "time", y: ["temperature_2m_max", "temperature_2m_min"], labels: { temperature_2m_max: "High", temperature_2m_min: "Low" } } },
      { panel: { view: kind, source: "weights", x: "at", y: "weight", labels: "Weight" }, errors: ['"labels" has the wrong type (expected a set of name: text)'] },
      { panel: { view: kind, source: "notes", from: "Health", group: "kind", values: { kind: { dr: "Doctor" } } } },
      { panel: { view: kind, source: "notes", from: "Health", group: "kind", values: { kind: "Doctor" } }, errors: ['"values" has the wrong type (expected a set of field: {value: text})'] },
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
      ...(kind === "bar" ? [
        { panel: { view: kind, source: "spending", group: "at", per: "week", y: ["food", "rent"], agg: "sum", stack: true } },
        { panel: { view: kind, source: "spending", group: "at", per: "week", y: "food", agg: "sum", stack: true }, errors: ["stack needs two or more y series"] },
        { panel: { view: kind, source: "spending", group: "category", stack: true }, errors: ["stack needs two or more y series"] },
        { panel: { view: kind, source: "spending", group: "category", y: "amount", agg: "sum", detail: "{category}: {amount} over {count} entries" } },
        { panel: { view: kind, source: "decisions", group: "confidence", agg: "share", of: { outcome: "right" } } },
        { panel: { view: kind, source: "decisions", group: "confidence", y: "hit", agg: "share", of: { outcome: "right" } }, errors: ['agg: share gives each group its share; use share in y, not "hit"'] },
      ] : [
        { panel: { view: kind, source: "weights", x: "at", y: ["a", "b"], stack: true }, errors: ['"stack" doesn\'t apply to line'] },
        { panel: { view: kind, source: "weights", x: "at", y: "weight", detail: "{weight} on {at}" }, errors: ['"detail" doesn\'t apply to line'] },
      ]),
    ],
    mount(el, p, ctx, key): PanelHandle {
      let last: unknown;
      let width: number | undefined;
      const draw = () => {
        el.empty();
        heading(el, p, p.label);
        const x = p.group ?? p.x!;
        const ys = seriesNames(p);
        const series = (ys.length ? ys : ["count"]).map((y) => ({ name: y, label: labelFor(p, y), points: seriesOf(last, x, y) }));
        const mark = picks(p) ? (bar: SVGElement, at: unknown) => selectable(bar, p, ctx, rowAt(last, x, at, series), String(at)) : undefined;
        const format = (v: number, s: number) => {
          const f = formatFor(p, series[s].name);
          return f === undefined ? undefined : formatWith(v, f, ctx.now);
        };
        const category = (at: unknown) => mapped(p, x, at) ?? textOf(at ?? "");
        renderChart(el, series, {
          kind, unit: p.unit, decimals: p.decimals, format, category, width: width ?? ctx.width(key), per: p.per, mark, goal: p.goal, stack: p.stack, now: ctx.now,
        });
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
