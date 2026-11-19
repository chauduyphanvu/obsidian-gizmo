import { stampParts, type Row } from "../data.ts";
import type { Panel } from "../spec.ts";
import { THIS } from "../template.ts";
import { labelOf } from "../format.ts";
import { ACTION_KEYS, busy, checkFields, heading, isPlainObject, needsAction, redraw, startOf } from "./common.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "./registry.ts";

export const button: ViewDef = {
  id: "button",
  keys: [...ACTION_KEYS, "label", "shortcut"],
  span: 1,
  validate: (p) => needsAction("button", p),
  examples: [
    { panel: { view: "button", label: "Took meds", save: "doses", append: "Daily", line: "- Took meds {time}" } },
    { panel: { view: "button", label: "Nothing" }, errors: ["button needs at least one of save, append, notify"] },
    { panel: { view: "button", notify: "Hi", unit: "kg" }, errors: ['"unit" doesn\'t apply to button'] },
    { panel: { view: "button", label: "Today's note", open: "Daily/{date}" } },
    { panel: { view: "button", label: "New idea", save: "Ideas/", row: { status: "new" }, template: "[[Idea template]]" } },
    { panel: { view: "button", label: "Took meds", save: "doses", shortcut: "took-meds" } },
    { panel: { view: "button", label: "Took meds", save: "doses", shortcut: "Took meds" }, errors: ["shortcut must be lowercase letters, digits and -"] },
  ],
  mount: (el, p, ctx) => redraw(el, () => {
    heading(el, p);
    const b = el.createEl("button", { cls: "mod-cta na-button", text: p.label ?? "Log" });
    busy(b, () => ctx.runActions(p, {}));
  }),
};

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * One field of a `save: this` form. A checkbox or dropdown writes at once; text, numbers and dates
 * when changed (leaving the field, or Enter). The control is disabled while its write runs and keeps
 * focus. Returns what shows the note's value, which leaves a field being typed in alone.
 */
function propertyField(label: HTMLElement, type: string | string[], write: (value: unknown) => Promise<void>): (value: unknown) => void {
  const run = async (control: Control, value: unknown) => {
    const focused = control.ownerDocument.activeElement === control;
    control.disabled = true;
    try {
      await write(value);
    } finally {
      control.disabled = false;
      if (focused) control.focus();
    }
  };
  if (Array.isArray(type)) {
    const select = label.createEl("select", { cls: "dropdown" });
    let options: unknown[] = [];
    select.addEventListener("change", () => void run(select, options[Number(select.value)]));
    return (v) => {
      // A value that isn't one of the choices (or none yet) is still shown as it is.
      options = type.some((c) => c === v) ? type : [v ?? "", ...type];
      select.empty();
      options.forEach((o, i) => {
        const option = select.createEl("option", { text: String(o), value: String(i) });
        if (o === (v ?? "")) option.setAttr("selected", "");
      });
    };
  }
  if (type === "checkbox") {
    const box = label.createEl("input", { type: "checkbox" });
    box.addEventListener("change", () => void run(box, box.checked));
    return (v) => { box.checked = v === true; };
  }
  const input = type === "textarea" ? label.createEl("textarea") : label.createEl("input", { type });
  if (type === "number") input.setAttr("step", "any");
  let saved = "";
  input.addEventListener("change", () => {
    saved = input.value;
    void run(input, type === "number" ? (input.value === "" ? null : Number(input.value)) : input.value);
  });
  return (v) => {
    if (input.ownerDocument.activeElement === input || input.value !== saved) return;
    saved = v === undefined || v === null ? "" : String(v);
    input.value = saved;
  };
}

/** A form with `save: this`: its fields hold the properties of the note the app sits in, saved as they change. */
function propertyForm(el: HTMLElement, p: Panel, ctx: PanelCtx): PanelHandle {
  heading(el, p);
  const f = el.createEl("form", { cls: "na-form" });
  f.addEventListener("submit", (e) => e.preventDefault());
  const fields = Object.entries(p.fields!).map(([name, type]) => {
    const label = f.createEl("label", { cls: "na-field" });
    label.createSpan({ text: labelOf(p, name) });
    return [name, propertyField(label, type, (value) => ctx.setProperty?.(name, value) ?? Promise.resolve())] as const;
  });
  return {
    update(note) {
      const props = isPlainObject(note) ? note : {};
      for (const [name, show] of fields) show(props[name]);
    },
  };
}

export const form: ViewDef = {
  id: "form",
  keys: [...ACTION_KEYS, "fields", "label", "shortcut"],
  span: 4,
  implicitSource: (p) => (p.target?.kind === "this" ? THIS : undefined),
  validate(p) {
    // Without its own fields, a form takes those of the block it saves to.
    const fields = p.fields ?? p.schema;
    const errors = fields ? checkFields(fields) : ["form needs fields"];
    if (p.target?.kind !== "this") return [...errors, ...needsAction("form", p)];
    const others = ACTION_KEYS.filter((k) => k !== "save" && p[k] !== undefined);
    return [...errors, ...others.map((k) => `"${k}" doesn't apply with save: this, which saves each field as it changes`)];
  },
  examples: [
    { panel: { view: "form", fields: { weight: "number", note: "text", mood: ["good", "ok"] }, save: "weights" } },
    { panel: { view: "form", fields: { weight: "kilos" }, save: "weights" }, errors: ['field "weight" type must be one of text, number, date, time, checkbox, textarea or a list of choices'] },
    { panel: { view: "form", fields: { title: "text", author: "text" }, save: "Books/", name: "{title}", open: "{path}" } },
    { panel: { view: "form", save: "books" }, errors: ["form needs fields"] },
    { panel: { view: "form", fields: { page: "number", status: ["to read", "reading", "done"] }, save: "this" } },
    { panel: { view: "form", fields: { page: "number" }, save: "this", notify: "Saved" }, errors: ['"notify" doesn\'t apply with save: this, which saves each field as it changes'] },
    { panel: { view: "form", fields: { weight: "number" }, save: "weights", shortcut: "weigh-in" } },
    { panel: { view: "form", fields: { mood: { type: ["low", "ok", "good"], label: "How I feel", default: "ok" }, slept: { type: "number", label: "Hours slept" } }, save: "moods" } },
    { panel: { view: "form", fields: { mood: { type: ["low", "ok"], default: "great" } }, save: "moods" }, errors: ['field "mood" default must be one of its choices: low, ok'] },
    { panel: { view: "form", fields: ["mood", "slept"], save: "moods" }, errors: ["fields as a list names fields of the block the form saves to; save to a block with fields, or give each field a type"] },
  ],
  mount: (el, p, ctx) => (p.target?.kind === "this" ? propertyForm(el, p, ctx) : redraw(el, () => {
    heading(el, p);
    const f = el.createEl("form", { cls: "na-form" });
    const inputs: [string, string | string[], HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement][] = [];
    for (const [name, type] of Object.entries(p.fields ?? p.schema!)) {
      const label = f.createEl("label", { cls: "na-field" });
      label.createSpan({ text: labelOf(p, name) });
      // Set as the field's default, so the form's reset after a save brings it back.
      const start = startOf(p.fieldInfo?.[name], ctx.now) ?? (type === "date" ? stampParts(ctx.now).date : undefined);
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (Array.isArray(type)) {
        input = label.createEl("select");
        for (const opt of type) {
          const option = input.createEl("option", { text: String(opt), value: String(opt) });
          if (start !== undefined && opt === start) option.setAttr("selected", "");
        }
      } else if (type === "textarea") {
        input = label.createEl("textarea");
        if (start !== undefined) input.textContent = String(start);
      } else {
        input = label.createEl("input", { type: type === "number" ? "number" : type });
        if (type === "number") input.setAttr("step", "any");
        if (type === "checkbox") {
          if (start === true) input.setAttr("checked", "");
        } else if (start !== undefined) {
          input.setAttr("value", String(start));
          input.value = String(start);
        }
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
        // A choice is saved as it was typed in the list: 70 stays a number.
        else if (Array.isArray(type)) row[name] = type.find((o) => String(o) === input.value) ?? input.value;
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
  })),
};

export const checklist: ViewDef = {
  id: "checklist",
  keys: ["items", "save", "label"],
  span: 4,
  implicitSource: (p) => p.save ?? "checked",
  validate: (p) => [
    ...(p.items?.length ? [] : ["checklist needs items"]),
    ...(p.save?.endsWith("/") ? ["checklist saves its ticks to a list, not a folder; leave out the /"] : []),
  ],
  examples: [
    { panel: { view: "checklist", items: ["Passport", "Chargers"], save: "packed" } },
    { panel: { view: "checklist", items: ["Passport"], append: "Daily" }, errors: ['"append" doesn\'t apply to checklist'] },
    { panel: { view: "checklist", items: ["Passport"], save: "Trips/" }, errors: ["checklist saves its ticks to a list, not a folder; leave out the /"] },
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
