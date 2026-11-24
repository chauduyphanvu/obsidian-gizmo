/**
 * The Explain window of one figure: the rows behind it, where each came from, what moved it since
 * a time the person picks, and, where something it reads can still be set, what that would have to
 * be for the figure to come to a target (Pull the answer). Drawn into any element, so the app's
 * tab, a window and the tests share it.
 */
import { toNumber, type Row } from "./data.ts";
import type { KeysChange } from "./definitions.ts";
import type { Explanation, Move, Part, Waterfall } from "./explain.ts";
import { rowWords } from "./explain.ts";
import { display } from "./format.ts";
import type { RowOrigin } from "./ledger-store.ts";
import { readTarget, type Knob, type Solved } from "./pull.ts";
import type { Panel } from "./spec.ts";
import { minuteIn, toTime, wallTime } from "./time.ts";
import { dayName } from "./views/common.ts";
import { plural } from "./text.ts";

/** What the window needs of the app that shows the figure. */
export interface ExplainSource {
  /** The panel, as drawn: its title, its formats and its field. */
  panel: Panel;
  /** The time the app shows: now, or the past time it is shown at. */
  now: Date;
  /** The app is shown as it was at this time. */
  past?: boolean;
  /** The figure as shown, with its rows; undefined when the panel has no figure to explain. */
  shown(): Promise<Explanation | undefined>;
  /** The figure as it was at a past time (ms), with its rows then; rejects when that can't be read. */
  at(t: number): Promise<Explanation | undefined>;
  /** What moved the figure between a past time (ms) and the time shown. */
  since(t: number): Promise<Waterfall | undefined>;
  /** Each change to the panel's own keys seen since a past time (ms), the oldest first. */
  keysSince?(t: number): Promise<KeysChange[]>;
  /** Where each saved row behind the figure came from, by row id. */
  origins(): Promise<Map<string, RowOrigin>>;
  /** A device's name, by its id; undefined for one this device never heard of. */
  deviceName?(id: string): string | undefined;
  /** Deletes a saved row behind the figure, kept in the activity. Absent where nothing may be changed. */
  remove?(part: Part): Promise<Done>;
  /** Pull the answer: what the figure could be pulled by, what each would have to be, and keeping one. Absent where nothing may be changed. */
  pull?: {
    knobs(): Promise<Knob[]>;
    solve(knob: Knob, target: number): Promise<Solved>;
    /** Sets the knob to the value solved for. */
    keep(knob: Knob, value: number): Promise<Done>;
  };
}

/** How a change made from the window went: what to say, and how to take it back when it can be. */
export interface Done {
  text: string;
  undo?(): Promise<string>;
}

/** Rows drawn before "… N more". */
const ROW_CAP = 100;
const DAY = 86_400_000;


/** How the figure comes from its rows, in a sentence. */
export function howWords(e: Explanation): string {
  if (e.direct) return e.direct;
  const n = e.parts.length;
  const field = e.field ?? "value";
  const left = e.left ? ` ${plural(e.left, "row")} with no number in ${field} ${e.left === 1 ? "is" : "are"} left out.` : "";
  switch (e.agg) {
    case "count": return `The count of ${plural(n, "row")}.`;
    case "sum": return `The sum of ${field} over ${plural(n, "row")}.${left}`;
    case "avg": return `The average of ${field} over ${plural(n, "row")}.${left}`;
    case "min": return `The least ${field} of ${plural(n, "row")}.${left}`;
    case "max": return `The most ${field} of ${plural(n, "row")}.${left}`;
    case "first": return n ? `The ${field} of the first row.` : "No row to read.";
    case "last": return n ? `The ${field} of the last row.` : "No row to read.";
    case "share": return `${e.parts.filter((x) => x.value === true).length} of ${plural(n, "row")} match.`;
    default: return "";
  }
}

/** `Thu Nov 19, 13:00`: a time as the window says it. */
function timeWords(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${dayName(d)}, ${minuteIn(t).slice(11)}`;
}

/** `Nov 19, 10:00`, or `Nov 19` for a date alone: when a row says it happened, by the clock where it was saved. */
function rowTime(row: Row): string {
  const t = wallTime(row.at);
  if (t === undefined) return "";
  return typeof row.at === "string" && row.at.length === 10 ? dayName(new Date(t)) : `${dayName(new Date(t))}, ${minuteIn(t).slice(11)}`;
}

/** Where a saved row came from, in a few words. */
function originWords(src: ExplainSource, part: { id?: string; row: Row }, origins: Map<string, RowOrigin>): string {
  const row = part.row;
  const words: string[] = [];
  if (typeof row.imported === "string" || row.line === "attested") words.push("from a file");
  if (typeof row.by === "string" && row.by) words.push(`by ${row.by}`);
  if (row.line === "planned") words.push("planned");
  const o = part.id === undefined ? undefined : origins.get(part.id);
  if (o) {
    const device = src.deviceName?.(o.device.split(".")[0]);
    words.push(`written ${timeWords(o.at)}${device ? ` on ${device}` : ""}`);
    if (o.sets) words.push(`changed ${o.sets === 1 ? "once" : `${o.sets} times`} since`);
  }
  return words.join(" · ");
}

/** The window. Each fill of it that a newer one overtook draws nothing. */
export function drawExplain(el: HTMLElement, src: ExplainSource): Promise<void> {
  const p = src.panel;
  const show = (v: unknown) => display(p, p.field, v, src.now);
  const signed = (n: number) => `${n < 0 ? "−" : "+"}${show(Math.abs(n))}`;
  // One format for the whole panel is for its figure: a row's other fields, and a property, show in their own.
  const own = typeof p.format !== "string" ? p : {
    ...p,
    format: {
      ...Object.fromEntries(Object.entries(p.fieldInfo ?? {}).flatMap(([f, i]) => (i.format === undefined ? [] : [[f, i.format]]))),
      ...(p.field !== undefined && { [p.field]: p.format }),
    },
  };
  const words = (row: Row) => rowWords(row, (f, v) => display(own, f, v, src.now, "text"), Object.keys(p.schema ?? {}), p.field);
  const when = rowTime;
  el.empty();
  el.addClass("gz-explain");
  const head = el.createDiv({ cls: "gz-explain-head" });
  const how = el.createDiv({ cls: "gz-explain-how" });
  const since = el.createDiv({ cls: "gz-explain-since" });
  const pull = el.createDiv({ cls: "gz-explain-pull" });
  const list = el.createDiv({ cls: "gz-explain-rows" });
  const said = el.createDiv({ cls: "gz-explain-said", attr: { role: "status" } });

  /** Says how a change went, with Undo when it can be taken back, and reads the figure again. */
  const tell = (done: Done): Promise<void> => {
    said.empty();
    said.createSpan({ text: done.text });
    if (done.undo) {
      const b = said.createEl("button", { cls: "gz-small", text: "Undo", attr: { type: "button" } });
      b.addEventListener("click", () => {
        b.disabled = true;
        void done.undo!().then((text) => tell({ text }));
      });
    }
    return fill();
  };

  const drawRows = (e: Explanation, origins: Map<string, RowOrigin>) => {
    list.empty();
    if (!e.parts.length) return;
    list.createDiv({ cls: "gz-explain-title", text: "The rows behind it" });
    // The same day, value and words twice is worth a look: a charge imported twice, a double tap.
    const twins = new Map<string, number>();
    const twinKey = (x: Part) => `${String(x.row.at).slice(0, 10)}|${JSON.stringify(x.value)}|${words(x.row)}`;
    for (const x of e.parts) twins.set(twinKey(x), (twins.get(twinKey(x)) ?? 0) + 1);
    const ordered = e.additive ? [...e.parts].sort((a, b) => Math.abs(b.adds ?? 0) - Math.abs(a.adds ?? 0)) : e.parts;
    for (const x of ordered.slice(0, ROW_CAP)) {
      const twin = (twins.get(twinKey(x)) ?? 0) > 1;
      const line = list.createDiv({ cls: `gz-explain-row${twin ? " gz-explain-twin" : ""}` });
      line.createSpan({ cls: "gz-explain-adds", text: e.agg === "count" ? "1" : e.agg === "share" ? (x.value === true ? "✓" : "·") : show(x.value) });
      const what = line.createSpan({ cls: "gz-explain-what" });
      what.createSpan({ text: [when(x.row), words(x.row)].filter(Boolean).join(" · ") || "a row" });
      const origin = [twin ? "the same as another row here" : "", originWords(src, x, origins)].filter(Boolean).join(" · ");
      if (origin) what.createDiv({ cls: "gz-explain-origin", text: origin });
      if (src.remove && x.id !== undefined) {
        const b = line.createEl("button", { cls: "gz-small", text: "Delete", attr: { type: "button", "aria-label": `Delete the row ${words(x.row)}` } });
        b.addEventListener("click", () => {
          b.disabled = true;
          void src.remove!(x).then(tell);
        });
      }
    }
    if (ordered.length > ROW_CAP) list.createDiv({ cls: "gz-explain-more", text: `… ${ordered.length - ROW_CAP} more` });
  };

  const moveWords = (m: Move, agg: Waterfall["agg"]): string => {
    const row = [when(m.row), words(m.row)].filter(Boolean).join(" · ");
    const one = agg === "first" || agg === "last" ? agg : undefined;
    if (m.kind === "added") return `${one ? `Now the ${one} row` : "Added"} · ${row}`;
    if (m.kind === "removed") return `${one ? `Was the ${one} row` : "Gone"} · ${row}`;
    const number = JSON.stringify(m.before) !== JSON.stringify(m.after) ? ` · ${show(m.before)} → ${show(m.after)}` : "";
    const others = (m.fields ?? []).filter((f) => f !== p.field);
    return `Changed · ${row}${number}${others.length ? ` · ${others.join(", ")} changed` : ""}`;
  };

  const drawSince = (t: number, w: Waterfall | undefined, keys: KeysChange[], box: HTMLElement) => {
    box.empty();
    if (!w) return void box.createDiv({ cls: "gz-explain-none", text: "This figure can't be read at that time." });
    for (const k of keys) {
      box.createDiv({ cls: "gz-explain-keys", text: `The panel's own keys changed on ${timeWords(k.at)}: ${k.keys.join(", ")}. Both figures here are worked out with the keys as they are now.` });
    }
    const then = `${show(w.before)} on ${timeWords(t)}`;
    const delta = w.delta === undefined || w.delta === 0 ? "" : `: ${show(Math.abs(w.delta))} ${w.delta > 0 ? "more" : "less"}`;
    box.createDiv({ cls: "gz-explain-then", text: `${then} → ${show(w.after)} ${src.past ? "at the time shown" : "now"}${delta}` });
    if (!w.moves.length) return void box.createDiv({ cls: "gz-explain-none", text: "No row behind this figure came, went or changed since then." });
    for (const m of w.moves.slice(0, ROW_CAP)) {
      const line = box.createDiv({ cls: `gz-explain-move gz-explain-${m.kind}` });
      // A figure that isn't a sum has no amount for each row: a row that came or went shows its own number.
      const own = m.kind === "changed" ? undefined : m.after ?? m.before;
      line.createSpan({ cls: "gz-explain-adds", text: m.delta === undefined ? (typeof own === "number" ? show(own) : "") : m.delta === 0 ? "·" : signed(m.delta) });
      line.createSpan({ cls: "gz-explain-what", text: moveWords(m, w.agg) });
    }
    if (w.moves.length > ROW_CAP) box.createDiv({ cls: "gz-explain-more", text: `… ${w.moves.length - ROW_CAP} more` });
    if (w.same) box.createDiv({ cls: "gz-explain-same", text: `${plural(w.same, "row")} ${w.same === 1 ? "is" : "are"} the same.` });
  };

  const drawSinceBar = () => {
    since.empty();
    since.createDiv({ cls: "gz-explain-title", text: "What moved it since" });
    const bar = since.createDiv({ cls: "gz-explain-bar" });
    const out = since.createDiv({ cls: "gz-explain-waterfall", attr: { role: "status" } });
    const pick = (t: number) => {
      out.setText("Reading…");
      const keys = src.keysSince ? src.keysSince(t).catch(() => []) : Promise.resolve([]);
      void Promise.all([src.since(t), keys]).then(([w, k]) => drawSince(t, w, k, out), (e: Error) => out.setText(`Couldn't read that time: ${e.message}`));
    };
    const end = src.now.getTime();
    for (const [text, ago] of [["Yesterday", DAY], ["A week ago", 7 * DAY], ["A month ago", 30 * DAY]] as const) {
      bar.createEl("button", { cls: "gz-small", text, attr: { type: "button" } }).addEventListener("click", () => pick(end - ago));
    }
    const form = bar.createEl("form");
    const input = form.createEl("input", { type: "datetime-local", attr: { "aria-label": "A time to compare with" } });
    input.value = minuteIn(end - DAY);
    input.max = minuteIn(end);
    form.createEl("button", { cls: "gz-small", text: "Compare", attr: { type: "submit" } });
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const t = toTime(input.value) ?? new Date(input.value).getTime();
      if (Number.isFinite(t)) pick(Math.min(t, end));
    });
  };

  const knobWords = (k: Knob): string => {
    if (k.kind === "property") return `${k.name}, a property of this note`;
    const row = [when(k.row), rowWords(k.row, (f, v) => display(own, f, v, src.now, "text"), Object.keys(p.schema ?? {}), k.field)].filter(Boolean).join(" · ");
    return `${k.field} of ${k.whatIf ? "the what-if row" : "the planned row"} ${row}`;
  };

  const drawPull = (e: Explanation, knobs: Knob[]) => {
    pull.empty();
    if (!src.pull || !knobs.length || toNumber(e.value) === undefined) return;
    pull.createDiv({ cls: "gz-explain-title", text: "Pull it to" });
    const form = pull.createEl("form", { cls: "gz-explain-bar" });
    const input = form.createEl("input", { type: "text", attr: { inputmode: "decimal", placeholder: String(toNumber(e.value)), "aria-label": "The figure you want" } });
    form.createEl("button", { cls: "gz-small", text: "Solve", attr: { type: "submit" } });
    const out = pull.createDiv({ cls: "gz-explain-knobs", attr: { role: "status" } });
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const target = readTarget(input.value);
      out.empty();
      if (target === undefined) return void out.createDiv({ cls: "gz-explain-none", text: "Type the number the figure should come to." });
      for (const k of knobs) {
        const line = out.createDiv({ cls: "gz-explain-knob" });
        const text = line.createSpan({ cls: "gz-explain-what", text: knobWords(k) });
        void src.pull!.solve(k, target).then((s) => {
          const fmt = (n: number) => display(own, k.kind === "row" ? k.field : undefined, n, src.now);
          if ("none" in s) return void text.createDiv({ cls: "gz-explain-origin", text: `stays ${fmt(k.value)}: ${s.none}` });
          text.createDiv({ cls: "gz-explain-origin", text: `${fmt(k.value)} → ${fmt(s.value)}` });
          if (s.value === k.value) return;
          const b = line.createEl("button", { cls: "gz-small mod-cta", text: "Keep", attr: { type: "button", "aria-label": `Set ${knobWords(k)} to ${fmt(s.value)}` } });
          b.addEventListener("click", () => {
            b.disabled = true;
            void src.pull!.keep(k, s.value).then(tell);
          });
        });
      }
    });
  };

  let fills = 0;
  const fill = async (): Promise<void> => {
    const run = ++fills;
    const e = await src.shown();
    if (run !== fills) return;
    head.empty();
    how.empty();
    if (!e) {
      head.createDiv({ cls: "gz-explain-none", text: "This panel has no one figure to explain." });
      since.empty();
      pull.empty();
      list.empty();
      return;
    }
    if (p.title) head.createDiv({ cls: "gz-title gz-eyebrow", text: p.title });
    head.createDiv({ cls: "gz-big", text: show(e.value) });
    how.setText(howWords(e));
    if (e.direct) {
      since.empty();
      pull.empty();
      list.empty();
      return;
    }
    if (!since.hasChildNodes()) drawSinceBar();
    else since.querySelector<HTMLElement>(".gz-explain-waterfall")?.empty();
    const [origins, knobs] = await Promise.all([src.origins().catch(() => new Map<string, RowOrigin>()), src.pull ? src.pull.knobs().catch(() => []) : []]);
    if (run !== fills) return;
    drawRows(e, origins);
    drawPull(e, knobs);
  };
  return fill();
}
