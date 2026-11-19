import { periodStart, shiftPeriod, stampParts } from "./data.ts";
import type { InputDef, InputValue } from "./template.ts";

/** A YYYY-MM-DD date n days away. */
export function shiftDay(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return stampParts(new Date(shiftPeriod(periodStart(new Date(y, m - 1, d).getTime(), "day"), "day", n))).date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The bar above an app's panels: a dropdown per list of choices, a ‹ date › Today bar per date. */
export function renderInputBar(
  parent: HTMLElement,
  defs: InputDef[],
  values: Readonly<Record<string, InputValue>>,
  today: () => string,
  onChange: (name: string, value: InputValue) => void,
): HTMLElement {
  const bar = parent.createDiv({ cls: "na-inputs" });
  for (const def of defs) {
    const field = bar.createDiv({ cls: "na-input" });
    field.createSpan({ cls: "na-input-name", text: def.name });
    if (def.kind === "choice") {
      const select = field.createEl("select", { cls: "dropdown" });
      select.setAttr("aria-label", def.name);
      // Options carry their index, so a number choice comes back as a number.
      def.options.forEach((option, i) => {
        const el = select.createEl("option", { text: String(option), value: String(i) });
        if (option === values[def.name]) el.setAttr("selected", "");
      });
      select.addEventListener("change", () => onChange(def.name, def.options[Number(select.value)]));
      continue;
    }
    const prev = field.createEl("button", { cls: "na-small", text: "‹" });
    prev.setAttr("aria-label", "Previous day");
    const input = field.createEl("input", { type: "date" });
    input.setAttr("aria-label", def.name);
    input.value = String(values[def.name]);
    const next = field.createEl("button", { cls: "na-small", text: "›" });
    next.setAttr("aria-label", "Next day");
    const now = field.createEl("button", { cls: "na-small", text: "Today" });
    const set = (date: string) => {
      input.value = date;
      onChange(def.name, date);
    };
    prev.addEventListener("click", () => set(shiftDay(input.value, -1)));
    next.addEventListener("click", () => set(shiftDay(input.value, 1)));
    now.addEventListener("click", () => set(today()));
    input.addEventListener("change", () => { if (DATE.test(input.value)) set(input.value); });
  }
  return bar;
}
