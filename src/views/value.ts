import { AGGS, daysUntil, fillTemplate, formatValue, toNumber, valueOf, type Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import { DATA_KEYS, heading, redraw } from "./common.ts";
import type { ViewDef } from "./registry.ts";

function checkAgg(p: Panel): string[] {
  return p.agg && !AGGS.includes(p.agg) ? [`agg must be one of ${AGGS.join(", ")}`] : [];
}

export const number: ViewDef = {
  id: "number",
  keys: [...DATA_KEYS, "field", "agg", "label", "unit", "decimals"],
  wide: false,
  needsSource: true,
  validate: checkAgg,
  examples: [
    { panel: { view: "number", source: "weights", field: "weight", agg: "avg", unit: "kg" } },
    { panel: { view: "number", source: "weights", agg: "median" }, errors: ["agg must be one of count, sum, avg, min, max, first, last"] },
    { panel: { view: "number", field: "weight" }, errors: ["number needs a source"] },
  ],
  mount: (el, p) => redraw(el, (data) => {
    heading(el, p);
    const value = valueOf(p, data);
    const row = el.createDiv({ cls: "na-big" });
    row.createSpan({ text: formatValue(toNumber(value) ?? value, p.decimals) });
    if (p.unit) row.createSpan({ cls: "na-unit", text: p.unit });
    if (p.label) el.createDiv({ cls: "na-label", text: p.label });
  }),
};

export const text: ViewDef = {
  id: "text",
  keys: [...DATA_KEYS, "text", "label", "decimals"],
  wide: false,
  validate: (p) => (p.text ? [] : ["text needs a text template"]),
  examples: [
    { panel: { view: "text", source: "https://api.example.com/now", pick: "current", text: "{temp}°C" } },
    { panel: { view: "text", text: "Plain words work too" } },
    { panel: { view: "text", source: "weights" }, errors: ["text needs a text template"] },
  ],
  mount: (el, p) => redraw(el, (data) => {
    heading(el, p);
    const ctx = Array.isArray(data) ? { ...(data[0] as Row), rows: data, count: data.length } : data;
    el.createDiv({ cls: "na-text", text: fillTemplate(p.text!, ctx, p.decimals) });
    if (p.label) el.createDiv({ cls: "na-label", text: p.label });
  }),
};

export const progress: ViewDef = {
  id: "progress",
  keys: [...DATA_KEYS, "field", "agg", "max", "label", "unit", "decimals"],
  wide: false,
  needsSource: true,
  validate: checkAgg,
  examples: [
    { panel: { view: "progress", source: "notes", from: "Books", max: 24, unit: "books" } },
    { panel: { view: "progress", max: 8 }, errors: ["progress needs a source"] },
  ],
  mount: (el, p) => redraw(el, (data) => {
    heading(el, p);
    const value = toNumber(valueOf(p, data)) ?? 0;
    const max = p.max ?? 100;
    const big = el.createDiv({ cls: "na-big" });
    big.createSpan({ text: formatValue(value, p.decimals) });
    big.createSpan({ cls: "na-unit", text: `/ ${formatValue(max, p.decimals)}${p.unit ? ` ${p.unit}` : ""}` });
    const bar = el.createDiv({ cls: "na-progress" }).createDiv({ cls: "na-progress-fill" });
    bar.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
    if (p.label) el.createDiv({ cls: "na-label", text: p.label });
  }),
};

export const countdown: ViewDef = {
  id: "countdown",
  keys: ["to", "label"],
  wide: false,
  validate: (p) => (!p.to ? ['countdown needs "to" (a date)'] : Number.isNaN(Date.parse(p.to)) ? ['"to" is not a date'] : []),
  examples: [
    { panel: { view: "countdown", to: "2027-10-03", label: "Benefits renewal" } },
    { panel: { view: "countdown", to: "soon" }, errors: ['"to" is not a date'] },
    { panel: { view: "countdown", to: "2027-01-01", unit: "days" }, errors: ['"unit" doesn\'t apply to countdown'] },
  ],
  mount: (el, p, ctx) => redraw(el, () => {
    heading(el, p);
    const days = daysUntil(p.to!, ctx.now);
    const big = el.createDiv({ cls: "na-big" });
    big.createSpan({ text: String(Math.abs(days)) });
    big.createSpan({ cls: "na-unit", text: Math.abs(days) === 1 ? "day" : "days" });
    const when = new Date(Date.parse(p.to!.length === 10 ? `${p.to}T00:00` : p.to!));
    const suffix = days < 0 ? "ago" : days === 0 ? "today" : "left";
    el.createDiv({ cls: "na-label", text: `${p.label ? `${p.label} · ` : ""}${when.toLocaleDateString()} · ${suffix}` });
  }),
};
