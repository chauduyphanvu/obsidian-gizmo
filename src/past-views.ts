import { Modal, type App } from "obsidian";
import { backtestApp, MAX_STEPS, type BacktestResult, type Fire } from "./backtest.ts";
import type GizmoPlugin from "./main.ts";
import { pastText } from "./replay.ts";
import { basename } from "./store.ts";
import { AppView, VIEW_TYPE } from "./view.ts";
import { minuteIn } from "./time.ts";

const DAY = 86_400_000;
const localInput = (t: number) => minuteIn(t);

/** Opens an app in a new tab as it was at a past time, beside the app as it is now. */
export async function openAppAt(plugin: GizmoPlugin, path: string, at: number): Promise<void> {
  const leaf = plugin.app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE, state: { file: path, past: at }, active: true });
}

/**
 * Opens an app shown ahead (What if…) in a new tab, beside the app as it is now; `line`, a Do… line
 * after `what if`, is saved as a what-if row first.
 */
export async function openAppAhead(plugin: GizmoPlugin, path: string, line?: string): Promise<void> {
  const leaf = plugin.app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE, state: { file: path, ahead: line === undefined ? {} : { line } }, active: true });
}

/** "What if…": the open app shown ahead, in its own tab, where its what-if rows are kept until Keep or Discard. */
export function registerWhatIf(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "what-if",
    name: "What if…",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || !plugin.isApp(file) || !plugin.runtime.dataLayer.ledger) return false;
      if (checking) return true;
      const view = plugin.app.workspace.getActiveViewOfType(AppView);
      if (view?.file === file) view.showAhead();
      else void openAppAhead(plugin, file.path);
      return true;
    },
  });
}

/** "As of…": picks the past time to show an app at. */
export class AsOfModal extends Modal {
  private show: (at: number) => void;

  constructor(app: App, show: (at: number) => void) {
    super(app);
    this.show = show;
  }

  onOpen(): void {
    this.titleEl.setText("Show this app as it was");
    const box = this.contentEl.createDiv({ cls: "gizmo gz-asof" });
    const now = Date.now();
    const quick = box.createDiv({ cls: "gz-asof-quick" });
    for (const [text, ago] of [["Yesterday", DAY], ["A week ago", 7 * DAY], ["A month ago", 30 * DAY]] as const) {
      quick.createEl("button", { text }).addEventListener("click", () => this.pick(now - ago));
    }
    const form = box.createEl("form");
    const input = form.createEl("input", { type: "datetime-local" });
    input.value = localInput(now - DAY);
    input.max = localInput(now);
    form.createEl("button", { cls: "mod-cta", text: "Show", attr: { type: "submit" } });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = new Date(input.value).getTime();
      if (Number.isFinite(t)) this.pick(Math.min(t, Date.now()));
    });
  }

  private pick(at: number): void {
    this.close();
    this.show(at);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Runs a backtest of an app over its past: its definition now, or `before` (the definition an
 * editing session started from) against now, with progress and Cancel, then what fired when.
 */
export class BacktestModal extends Modal {
  private plugin: GizmoPlugin;
  private path: string;
  private before: Record<string, unknown> | undefined;
  private cancelled = false;

  constructor(plugin: GizmoPlugin, path: string, before?: Record<string, unknown>) {
    super(plugin.app);
    this.plugin = plugin;
    this.path = path;
    this.before = before;
  }

  onOpen(): void {
    this.titleEl.setText(this.before ? `Backtest this change to ${basename(this.path)}` : `Backtest ${basename(this.path)}`);
    void this.run();
  }

  onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    const box = this.contentEl.createDiv({ cls: "gizmo gz-backtest" });
    const planned = backtestApp(this.plugin.runtime, this.path, this.before, new Date());
    if ("message" in planned) return void box.createEl("p", { text: planned.message });
    const status = box.createEl("p", { cls: "gz-muted", text: "Reading what it kept…" });
    const bar = box.createEl("progress");
    const cancel = box.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const result = await planned.run((done, total) => {
      bar.max = total;
      bar.value = done;
      status.setText(`Step ${done} of ${total}`);
    }, () => this.cancelled);
    if (this.cancelled) return;
    box.empty();
    if (result instanceof Error) return void box.createEl("p", { cls: "gz-error", text: result.message });
    if (result) this.render(box, result);
  }

  private render(box: HTMLElement, r: BacktestResult): void {
    const span = `${pastText(r.from)} to ${pastText(r.to)}, ${r.steps} steps`;
    box.createEl("p", { text: r.cut ? `${span}: only the last ${MAX_STEPS}, so it starts later than the data does.` : `${span}.` });
    const times = (n: number) => (n === 1 ? "once" : `${n} times`);
    box.createEl("p", { text: r.before ? `Before the change it would have fired ${times(r.before.length)}; after, ${times(r.after.length)}.` : `It would have fired ${times(r.after.length)}.` });
    this.timeline(box, r);
    if (r.before) {
      this.list(box, "Added by the change", r.added);
      this.list(box, "Lost by the change", r.lost);
    } else this.list(box, "When it fired", r.after);
    if (r.errors.length) {
      box.createEl("h4", { text: "Couldn't read at some steps" });
      const ul = box.createEl("ul");
      for (const e of r.errors) ul.createEl("li", { text: e });
    }
    box.createEl("p", { cls: "gz-muted", text: "Nothing was written or told; a then is only named. Lists come from their history; notes, tasks and files are read as they are now." });
  }

  /** A strip from the first step to the last, a mark at each fire: before the change above, after below. */
  private timeline(box: HTMLElement, r: BacktestResult): void {
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

  private list(box: HTMLElement, title: string, fires: Fire[]): void {
    box.createEl("h4", { text: `${title} (${fires.length})` });
    if (!fires.length) return void box.createEl("p", { cls: "gz-muted", text: "None." });
    const ul = box.createEl("ul");
    for (const f of fires.slice(0, 100)) ul.createEl("li", { text: `${pastText(f.at)} · ${f.what}${f.then ? ` · would run ${f.then}` : ""}` });
    if (fires.length > 100) ul.createEl("li", { cls: "gz-muted", text: `and ${fires.length - 100} more` });
  }
}

/** "Backtest this app": the open app's alerts and expect rules over its past, as it is defined now. */
export function registerBacktest(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "backtest-app",
    name: "Backtest this app",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || !plugin.isApp(file)) return false;
      if (!checking) new BacktestModal(plugin, file.path).open();
      return true;
    },
  });
}
