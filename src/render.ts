import { renderChart } from "./chart.ts";
import {
  daysUntil, fillTemplate, formatValue, getPath, seriesOf, stampParts, toNumber, valueOf, type Row,
} from "./data.ts";
import type { Panel } from "./spec.ts";

export interface TimerState {
  remainingMs: number;
  endsAt?: number;
}

export interface RenderCtx {
  now: Date;
  chartWidth: number;
  /** A named list: the data note's if it has one, else the app note's. */
  list(name: string): unknown;
  runActions(p: Panel, row: Row): Promise<void>;
  toggleChecked(key: string, item: string): Promise<void>;
  clearChecked(key: string): Promise<void>;
  openNote(path: string): void;
  timer(index: number, p: Panel): TimerState;
  startTimer(index: number, p: Panel): void;
  pauseTimer(index: number): void;
  resetTimer(index: number, p: Panel): void;
}

/** Views that read best as small tiles; the rest take the full width. */
const TILE_VIEWS = new Set(["number", "countdown", "progress", "button", "timer", "text"]);

export function isWide(p: Panel): boolean {
  return !TILE_VIEWS.has(p.view);
}

function heading(el: HTMLElement, p: Panel, fallback?: string): void {
  const text = p.title ?? fallback;
  if (text) el.createDiv({ cls: "na-title", text });
}

export function renderPanel(el: HTMLElement, p: Panel, data: unknown, index: number, ctx: RenderCtx): void {
  switch (p.view) {
    case "number": return renderNumber(el, p, data);
    case "text": return renderText(el, p, data);
    case "line":
    case "bar":
      heading(el, p, p.label);
      return renderChart(el, seriesOf(data, p.x!, p.y!), { kind: p.view, unit: p.unit, decimals: p.decimals, width: ctx.chartWidth });
    case "table": return renderTable(el, p, data, ctx);
    case "list": return renderList(el, p, data, ctx);
    case "button": return renderButton(el, p, ctx);
    case "form": return renderForm(el, p, ctx);
    case "checklist": return renderChecklist(el, p, ctx);
    case "countdown": return renderCountdown(el, p, ctx);
    case "progress": return renderProgress(el, p, data);
    case "timer": return renderTimer(el, p, index, ctx);
  }
}

function renderNumber(el: HTMLElement, p: Panel, data: unknown): void {
  heading(el, p);
  const value = valueOf(p, data);
  const row = el.createDiv({ cls: "na-big" });
  row.createSpan({ text: formatValue(toNumber(value) ?? value, p.decimals) });
  if (p.unit) row.createSpan({ cls: "na-unit", text: p.unit });
  if (p.label) el.createDiv({ cls: "na-label", text: p.label });
}

function renderText(el: HTMLElement, p: Panel, data: unknown): void {
  heading(el, p);
  const ctx = Array.isArray(data) ? { ...(data[0] as Row), rows: data, count: data.length } : data;
  el.createDiv({ cls: "na-text", text: fillTemplate(p.text!, ctx, p.decimals) });
  if (p.label) el.createDiv({ cls: "na-label", text: p.label });
}

function rowsOf(data: unknown): Row[] {
  if (Array.isArray(data)) return data.map((r) => (r !== null && typeof r === "object" ? (r as Row) : { value: r }));
  if (data !== null && typeof data === "object") return [data as Row];
  return data === undefined ? [] : [{ value: data }];
}

function noteLink(el: HTMLElement, text: string, path: string, ctx: RenderCtx): void {
  const a = el.createEl("a", { cls: "internal-link", text, href: "#" });
  a.addEventListener("click", (e) => { e.preventDefault(); ctx.openNote(path); });
}

const HIDDEN_COLUMNS = new Set(["path", "mtime", "ctime", "tags", "position"]);

function renderTable(el: HTMLElement, p: Panel, data: unknown, ctx: RenderCtx): void {
  heading(el, p, p.label);
  const rows = rowsOf(data);
  if (rows.length === 0) { el.createDiv({ cls: "na-empty", text: "Nothing here yet." }); return; }
  const columns = p.columns ?? Object.keys(rows[0]).filter((k) => !HIDDEN_COLUMNS.has(k)).slice(0, 6);
  const table = el.createDiv({ cls: "na-table-wrap" }).createEl("table", { cls: "na-table" });
  const head = table.createEl("thead").createEl("tr");
  for (const c of columns) head.createEl("th", { text: c });
  const body = table.createEl("tbody");
  shownRows(el, rows, (r) => {
    const tr = body.createEl("tr");
    for (const c of columns) {
      const td = tr.createEl("td");
      const v = getPath(r, c);
      const text = formatValue(v, p.decimals);
      if (c === "name" && typeof r.path === "string") noteLink(td, text, r.path, ctx);
      else td.setText(text);
      if (typeof v === "number") td.addClass("na-num");
    }
  });
}

/** Rows drawn at first; the rest wait behind a "Show all" button so big queries stay cheap. */
export const ROW_CAP = 200;

function shownRows(el: HTMLElement, rows: Row[], draw: (r: Row) => void): void {
  rows.slice(0, ROW_CAP).forEach(draw);
  if (rows.length <= ROW_CAP) return;
  const more = el.createEl("button", { cls: "na-small na-more", text: `Show all ${rows.length}` });
  more.addEventListener("click", () => {
    more.remove();
    rows.slice(ROW_CAP).forEach(draw);
  });
}

function renderList(el: HTMLElement, p: Panel, data: unknown, ctx: RenderCtx): void {
  heading(el, p, p.label);
  const rows = rowsOf(data);
  if (rows.length === 0) { el.createDiv({ cls: "na-empty", text: "Nothing here yet." }); return; }
  const ul = el.createEl("ul", { cls: "na-list" });
  shownRows(el, rows, (r) => {
    const text = p.item ? fillTemplate(p.item, r, p.decimals) : String(r.name ?? r.title ?? r.value ?? JSON.stringify(r));
    const li = ul.createEl("li");
    if (typeof r.path === "string") noteLink(li, text, r.path, ctx);
    else li.setText(text);
  });
}

function busy(button: HTMLButtonElement, work: () => Promise<void>): void {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  });
}

function renderButton(el: HTMLElement, p: Panel, ctx: RenderCtx): void {
  heading(el, p);
  const button = el.createEl("button", { cls: "mod-cta na-button", text: p.label ?? "Log" });
  busy(button, () => ctx.runActions(p, {}));
}

function renderForm(el: HTMLElement, p: Panel, ctx: RenderCtx): void {
  heading(el, p);
  const form = el.createEl("form", { cls: "na-form" });
  const inputs: [string, string | string[], HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement][] = [];
  for (const [name, type] of Object.entries(p.fields!)) {
    const label = form.createEl("label", { cls: "na-field" });
    label.createSpan({ text: name });
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (Array.isArray(type)) {
      input = label.createEl("select");
      for (const opt of type) input.createEl("option", { text: String(opt), value: String(opt) });
    } else if (type === "textarea") {
      input = label.createEl("textarea");
    } else {
      input = label.createEl("input", { type: type === "number" ? "number" : type });
      if (type === "number") input.setAttr("step", "any");
      if (type === "date") input.value = stampParts(ctx.now).date;
    }
    inputs.push([name, type, input]);
  }
  const button = form.createEl("button", { cls: "mod-cta", text: p.label ?? "Save", type: "submit" });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const row: Row = {};
    for (const [name, type, input] of inputs) {
      if (type === "checkbox") row[name] = (input as HTMLInputElement).checked;
      else if (type === "number") row[name] = input.value === "" ? null : Number(input.value);
      else row[name] = input.value;
    }
    button.disabled = true;
    try {
      await ctx.runActions(p, row);
      form.reset();
    } finally {
      button.disabled = false;
    }
  });
}

function renderChecklist(el: HTMLElement, p: Panel, ctx: RenderCtx): void {
  const key = p.save ?? "checked";
  const saved = ctx.list(key);
  const checked = new Set((Array.isArray(saved) ? saved : []).map(String));
  const items = p.items!.map(String);
  const done = items.filter((i) => checked.has(i)).length;
  const top = el.createDiv({ cls: "na-row" });
  top.createDiv({ cls: "na-title", text: `${p.title ?? p.label ?? "Checklist"} · ${done}/${items.length}` });
  const clear = top.createEl("button", { cls: "na-small", text: "Clear" });
  busy(clear, () => ctx.clearChecked(key));
  const ul = el.createEl("ul", { cls: "na-checklist" });
  for (const item of items) {
    const label = ul.createEl("li").createEl("label");
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = checked.has(item);
    label.createSpan({ text: item });
    box.addEventListener("change", () => void ctx.toggleChecked(key, item));
  }
}

function renderCountdown(el: HTMLElement, p: Panel, ctx: RenderCtx): void {
  heading(el, p);
  const days = daysUntil(p.to!, ctx.now);
  const big = el.createDiv({ cls: "na-big" });
  big.createSpan({ text: String(Math.abs(days)) });
  big.createSpan({ cls: "na-unit", text: Math.abs(days) === 1 ? "day" : "days" });
  const when = new Date(Date.parse(p.to!.length === 10 ? `${p.to}T00:00` : p.to!));
  const suffix = days < 0 ? "ago" : days === 0 ? "today" : "left";
  el.createDiv({ cls: "na-label", text: `${p.label ? `${p.label} · ` : ""}${when.toLocaleDateString()} · ${suffix}` });
}

function renderProgress(el: HTMLElement, p: Panel, data: unknown): void {
  heading(el, p);
  const value = toNumber(valueOf(p, data)) ?? 0;
  const max = p.max ?? 100;
  const big = el.createDiv({ cls: "na-big" });
  big.createSpan({ text: formatValue(value, p.decimals) });
  big.createSpan({ cls: "na-unit", text: `/ ${formatValue(max, p.decimals)}${p.unit ? ` ${p.unit}` : ""}` });
  const bar = el.createDiv({ cls: "na-progress" }).createDiv({ cls: "na-progress-fill" });
  bar.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  if (p.label) el.createDiv({ cls: "na-label", text: p.label });
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderTimer(el: HTMLElement, p: Panel, index: number, ctx: RenderCtx): void {
  heading(el, p);
  const state = ctx.timer(index, p);
  const remaining = state.endsAt ? state.endsAt - Date.now() : state.remainingMs;
  el.createDiv({ cls: "na-big na-clock", text: formatClock(remaining), attr: { "data-na-timer": String(index) } });
  const row = el.createDiv({ cls: "na-row" });
  const toggle = row.createEl("button", { cls: "mod-cta", text: state.endsAt ? "Pause" : "Start" });
  toggle.addEventListener("click", () => (state.endsAt ? ctx.pauseTimer(index) : ctx.startTimer(index, p)));
  row.createEl("button", { text: "Reset" }).addEventListener("click", () => ctx.resetTimer(index, p));
  if (p.label) el.createDiv({ cls: "na-label", text: p.label });
}
