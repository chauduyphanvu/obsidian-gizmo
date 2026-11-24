import type { Panel } from "./spec.ts";

type Fields = NonNullable<Panel["fields"]>;

/** A form's fields: its own, else those of the block it saves to; none when it has neither. */
export function formFields(p: Pick<Panel, "fields" | "schema">): Fields {
  return p.fields ?? p.schema ?? {};
}

/** The fields a panel's run takes from what is typed: a form's; a button or a checklist has none. */
export function typedFields(p: Pick<Panel, "view" | "fields" | "schema">): Fields {
  return p.view === "form" ? formFields(p) : {};
}

/** Whether a view shows one figure: a number or a progress panel, whose value a shortcut answers with and an alert reads. */
export function isFigure(p: { view: string }): boolean {
  return p.view === "number" || p.view === "progress";
}

/** The list a checklist ticks into: its `save`, else `checked`. */
export function checklistList(p: Pick<Panel, "save">): string {
  return p.save ?? "checked";
}
