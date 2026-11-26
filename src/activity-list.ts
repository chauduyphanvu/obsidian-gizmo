/**
 * What apps changed in the vault, newest first, each with Undo and, in one app's history, See it
 * then: drawn into any element, by any host the runtime runs in (a window, or the side sheet).
 */
import { describeActor, describeChange, describeSent, doneAt, undoButton, undoMessage, when, type Entry } from "./activity.ts";
import { handler } from "./handler.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { basename } from "./store.ts";

/** Whose changes to draw, and what each can lead to. */
export interface ActivityOpts {
  /** One app's changes; every app's when absent. */
  appPath?: string;
  /** The entry a capture line's receipt links to, shown marked and scrolled to. */
  focus?: string;
  /** One app's: shows the app as it was just after a change. */
  readonly seeThen?: (at: number) => void;
}

/** What one app (or every app) changed in the vault, newest first, each with Undo: in a window, or the side sheet's History. */
export async function drawActivity(el: HTMLElement, rt: GizmoRuntime, notify: (message: string) => void, o: ActivityOpts): Promise<void> {
  const path = o.appPath;
  const entries = await rt.activityShown(path);
  el.empty();
  const box = el.createDiv({ cls: "gizmo gz-activity" });
  if (!entries.length) {
    box.createEl("p", { cls: "gz-muted", text: path ? "Nothing yet: what this app saves, changes or creates shows here." : "Nothing yet: what your apps save, change or create shows here." });
    return;
  }
  const now = new Date();
  for (const entry of entries) {
    const row = box.createDiv({ cls: "gz-activity-entry" });
    drawEntry(row, entry, now, rt, notify, o, () => drawActivity(el, rt, notify, o));
    if (entry.id !== o.focus) continue;
    row.addClass("gz-activity-focus");
    window.requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
  }
  if (o.focus && !entries.some((e) => e.id === o.focus)) {
    box.prepend(createEl("p", { cls: "gz-muted", text: "That change is no longer in the activity log: it keeps the newest 200 per app." }));
  }
}

function drawEntry(row: HTMLElement, entry: Entry, now: Date, rt: GizmoRuntime, notify: (message: string) => void, o: ActivityOpts, again: () => Promise<void>): void {
  const head = row.createDiv({ cls: "gz-activity-head" });
  const where = entry.device ? ` on ${entry.device}` : "";
  const who = (o.appPath ? describeActor(entry.actor) : `${basename(entry.app)} · ${describeActor(entry.actor)}`) + where;
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
  const seeThen = o.seeThen;
  if (seeThen && total) {
    head.createEl("button", { cls: "gz-activity-then", text: "See it then" }).addEventListener("click", () => seeThen(doneAt(entry)));
  }
  const offer = undoButton(entry);
  if (offer === "none") return;
  if (offer === "undone") {
    head.createSpan({ cls: "gz-activity-undone", text: "Undone" });
    return;
  }
  const button = head.createEl("button", { cls: "gz-activity-undo", text: offer });
  button.addEventListener("click", handler(async () => {
    button.disabled = true;
    notify(undoMessage(await rt.undo(entry)));
    await again();
  }));
}
