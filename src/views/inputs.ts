import { stampParts, type Row } from "../data.ts";
import { ACTION_KEYS, busy, heading, needsAction, redraw } from "./common.ts";
import type { ViewDef } from "./registry.ts";

const FIELD_TYPES = ["text", "number", "date", "time", "checkbox", "textarea"];

export const button: ViewDef = {
  id: "button",
  keys: [...ACTION_KEYS, "label"],
  wide: false,
  validate: (p) => needsAction("button", p),
  examples: [
    { panel: { view: "button", label: "Took meds", save: "doses", append: "Daily", line: "- Took meds {time}" } },
    { panel: { view: "button", label: "Nothing" }, errors: ["button needs at least one of save, append, notify"] },
    { panel: { view: "button", notify: "Hi", unit: "kg" }, errors: ['"unit" doesn\'t apply to button'] },
  ],
  mount: (el, p, ctx) => redraw(el, () => {
    heading(el, p);
    const b = el.createEl("button", { cls: "mod-cta na-button", text: p.label ?? "Log" });
    busy(b, () => ctx.runActions(p, {}));
  }),
};

export const form: ViewDef = {
  id: "form",
  keys: [...ACTION_KEYS, "fields", "label"],
  wide: true,
  validate(p) {
    const errors = p.fields ? [] : ["form needs fields"];
    for (const [name, type] of Object.entries(p.fields ?? {})) {
      if (typeof type === "string" && !FIELD_TYPES.includes(type)) {
        errors.push(`field "${name}" type must be one of ${FIELD_TYPES.join(", ")} or a list of choices`);
      }
    }
    return [...errors, ...needsAction("form", p)];
  },
  examples: [
    { panel: { view: "form", fields: { weight: "number", note: "text", mood: ["good", "ok"] }, save: "weights" } },
    { panel: { view: "form", fields: { weight: "kilos" }, save: "weights" }, errors: ['field "weight" type must be one of text, number, date, time, checkbox, textarea or a list of choices'] },
  ],
  mount: (el, p, ctx) => redraw(el, () => {
    heading(el, p);
    const f = el.createEl("form", { cls: "na-form" });
    const inputs: [string, string | string[], HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement][] = [];
    for (const [name, type] of Object.entries(p.fields!)) {
      const label = f.createEl("label", { cls: "na-field" });
      label.createSpan({ text: name });
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (Array.isArray(type)) {
        input = label.createEl("select");
        for (const opt of type) input.createEl("option", { text: String(opt), value: String(opt) });
      } else if (type === "textarea") {
        input = label.createEl("textarea");
      } else {
        input = label.createEl("input", { type: type === "number" ? "number" : type });
        if (type === "number") input.setAttr("step", "any");
        if (type === "date") input.value = stampParts(ctx.now).date;
      }
      inputs.push([name, type, input]);
    }
    const submit = f.createEl("button", { cls: "mod-cta", text: p.label ?? "Save", type: "submit" });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const row: Row = {};
      for (const [name, type, input] of inputs) {
        if (type === "checkbox") row[name] = (input as HTMLInputElement).checked;
        else if (type === "number") row[name] = input.value === "" ? null : Number(input.value);
        else row[name] = input.value;
      }
      submit.disabled = true;
      try {
        await ctx.runActions(p, row);
        f.reset();
      } finally {
        submit.disabled = false;
      }
    });
  }),
};

export const checklist: ViewDef = {
  id: "checklist",
  keys: ["items", "save", "label"],
  wide: true,
  implicitSource: (p) => p.save ?? "checked",
  validate: (p) => (p.items?.length ? [] : ["checklist needs items"]),
  examples: [
    { panel: { view: "checklist", items: ["Passport", "Chargers"], save: "packed" } },
    { panel: { view: "checklist", items: ["Passport"], append: "Daily" }, errors: ['"append" doesn\'t apply to checklist'] },
  ],
  mount: (el, p, ctx) => redraw(el, (saved) => {
    const key = p.save ?? "checked";
    const checked = new Set((Array.isArray(saved) ? saved : []).map(String));
    const items = p.items!.map(String);
    const done = items.filter((i) => checked.has(i)).length;
    const top = el.createDiv({ cls: "na-row" });
    top.createDiv({ cls: "na-title", text: `${p.title ?? p.label ?? "Checklist"} · ${done}/${items.length}` });
    const clear = top.createEl("button", { cls: "na-small", text: "Clear" });
    busy(clear, () => ctx.clearChecked(key));
    const ul = el.createEl("ul", { cls: "na-checklist" });
    for (const item of items) {
      const label = ul.createEl("li").createEl("label");
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = checked.has(item);
      label.createSpan({ text: item });
      box.addEventListener("change", () => void ctx.toggleChecked(key, item));
    }
  }),
};
