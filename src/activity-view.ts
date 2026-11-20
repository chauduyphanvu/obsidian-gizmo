import { openAppAt } from "./past-views.ts";
import { Modal, Notice } from "obsidian";
import { describeActor, describeChange, describeSent, doneAt, eventsOf, undoMessage, undoneIn, type Entry } from "./activity.ts";
import { basename } from "./store.ts";
import type GizmoPlugin from "./main.ts";

/** When something happened, as a list of recent things says it. */
export function when(at: number, now: Date): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })} ${time}`;
}

/** What one app (or every app) changed in the vault, newest first, each run with Undo. */
class ActivityModal extends Modal {
  private plugin: GizmoPlugin;
  private app_: string | undefined;
  /** The entry a capture line's receipt links to, shown marked and scrolled to. */
  private focus: string | undefined;

  constructor(plugin: GizmoPlugin, appPath?: string, focus?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.app_ = appPath;
    this.focus = focus;
  }

  onOpen(): void {
    this.titleEl.setText(this.app_ ? `What ${basename(this.app_)} did` : "What your apps did");
    void this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const listed = await this.plugin.activity.list(this.app_);
    // An entry of ledger events is undone as the ledger says, whichever device undid it.
    const ledger = this.plugin.dataLayer.ledger;
    const paths = new Set(listed.flatMap((e) => eventsOf(e)?.map((x) => x.path) ?? []));
    const undone = new Map<string, Set<string>>();
    for (const path of paths) undone.set(path, ledger ? (await ledger.state(path).catch(() => undefined))?.undone ?? new Set() : new Set());
    const entries = listed.map((e) => ({ ...e, undone: undoneIn(e, (path) => undone.get(path) ?? new Set()) }));
    const el = this.contentEl;
    el.empty();
    const box = el.createDiv({ cls: "gizmo gz-activity" });
    if (!entries.length) {
      box.createEl("p", { cls: "gz-muted", text: this.app_ ? "Nothing yet: what this app saves, changes or creates shows here." : "Nothing yet: what your apps save, change or create shows here." });
      return;
    }
    const now = new Date();
    for (const entry of entries) {
      const row = box.createDiv({ cls: "gz-activity-entry" });
      this.renderEntry(row, entry, now);
      if (entry.id !== this.focus) continue;
      row.addClass("gz-activity-focus");
      window.requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
    }
    if (this.focus && !entries.some((e) => e.id === this.focus)) {
      box.prepend(createEl("p", { cls: "gz-muted", text: "That change is no longer in the activity log: it keeps the newest 200 per app." }));
    }
  }

  private renderEntry(row: HTMLElement, entry: Entry, now: Date): void {
    const head = row.createDiv({ cls: "gz-activity-head" });
    const where = entry.device ? ` on ${entry.device}` : "";
    const who = (this.app_ ? describeActor(entry.actor) : `${basename(entry.app)} · ${describeActor(entry.actor)}`) + where;
    head.createSpan({ cls: "gz-activity-when", text: when(entry.at, now) });
    head.createSpan({ cls: "gz-activity-who", text: ` ${who}: ${entry.what}` });
    const ul = row.createEl("ul");
    const total = entry.changes.length;
    entry.changes.forEach((c, i) => {
      const li = ul.createEl("li", { text: describeChange(c) });
      if (i >= total - entry.undone) li.addClass("gz-undone");
    });
    if (entry.sent) ul.createEl("li", { text: describeSent(entry.what, entry.sent) });
    // In one app's history, each change can be seen as the app showed it just after.
    if (this.app_ && total) {
      const path = this.app_;
      head.createEl("button", { cls: "gz-activity-then", text: "See it then" }).addEventListener("click", () => {
        this.close();
        void openAppAt(this.plugin, path, doneAt(entry));
      });
    }
    // What was sent out can't be taken back; another device's change only when it is kept as events.
    if (total === 0 || (entry.device && !eventsOf(entry))) return;
    if (entry.undone >= total) {
      head.createSpan({ cls: "gz-activity-undone", text: "Undone" });
      return;
    }
    const button = head.createEl("button", { cls: "gz-activity-undo", text: entry.undone ? "Undo the rest" : "Undo" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = await this.plugin.undo(entry);
      new Notice(undoMessage(result));
      await this.render();
    });
  }
}

export function openActivity(plugin: GizmoPlugin, appPath?: string, focus?: string): void {
  new ActivityModal(plugin, appPath, focus).open();
}

/** "Show app activity": the open app's, or every app's when no app is open. */
export function registerActivity(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "show-activity",
    name: "Show app activity",
    callback: () => {
      const file = plugin.app.workspace.getActiveFile();
      openActivity(plugin, file && plugin.isApp(file) ? file.path : undefined);
    },
  });
}
