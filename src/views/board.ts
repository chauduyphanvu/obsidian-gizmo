import { fillWith, getPath, rowsOf, type Row } from "../data.ts";
import { display, formatErrors, mapped } from "../format.ts";
import { NONE } from "../group.ts";
import type { Panel } from "../spec.ts";
import { conflictChip, heading, noteLink, rowKey, rowNote, selectable } from "./common.ts";
import { DATA_KEYS } from "../keys.ts";
import { editErrors } from "../edit.ts";
import type { PanelHandle, ViewDef } from "./registry.ts";

/** A card's (or timeline row's) text: the `item` template, else the row's name, title, or first text value; each shown as the panel's `values` and `format` say. */
export function itemText(p: Panel, row: Row, now: Date): string {
  if (p.item) return fillWith(p.item, row, (path, v) => display(p, path, v, now, "text"));
  const field = ["name", "title"].find((f) => row[f] !== undefined && row[f] !== null)
    ?? Object.keys(row).find((k) => typeof row[k] === "string" && row[k] !== "");
  return field === undefined ? "" : display(p, field, row[field], now, "text");
}

interface Column {
  name: string;
  /** What a card dropped here gets as its group field. */
  value: unknown;
  rows: Row[];
}

/**
 * The board's columns: the schema's choices for the group field, in order, then other values as
 * they first appear, then "(none)" for rows without one (only when there are some).
 */
export function columnsOf(p: Panel, rows: Row[]): Column[] {
  const columns: Column[] = [];
  const byName = new Map<string, Column>();
  const column = (value: unknown): Column => {
    const name = String(value);
    let c = byName.get(name);
    if (!c) {
      c = { name, value, rows: [] };
      byName.set(name, c);
      columns.push(c);
    }
    return c;
  };
  const choices = p.schema?.[p.group!];
  if (Array.isArray(choices)) choices.forEach(column);
  const none: Row[] = [];
  for (const row of rows) {
    const v = getPath(row, p.group);
    if (v === undefined || v === null || v === "") none.push(row);
    else column(v).rows.push(row);
  }
  return none.length ? [...columns, { name: NONE, value: null, rows: none }] : columns;
}

/** What a column is called: the panel's `values` for its group value, else the value. */
function columnTitle(p: Panel, c: Column): string {
  return mapped(p, p.group, c.value) ?? c.name;
}

/** The card whose controls hold the focus, found again after the board is drawn afresh. */
function focusedKey(el: HTMLElement): string | undefined {
  return el.ownerDocument.activeElement?.closest?.(".gz-board-card")?.getAttribute("data-key") ?? undefined;
}

export const board: ViewDef = {
  id: "board",
  keys: [...DATA_KEYS, "group", "item", "label", "format", "values", "select", "detail"],
  span: 4,
  needsSource: true,
  // The board groups the raw rows itself, so cards keep what a write needs to find their note.
  pipeline: { group: undefined },
  validate: (p) => [...(p.group ? editErrors(p, [p.group]) : ["board needs group (the field its columns come from)"]), ...formatErrors(p)],
  examples: [
    { panel: { view: "board", source: "notes", from: "Projects", group: "status" } },
    { panel: { view: "board", source: "chores", group: "room", item: "{task}", select: "chore" } },
    { panel: { view: "board", source: "notes", from: "Projects", group: "status", item: "{name} · {due}", format: { due: "relative" }, values: { status: { doing: "In progress" } } } },
    { panel: { view: "board", source: "notes", from: "Projects", group: "status", format: "dollars" }, errors: ['format "dollars" isn\'t a number pattern or one of date, time, datetime, relative, until, duration, bytes'] },
    { panel: { view: "board", source: "notes", from: "Projects" }, errors: ["board needs group (the field its columns come from)"] },
    { panel: { view: "board", source: "https://api.example.com/tasks", group: "status" }, errors: ["edit works on notes and saved lists"] },
    { panel: { view: "board", source: "notes", from: "Projects", group: "tags" }, errors: ['edit: "tags" comes from the note\'s file, not its properties'] },
    { panel: { view: "board", source: "notes", from: "Projects", group: "status", per: "week" }, errors: ['"per" doesn\'t apply to board'] },
  ],
  mount(el, p, ctx): PanelHandle {
    // Cards are raw rows, so selecting tells them apart by note or place in the list, not by group.
    const own: Panel = { ...p, group: undefined };
    const draw = (rows: Row[]) => {
      const refocus = focusedKey(el);
      const scrolled = (el.querySelector(".gz-board") as HTMLElement | null)?.scrollLeft;
      el.empty();
      heading(el, p, p.label);
      const columns = columnsOf(p, rows);
      if (columns.length === 0) {
        el.createDiv({ cls: "gz-empty", text: "Nothing here yet." });
        return;
      }
      const root = el.createDiv({ cls: "gz-board" });
      let dragging: { row: Row; from: Column; card: HTMLElement } | undefined;
      /** The write is the panel's; the card is dimmed until it is done, and the data reload that follows redraws the board. */
      const move = async (card: HTMLElement, row: Row, to: Column) => {
        card.classList.add("gz-busy");
        try {
          await ctx.editRow(row, p.group!, to.value);
        } finally {
          card.classList.remove("gz-busy");
        }
      };
      const drawCard = (parent: HTMLElement, row: Row, column: Column) => {
        const text = itemText(p, row, ctx.now);
        const key = rowKey(row);
        const card = parent.createDiv({ cls: "gz-board-card", attr: { draggable: "true" } });
        if (key !== undefined) card.setAttribute("data-key", String(key));
        const title = card.createDiv({ cls: "gz-board-text" });
        const note = rowNote(p, row);
        if (note) noteLink(title, text, note, ctx);
        else title.setText(text);
        // Moved to two columns at once on two devices: the other column is offered.
        conflictChip(card, row, p.group!, (value) => ctx.editRow(row, p.group!, value));
        card.addEventListener("dragstart", (e) => {
          dragging = { row, from: column, card };
          card.classList.add("gz-dragging");
          // Firefox starts no drag without some data.
          (e as DragEvent).dataTransfer?.setData("text/plain", text);
        });
        card.addEventListener("dragend", () => {
          dragging = undefined;
          card.classList.remove("gz-dragging");
          for (const c of root.querySelectorAll(".gz-over")) c.classList.remove("gz-over");
        });
        // The keyboard and touch way to move a card.
        const others = columns.filter((c) => c !== column);
        const moveTo = card.createEl("select", { cls: "dropdown gz-move", attr: { "aria-label": `Move ${text}` } });
        moveTo.createEl("option", { text: "Move to…", value: "" });
        others.forEach((c, i) => moveTo.createEl("option", { text: columnTitle(p, c), value: String(i) }));
        moveTo.addEventListener("change", () => {
          const picked = moveTo.value;
          moveTo.options[0].selected = true;
          if (picked !== "") void move(card, row, others[Number(picked)]);
        });
        // A moved card comes back as a new row; a selection of it takes the new values.
        selectable(card, own, ctx, row, text)(row);
        if (key !== undefined && String(key) === refocus) moveTo.focus();
      };
      for (const column of columns) {
        const col = root.createDiv({ cls: "gz-board-col", attr: { role: "group", "aria-label": columnTitle(p, column) } });
        const head = col.createDiv({ cls: "gz-board-head" });
        head.createSpan({ cls: "gz-board-name", text: columnTitle(p, column) });
        head.createSpan({ cls: "gz-board-count", text: String(column.rows.length) });
        const cards = col.createDiv({ cls: "gz-board-cards" });
        if (column.rows.length === 0) cards.createDiv({ cls: "gz-empty", text: "Nothing here" });
        const accepts = () => dragging !== undefined && dragging.from !== column;
        col.addEventListener("dragover", (e) => {
          if (!accepts()) return;
          e.preventDefault();
          col.classList.add("gz-over");
        });
        col.addEventListener("dragleave", (e) => {
          if (!col.contains((e as DragEvent).relatedTarget as Node | null)) col.classList.remove("gz-over");
        });
        col.addEventListener("drop", (e) => {
          col.classList.remove("gz-over");
          if (!accepts()) return;
          e.preventDefault();
          const { card, row } = dragging!;
          dragging = undefined;
          void move(card, row, column);
        });
        for (const row of column.rows) drawCard(cards, row, column);
      }
      if (scrolled) root.scrollLeft = scrolled;
    };
    return { update: (data) => draw(rowsOf(data)) };
  },
};
