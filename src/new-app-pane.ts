import { nameProblem, newAppProblem, newAppText } from "./new-app.ts";
import type { GizmoRuntime } from "./runtime.ts";

export interface NewAppHost {
  /** Where the note goes, in words: "at the top of the vault", "in Apps". */
  where: string;
  /** The names of the files and folders already there. */
  taken(): string[];
  /** Makes the app; says why when it can't. */
  create(name: string, purpose: string): Promise<string | undefined>;
  close(): void;
}

/** A row as Obsidian's settings draw one: a name and a line under it, and beside them the element given back for a control. */
export function settingRow(el: HTMLElement, name: string, desc?: string): HTMLElement {
  const item = el.createDiv({ cls: "setting-item" });
  const info = item.createDiv({ cls: "setting-item-info" });
  info.createDiv({ cls: "setting-item-name", text: name });
  if (desc) info.createDiv({ cls: "setting-item-description", text: desc });
  return item.createDiv({ cls: "setting-item-control" });
}

/** A text field in a setting's row, Enter calling `enter`. */
export function settingText(control: HTMLElement, placeholder: string, changed: (value: string) => void, enter: () => void): HTMLInputElement {
  const input = control.createEl("input", { type: "text", placeholder, attr: { spellcheck: "false" } });
  input.addEventListener("input", () => changed(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    enter();
  });
  return input;
}

/** Asks for the new app's name and what it is for, and says inline why it can't be made yet. */
export function drawNewApp(parent: HTMLElement, host: NewAppHost): void {
  const el = parent.createDiv({ cls: "gizmo" });
  let name = "";
  let purpose = "";
  let tried = false;
  const nameInput = settingText(settingRow(el, "Name", `The note's name; it goes ${host.where}.`), "Water", (v) => { name = v; check(); }, () => void submit());
  settingText(settingRow(el, "What is it for?", "One sentence. It becomes the app line."), "Count the glasses of water I drink each day", (v) => { purpose = v; check(); }, () => void submit());
  window.setTimeout(() => nameInput.focus(), 0);
  const said = el.createDiv({ cls: "gz-new-app-problem" });
  const row = el.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { text: "Cancel" }).addEventListener("click", () => host.close());
  const createButton = row.createEl("button", { cls: "mod-cta", text: "Create" });
  createButton.addEventListener("click", () => void submit());

  // What's wrong with a name is said as it is typed; a field left empty only once Create is tried.
  const check = () => {
    const problem = newAppProblem(name, purpose, host.taken());
    said.setText((tried ? problem : name.trim() ? nameProblem(name, host.taken()) : undefined) ?? "");
    return problem;
  };
  const submit = async () => {
    tried = true;
    if (check() || createButton.disabled) return;
    createButton.disabled = true;
    const failed = await host.create(name.trim(), purpose.trim());
    if (!failed) return host.close();
    said.setText(failed);
    createButton.disabled = false;
  };
}

/** Makes an app note of only its app line in `folder` ("" for the vault's top), never over a note there: its path and text, or why it couldn't. */
export async function makeApp(rt: GizmoRuntime, folder: string, name: string, purpose: string): Promise<{ path: string; text: string } | { error: string }> {
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  const text = newAppText(purpose);
  try {
    if (!(await rt.host.writes.createText(path, text))) throw new Error("File already exists.");
    return { path, text };
  } catch (e) {
    return { error: `Couldn't make the note: ${(e as Error).message}` };
  }
}
