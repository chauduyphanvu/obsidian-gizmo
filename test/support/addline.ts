// Driving a form's add line (src/views/addline.ts) as a person does: type a line, then press Enter.

/** The add line's input inside `el` (a panel, or a whole app when it has one add line). */
export function lineIn(el: Element): HTMLInputElement {
  const input = el.querySelector("input.gz-addline-input");
  if (!input) throw new Error("no add line here");
  return input as HTMLInputElement;
}

/** Types `text` into the add line inside `el`, as typing it does, without saving. */
export function typeLine(el: Element, text: string): HTMLInputElement {
  const input = lineIn(el);
  input.value = text;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  return input;
}

/** Types `text` into the add line inside `el` and presses Enter. */
export function addLine(el: Element, text: string): void {
  typeLine(el, text).closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

/** What the add line inside `el` says under it: its hint, its preview or what it saved. */
export function underLine(el: Element): string {
  return el.querySelector(".gz-addline-under")?.textContent ?? "";
}

/** What the notice under the add line or button inside `el` says, without its Undo. */
export function said(el: Element): string | undefined {
  return el.querySelector(".gz-notice .gz-notice-text")?.textContent ?? undefined;
}
