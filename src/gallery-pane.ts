import { setUp, type GalleryApp, type GalleryNote, type KitParam } from "./gallery.ts";
import { settingRow } from "./new-app-pane.ts";

export const setUpTitle = (gallery: GalleryApp): string => `Set up ${gallery.name}`;

/** Asks for the values of the kit an app is before it's copied: one field for each param, filled in with the gallery's. */
export function drawSetUp(parent: HTMLElement, gallery: GalleryApp, params: KitParam[], asks: string, host: { copy(note: GalleryNote): void; close(): void }): void {
  const el = parent.createDiv({ cls: "gizmo" });
  el.createEl("p", { text: "Give it your own values. You can change them later in its with: line." });
  if (asks) el.createEl("p", { cls: "gz-muted", text: asks });
  const typed: Record<string, string> = {};
  const done = () => {
    host.close();
    host.copy(setUp(gallery.note, params, typed));
  };
  const inputs: HTMLInputElement[] = [];
  for (const p of params) {
    const input = settingRow(el, p.name).createEl("input", { type: "text", attr: { spellcheck: "false" } });
    if (typeof p.value === "number") {
      input.type = "number";
      input.step = "any";
    }
    input.value = p.value === undefined ? "" : String(p.value);
    input.addEventListener("input", () => { typed[p.name] = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      done();
    });
    inputs.push(input);
  }
  const row = el.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { text: "Cancel" }).addEventListener("click", () => host.close());
  row.createEl("button", { cls: "mod-cta", text: "Copy" }).addEventListener("click", done);
  inputs[0]?.select();
}

/** The app chosen is in the vault already: open yours, or leave it. */
export function drawHaveIt(parent: HTMLElement, name: string, host: { open(): void; close(): void }): void {
  const el = parent.createDiv({ cls: "gizmo" });
  el.createEl("p", { text: `You already have “${name}”.` });
  const row = el.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { text: "Cancel" }).addEventListener("click", () => host.close());
  row.createEl("button", { cls: "mod-cta", text: "Open yours" }).addEventListener("click", () => {
    host.open();
    host.close();
  });
}
