import { textOf } from "../text.ts";
import { handler } from "../handler.ts";
import { type Row } from "../data.ts";
import { stampParts } from "../time.ts";
import type { Panel } from "../spec.ts";
import { THIS } from "../template.ts";
import { labelOf } from "../format.ts";
import { busy, fieldControl, heading, needsAction, redraw, stillInPast } from "./common.ts";
import { ACTION_KEYS, checkFields, isPlainObject, startOf } from "../keys.ts";
import { addLine, fitsOneLine, underFields, verbButton } from "./addline.ts";
import type { PanelCtx, PanelHandle, ViewDef } from "./registry.ts";

/** Whether a panel sits in the composed layout's line to add things; asked at each draw. */
const inLine = (ctx: PanelCtx) => ctx.place?.()?.slot === "compose";

/**
 * A view drawn one way in the line to add things and another elsewhere; drawn again the other way
 * when an update finds it has moved.
 */
function placed(el: HTMLElement, ctx: PanelCtx, draw: (composed: boolean) => PanelHandle): PanelHandle {
  let composed = inLine(ctx);
  let shown = draw(composed);
  return {
    update(data) {
      if (inLine(ctx) !== composed) {
        shown.destroy?.();
        el.empty();
        composed = !composed;
        shown = draw(composed);
      }
      shown.update(data);
    },
    destroy: () => shown.destroy?.(),
  };
}

export const button: ViewDef = {
  id: "button",
  keys: [...ACTION_KEYS, "label", "shortcut", "alias", "then"],
  span: 1,
  validate: (p) => needsAction("button", p),
  examples: [
    { panel: { view: "button", label: "Took meds", save: "doses", append: "Daily", line: "- Took meds {time}" } },
    { panel: { view: "button", label: "Nothing" }, errors: ["button needs at least one of save, append, notify, open, then"] },
    { panel: { view: "button", notify: "Hi", unit: "kg" }, errors: ['"unit" doesn\'t apply to button'] },
    { panel: { view: "button", label: "Today's note", open: "Daily/{date}" } },
    { panel: { view: "button", label: "New idea", save: "Ideas/", row: { status: "new" }, template: "[[Idea template]]" } },
    { panel: { view: "button", label: "Took meds", save: "doses", shortcut: "took-meds" } },
    { panel: { view: "button", label: "Took meds", save: "doses", shortcut: "Took meds" }, errors: ["shortcut must be lowercase letters, digits and -"] },
    { panel: { view: "button", label: "Took meds", save: "doses", alias: "meds" } },
    { panel: { view: "button", label: "Took meds", save: "doses", alias: "My meds" } },
    { panel: { view: "button", label: "Took meds", save: "doses", alias: "meds!" }, errors: ["alias must be words of letters and digits (with - and '), up to 40 characters"] },
  ],
  mount: (el, p, ctx) => {
    stillInPast(el, ctx);
    return placed(el, ctx, (composed) => (composed ? verbButton(el, p, ctx) : redraw(el, () => {
      heading(el, p);
      const b = el.createEl("button", { cls: "mod-cta gz-button", text: p.label ?? "Log" });
      busy(b, () => ctx.runActions(p, {}));
    })));
  },
};

const fieldCls = (type: string | string[]) => (type === "checkbox" ? "gz-field gz-field-check" : type === "textarea" ? "gz-field gz-field-wide" : "gz-field");

function asFieldsForm(el: HTMLElement): void {
  el.removeClass("gz-form-line");
  el.addClass("gz-form-fields");
}

/** A form with `save: this`: its fields hold the properties of the note the app sits in, saved as they change. */
function propertyForm(el: HTMLElement, p: Panel, ctx: PanelCtx): PanelHandle {
  heading(el, p);
  asFieldsForm(el);
  const f = el.createEl("form", { cls: "gz-form" });
  f.addEventListener("submit", (e) => e.preventDefault());
  const fields = Object.entries(p.fields!).map(([name, type]) => {
    const label = f.createEl("label", { cls: fieldCls(type) });
    label.createSpan({ text: labelOf(p, name) });
    // Inside its label, which names it; a field typed textarea gets a text box of its own.
    const show = fieldControl(label, type, (value) => ctx.setProperty?.(name, value) ?? Promise.resolve(), { input: (t) => t });
    return [name, show] as const;
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
  keys: [...ACTION_KEYS, "fields", "labels", "label", "shortcut", "alias", "then"],
  span: 4,
  // The list it saves to, which a choice left out of its add line is guessed from.
  implicitSource: (p) => (p.target?.kind === "this" ? THIS : p.target?.kind !== "list" ? undefined : p.target.at !== undefined ? p.save : p.target.name),
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
  mount: (el, p, ctx, key) => {
    stillInPast(el, ctx);
    return p.target?.kind === "this"
      ? propertyForm(el, p, ctx)
      : placed(el, ctx, (composed) => (composed ? lineOrFields(el, p, ctx, key) : fieldsForm(el, p, ctx)));
  },
};

/**
 * A form in the line to add things: one typed line when it reads as one, else its fields. Where
 * both make sense, either switches to the other.
 */
function lineOrFields(el: HTMLElement, p: Panel, ctx: PanelCtx, key: string): PanelHandle {
  let rows: unknown;
  let shown: PanelHandle | undefined;
  const draw = () => {
    shown?.destroy?.();
    el.empty();
    const fits = fitsOneLine(p);
    const switchTo = (fields: boolean) => () => {
      asFields.set(key, fields);
      draw();
    };
    shown = fits && !asFields.get(key) ? addLine(el, p, ctx, switchTo(true)) : fieldsForm(el, p, ctx, fits ? switchTo(false) : null);
    shown.update(rows);
  };
  draw();
  return {
    update(data) {
      rows = data;
      shown?.update(data);
    },
    destroy: () => shown?.destroy?.(),
  };
}

/** In the line to add things, the forms switched to their fields (true) or back to one line, by panel, while Obsidian runs. */
const asFields = new Map<string, boolean>();

/**
 * A form as its fields, drawn once, so what is typed in them is never lost to new data. In the line
 * to add things (`other` given there, or null when the form only reads as fields), what it saved is
 * said under it with Undo, and `other` switches it to one line.
 */
function fieldsForm(el: HTMLElement, p: Panel, ctx: PanelCtx, other?: (() => void) | null): PanelHandle {
  heading(el, p);
  asFieldsForm(el);
  const f = el.createEl("form", { cls: "gz-form" });
  const inputs: [string, string | string[], HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement][] = [];
  for (const [name, type] of Object.entries(p.fields ?? p.schema!)) {
    const label = f.createEl("label", { cls: fieldCls(type) });
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
      if (start !== undefined) input.textContent = textOf(start);
    } else {
      input = label.createEl("input", { type: type === "number" ? "number" : type });
      if (type === "number") input.setAttr("step", "any");
      if (type === "checkbox") {
        if (start === true) input.setAttr("checked", "");
      } else if (start !== undefined) {
        input.setAttr("value", textOf(start));
        input.value = textOf(start);
      }
    }
    inputs.push([name, type, input]);
  }
  const submit = f.createEl("button", { cls: "mod-cta", text: p.label ?? "Save", type: "submit" });
  const said = other !== undefined ? underFields(el, p, ctx, other ?? undefined) : undefined;
  f.addEventListener("submit", handler(async (e) => {
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
      const r = await ctx.runActions(p, row, said && { inPlace: true });
      f.querySelector(".gz-form-error")?.remove();
      // Refused by the app's expect: what was typed stays, with why.
      if (r && r.error) f.createDiv({ cls: "gz-form-error", text: `Not saved: ${r.error}` });
      else {
        f.reset();
        said?.saved(row, r);
      }
    } finally {
      submit.disabled = false;
    }
  }));
  return { update() {}, destroy: () => said?.destroy() };
}

export const checklist: ViewDef = {
  id: "checklist",
  keys: ["items", "save", "label", "shortcut", "alias"],
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
    { panel: { view: "checklist", items: ["Passport", "Chargers"], save: "packed", shortcut: "pack" } },
  ],
  mount: (el, p, ctx) => (stillInPast(el, ctx), redraw(el, (saved) => {
    const key = p.save ?? "checked";
    const checked = new Set((Array.isArray(saved) ? saved : []).map(String));
    const items = p.items!.map(String);
    const done = items.filter((i) => checked.has(i)).length;
    const top = el.createDiv({ cls: "gz-row" });
    top.createDiv({ cls: "gz-title", text: `${p.title ?? p.label ?? "Checklist"} · ${done}/${items.length}` });
    const clear = top.createEl("button", { cls: "gz-small", text: "Clear" });
    busy(clear, () => ctx.clearChecked(key));
    const ul = el.createEl("ul", { cls: "gz-checklist" });
    for (const item of items) {
      const label = ul.createEl("li").createEl("label");
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = checked.has(item);
      label.createSpan({ text: item });
      box.addEventListener("change", () => void ctx.toggleChecked(key, item));
    }
  })),
};
