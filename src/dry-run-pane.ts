import { dryLines } from "./background-shortcuts.ts";
import type { MapApp } from "./map.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { textOf } from "./text.ts";

export type MapShortcut = MapApp["shortcuts"][number];

export const dryRunTitle = (shortcut: MapShortcut, name: string): string => `If “${shortcut.label}” in ${name} ran now`;

/**
 * What a shortcut would change if it ran now, through every app its `then` reaches, worked out
 * without writing anything. A form's fields can be typed in, and it works it out again as you type.
 * Gives how to stop.
 */
export function drawDryRun(parent: HTMLElement, rt: GizmoRuntime, path: string, shortcut: MapShortcut): () => void {
  const values: Record<string, string> = {};
  let timer: number | undefined;
  let run = 0;
  let stopped = false;
  const el = parent.createDiv({ cls: "gizmo gz-share gz-dry" });
  // Each field as the form draws it, holding what a link that left it out would save.
  const start = rt.background.formStart(path, shortcut.id);
  if (start) {
    const form = el.createDiv({ cls: "gz-dry-fields" });
    // An empty number is saved empty, as the form saves it; a link can't say empty, so it is left out.
    const changed = (field: string, value: string) => {
      if (value === "" && start.fields[field] === "number") delete values[field];
      else values[field] = value;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void show(), 250);
    };
    for (const [field, type] of Object.entries(start.fields)) {
      const label = form.createEl("label", { cls: "gz-input" });
      label.createSpan({ cls: "gz-input-name", text: field });
      const value = start.row[field];
      if (value !== null && value !== undefined) values[field] = textOf(value);
      if (Array.isArray(type)) {
        const select = label.createEl("select", { cls: "dropdown" });
        for (const option of type) select.createEl("option", { text: String(option), value: String(option) });
        select.value = values[field] ?? "";
        select.addEventListener("change", () => changed(field, select.value));
      } else if (type === "checkbox") {
        const box = label.createEl("input", { type: "checkbox" });
        box.checked = value === true;
        box.addEventListener("change", () => changed(field, String(box.checked)));
      } else {
        const input = label.createEl("input", { type: ["number", "date", "time"].includes(type) ? type : "text", value: values[field] ?? "" });
        input.addEventListener("input", () => changed(field, input.value));
      }
    }
  }
  el.createEl("h4", { text: "It would:" });
  const list = el.createEl("ul", { cls: "gz-effects" });
  el.createEl("p", { cls: "gz-muted", text: "Worked out on copies of the notes it would change; nothing has been written." });

  const show = async () => {
    const mine = ++run;
    const params = shortcut.fields.length ? { ...values } : undefined;
    const steps = await rt.background.dryRun(path, shortcut.id, params);
    if (mine !== run || stopped) return;
    list.empty();
    for (const line of dryLines(steps ?? [])) list.createEl("li", { text: line });
  };
  void show();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}
