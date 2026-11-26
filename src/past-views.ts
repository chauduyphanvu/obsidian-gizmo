import { Modal, type App } from "obsidian";
import { backtestTitle, drawBacktest } from "./backtest-view.ts";
import type GizmoPlugin from "./main.ts";
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

/** A backtest of an app over its past, in a window of Obsidian's (see drawBacktest). */
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
    this.titleEl.setText(backtestTitle(this.path, this.before));
    void drawBacktest(this.contentEl, this.plugin.runtime, this.path, this.before, { cancelled: () => this.cancelled, close: () => this.close() });
  }

  onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
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
