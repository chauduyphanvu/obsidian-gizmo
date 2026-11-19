import { formatValue, getPath, toNumber } from "../data.ts";
import { NONE } from "../group.ts";
import type { Panel } from "../spec.ts";
import { legendItem, svg } from "./chart.ts";
import { DATA_KEYS, GROUP_KEYS, groupedTotals, heading, redraw, rowsOf, selectable, seriesNames } from "./common.ts";
import type { ViewDef } from "./registry.ts";

/** Most slices drawn; past this the smallest fold into "Other". */
export const MAX_SLICES = 6;
const SIZE = 168, RING = 26;

export interface Slice { name: string; value: number; colour: string }

/** Slices largest first, values of zero or less dropped, the smallest folded into "Other". */
export function slicesOf(rows: unknown[], nameField: string, valueField: string): Slice[] {
  const raw = rows
    .map((r) => ({ name: String(getPath(r, nameField) ?? NONE), value: toNumber(getPath(r, valueField)) ?? 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  const shown = raw.length > MAX_SLICES ? raw.slice(0, MAX_SLICES - 1) : raw;
  // Colours follow the names, not the sizes, so a slice keeps its colour as values change.
  const names = shown.map((s) => s.name).sort((a, b) => a.localeCompare(b));
  const slices = shown.map((s) => ({ ...s, colour: `na-s${names.indexOf(s.name) + 1}` }));
  const rest = raw.slice(shown.length);
  if (rest.length) slices.push({ name: "Other", value: rest.reduce((sum, s) => sum + s.value, 0), colour: "na-other" });
  return slices;
}

function arc(a0: number, a1: number): string {
  const c = SIZE / 2, R = c - 2, r = R - RING;
  const at = (rad: number, a: number) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${at(R, a0)}A${R},${R} 0 ${large} 1 ${at(R, a1)}L${at(r, a1)}A${r},${r} 0 ${large} 0 ${at(r, a0)}Z`;
}

export const pie: ViewDef = {
  id: "pie",
  keys: [...DATA_KEYS, ...GROUP_KEYS, "x", "y", "agg", "label", "unit", "decimals", "select", "alert"],
  span: 2,
  needsSource: true,
  validate(p: Panel) {
    const ys = seriesNames(p);
    const one = ys.length > 1 ? ["pie takes one y"] : [];
    if (p.group) return [...(p.x ? ["leave out x: the slices are the groups"] : []), ...groupedTotals(p, ys, "y"), ...one];
    return [...(p.x && ys.length ? [] : ["pie needs x (slice names) and y (sizes), or group"]), ...groupedTotals(p, [], "y"), ...one];
  },
  examples: [
    { panel: { view: "pie", source: "notes", from: "Books", group: "genre" } },
    { panel: { view: "pie", source: "spending", group: "category", y: "amount", agg: "sum", unit: "$" } },
    { panel: { view: "pie", source: "budget", x: "category", y: "amount" } },
    { panel: { view: "pie", source: "budget", x: "category" }, errors: ["pie needs x (slice names) and y (sizes), or group"] },
    { panel: { view: "pie", source: "s", group: "g", y: ["a", "b"], agg: "sum" }, errors: ["pie takes one y"] },
    { panel: { view: "pie", source: "spending", group: "category", y: "amount", agg: "sum", select: "category" } },
  ],
  mount: (el, p, ctx) => redraw(el, (data) => {
    heading(el, p, p.label);
    const rows = rowsOf(data);
    const nameField = p.group ?? p.x!;
    const slices = slicesOf(rows, nameField, seriesNames(p)[0] ?? "count");
    if (slices.length === 0) {
      el.createDiv({ cls: "na-empty", text: "Nothing to show yet." });
      return;
    }
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    const fmt = (v: number) => formatValue(v, p.decimals) + (p.unit ? ` ${p.unit}` : "");
    const share = (v: number) => `${Math.round((v / total) * 100)}%`;
    const box = el.createDiv({ cls: "na-pie" });
    const root = svg("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, class: "na-pie-svg", role: "img", width: SIZE, height: SIZE }, box);
    const readout = el.createDiv({ cls: "na-readout" });
    const showTotal = () => readout.setText(`Total · ${fmt(total)}`);
    const shapes = slices.length === 1
      ? [svg("circle", { cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2 - 2 - RING / 2, "stroke-width": RING, class: `na-ring ${slices[0].colour}` }, root)]
      : (() => {
        let a = -Math.PI / 2;
        return slices.map((s) => {
          const a1 = a + (s.value / total) * Math.PI * 2;
          const path = svg("path", { d: arc(a, a1), class: `na-slice ${s.colour}` }, root);
          a = a1;
          return path;
        });
      })();
    // Every slice's value and share is printed here too, so nothing depends on telling colours apart.
    const legend = box.createDiv({ cls: "na-pie-legend" });
    slices.forEach((s, i) => {
      const item = legendItem(legend, s.colour, s.name);
      item.createSpan({ cls: "na-pie-value", text: `${fmt(s.value)} · ${share(s.value)}` });
      shapes[i].addEventListener("pointerenter", () => readout.setText(`${s.name} · ${fmt(s.value)} · ${share(s.value)}`));
      shapes[i].addEventListener("pointerleave", showTotal);
      // "Other" folds several rows together, so there is no one row to pick.
      const row = s.colour === "na-other" ? undefined : rows.find((r) => String(getPath(r, nameField) ?? NONE) === s.name);
      if (row) {
        selectable(shapes[i], p, ctx, row, s.name);
        selectable(item, p, ctx, row);
      }
    });
    showTotal();
    if (p.label && p.title) el.createDiv({ cls: "na-label", text: p.label });
  }),
};
