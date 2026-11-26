/**
 * A backtest of an app over its past, drawn into any element: its definition now, or `before` (the
 * definition an editing session started from) against now, with progress and Cancel, then what
 * fired when.
 */
import { backtestApp, MAX_STEPS, type BacktestResult, type Fire } from "./backtest.ts";
import { pastText } from "./replay.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { basename } from "./store.ts";

/** The window's title for a backtest. */
export function backtestTitle(path: string, before?: Record<string, unknown>): string {
  return before ? `Backtest this change to ${basename(path)}` : `Backtest ${basename(path)}`;
}

/** Runs the backtest into `el`; `cancelled` says the window closed, and Cancel calls `close`. */
export async function drawBacktest(
  el: HTMLElement, rt: GizmoRuntime, path: string, before: Record<string, unknown> | undefined, o: { cancelled(): boolean; close(): void },
): Promise<void> {
  const box = el.createDiv({ cls: "gizmo gz-backtest" });
  const planned = backtestApp(rt, path, before, new Date());
  if ("message" in planned) return void box.createEl("p", { text: planned.message });
  const status = box.createEl("p", { cls: "gz-muted", text: "Reading what it kept…" });
  const bar = box.createEl("progress");
  const cancel = box.createEl("button", { text: "Cancel" });
  cancel.addEventListener("click", () => o.close());
  const result = await planned.run((done, total) => {
    bar.max = total;
    bar.value = done;
    status.setText(`Step ${done} of ${total}`);
  }, () => o.cancelled());
  if (o.cancelled()) return;
  box.empty();
  if (result instanceof Error) return void box.createEl("p", { cls: "gz-error", text: result.message });
  if (result) render(box, result);
}

function render(box: HTMLElement, r: BacktestResult): void {
  const span = `${pastText(r.from)} to ${pastText(r.to)}, ${r.steps} steps`;
  box.createEl("p", { text: r.cut ? `${span}: only the last ${MAX_STEPS}, so it starts later than the data does.` : `${span}.` });
  const times = (n: number) => (n === 1 ? "once" : `${n} times`);
  box.createEl("p", { text: r.before ? `Before the change it would have fired ${times(r.before.length)}; after, ${times(r.after.length)}.` : `It would have fired ${times(r.after.length)}.` });
  timeline(box, r);
  if (r.before) {
    list(box, "Added by the change", r.added);
    list(box, "Lost by the change", r.lost);
  } else list(box, "When it fired", r.after);
  if (r.errors.length) {
    box.createEl("h4", { text: "Couldn't read at some steps" });
    const ul = box.createEl("ul");
    for (const e of r.errors) ul.createEl("li", { text: e });
  }
  box.createEl("p", { cls: "gz-muted", text: "Nothing was written or told; a then is only named. Lists come from their history; notes, tasks and files are read as they are now." });
}

/** A strip from the first step to the last, a mark at each fire: before the change above, after below. */
function timeline(box: HTMLElement, r: BacktestResult): void {
  const rows: [string, Fire[]][] = r.before ? [["Before", r.before], ["After", r.after]] : [["Fired", r.after]];
  const svg = box.createSvg("svg", { cls: "gz-backtest-line", attr: { viewBox: `0 0 1000 ${rows.length * 28}`, preserveAspectRatio: "none", role: "img" } });
  const x = (t: number) => (r.to === r.from ? 500 : ((t - r.from) / (r.to - r.from)) * 1000);
  rows.forEach(([name, fires], i) => {
    svg.createSvg("line", { cls: "gz-backtest-axis", attr: { x1: 0, x2: 1000, y1: i * 28 + 14, y2: i * 28 + 14 } });
    for (const f of fires) {
      const tick = svg.createSvg("rect", { cls: ["gz-backtest-fire", `gz-backtest-${name.toLowerCase()}`], attr: { x: x(f.at) - 2, y: i * 28 + 4, width: 4, height: 20 } });
      tick.createSvg("title").textContent = `${name}: ${pastText(f.at)} · ${f.what}`;
    }
  });
  box.createDiv({ cls: "gz-backtest-legend gz-muted", text: rows.map(([name], i) => `${i ? "below" : r.before ? "above" : ""} ${name.toLowerCase()}`.trim()).join(", ") });
}

function list(box: HTMLElement, title: string, fires: Fire[]): void {
  box.createEl("h4", { text: `${title} (${fires.length})` });
  if (!fires.length) return void box.createEl("p", { cls: "gz-muted", text: "None." });
  const ul = box.createEl("ul");
  for (const f of fires.slice(0, 100)) ul.createEl("li", { text: `${pastText(f.at)} · ${f.what}${f.then ? ` · would run ${f.then}` : ""}` });
  if (fires.length > 100) ul.createEl("li", { cls: "gz-muted", text: `and ${fires.length - 100} more` });
}
