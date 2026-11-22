/**
 * The side sheet of an app in its own tab: a row, card, bar or day picked in the app opens here,
 * beside it, rather than as a detail under the rows. It shows what was picked (its name, its detail
 * sentence or value, and a record's fields, edited in place where its panel edits them), the panels
 * that read the pick, and the record's actions. A row of one of the app's own saved lists can also
 * be moved in time and deleted here. One per app; the controller moves the panels in and out, and
 * this draws the rest. It sits in the app's shell but is placed against the tab's content box, so it
 * stays where it is while the app scrolls under it.
 */
import { getPath, toNumber, type Row } from "./data.ts";
import { display, labelOf } from "./format.ts";
import { stableJson } from "./hash.ts";
import { SHEET_PAD, sheetWidth } from "./layout.ts";
import { rowIdOf } from "./ledger-store.ts";
import { ROW_INDEX } from "./sources/list.ts";
import type { Panel } from "./spec.ts";
import { rowsAreSaved } from "./sources/registry.ts";
import { minuteIn, stampOf, toTime, wallTime } from "./time.ts";
import { sayBelow } from "./views/addline.ts";
import { itemText } from "./views/board.ts";
import { busy, detailText, noteLink, rowNote, seriesNames } from "./views/common.ts";
import type { PanelCtx, SheetPick } from "./views/registry.ts";
import { fieldBox, listItem, rowAction, rowFields } from "./views/rows.ts";

/** Draws one of Obsidian's icons, by name, into an element: Obsidian's setIcon. */
export type DrawIcon = (el: HTMLElement, name: string) => void;

/** What the sheet shows: a pick, and the panel it was made in, by its key, with its keys and its own view of the app. */
export interface Opened {
  key: string;
  p: Panel;
  ctx: PanelCtx;
  pick: SheetPick;
}

interface Shown extends Opened {
  /** What the parts drawn once (fields, actions) were drawn from; a refresh with another shape draws them again. */
  shape: string;
  /** What shows the row's new values in each field. */
  fields: ((row: Row) => void)[];
  title: HTMLElement;
}

export class Sheet {
  readonly el: HTMLElement;
  /** Where the controller puts the panels that read the pick while the sheet is open. */
  readonly panels: HTMLElement;
  private kicker: HTMLElement;
  private body: HTMLElement;
  private shown: Shown | undefined;
  private closeAll: () => void;

  /** `close` is what the close button does, and deleting the row shown. */
  constructor(doc: Document, icon: DrawIcon, close: () => void) {
    this.closeAll = close;
    // Made in the app's own document (a pop-out has its own), and mounted later.
    this.el = doc.createDocumentFragment().createEl("aside", { cls: "gz-sheet", attr: { role: "dialog", "aria-modal": "false", tabindex: "-1" } });
    const top = this.el.createDiv({ cls: "gz-sheet-top" });
    this.kicker = top.createSpan({ cls: "gz-sheet-kicker" });
    const button = top.createEl("button", { cls: "gz-sheet-close clickable-icon", attr: { type: "button", "aria-label": "Close", title: "Close (Esc)" } });
    icon(button, "x");
    button.addEventListener("click", close);
    this.body = this.el.createDiv({ cls: "gz-sheet-body" });
    this.panels = this.body.createDiv({ cls: "gz-sheet-panels" });
    this.hide();
  }

  /** The panel whose pick the sheet shows, by its key; undefined while it is closed. */
  get from(): string | undefined {
    return this.shown?.key;
  }

  get opened(): Opened | undefined {
    return this.shown;
  }

  /** Whether a panel's element is in the sheet. */
  holds(el: Element): boolean {
    return el.parentElement === this.panels;
  }

  /** The drawing width of a panel in the sheet: measured while it is laid out, else worked out from the app's width. */
  innerWidth(appWidth: number): number {
    const measured = this.body.clientWidth;
    return measured > 0 ? measured - SHEET_PAD : sheetWidth(appWidth);
  }

  /** Puts the sheet last in the app's shell, or takes it out (on the grid). */
  place(shell: HTMLElement | undefined): void {
    if (!shell) this.el.remove();
    else if (shell.lastElementChild !== this.el) shell.appendChild(this.el);
  }

  /** Shows a pick, in place of whatever it showed, and moves the focus into the sheet. */
  open(o: Opened): void {
    this.draw(o);
    this.el.addClass("is-open");
    this.el.removeAttribute("inert");
    this.el.removeAttribute("aria-hidden");
    this.keepUnderHeader();
    this.el.focus({ preventScroll: true });
  }

  /**
   * Shows the same panel's pick again as the panel shows it now, in place: a field being typed in
   * keeps its focus and what was typed.
   */
  refresh(o: Opened): void {
    const s = this.shown;
    if (!s) return;
    if (shapeOf(o) !== s.shape) return this.draw(o);
    Object.assign(s, { p: o.p, ctx: o.ctx, pick: o.pick });
    for (const show of s.fields) show(o.pick.row);
    this.fill();
  }

  /** Slides the sheet away, keeping what it shows while it goes; returns what it showed, or undefined when it was closed. */
  close(): Opened | undefined {
    const s = this.shown;
    this.shown = undefined;
    if (s) this.hide();
    return s;
  }

  /** Closes the sheet and empties it, as the panels it holds are taken down. */
  reset(): void {
    this.shown = undefined;
    this.hide();
    this.kicker.empty();
    this.panels.empty();
    for (const el of [...this.body.children]) if (el !== this.panels) el.remove();
  }

  /** The tab's header sits above the app's box in the tab's content box, which the sheet is placed against. */
  keepUnderHeader(): void {
    const host = this.el.offsetParent;
    const content = this.el.parentElement?.parentElement;
    if (!host || !content) return;
    const top = content.getBoundingClientRect().top - host.getBoundingClientRect().top;
    this.el.style.setProperty("--gz-sheet-top", `${Math.max(0, Math.round(top))}px`);
  }

  private hide(): void {
    this.el.removeClass("is-open");
    this.el.setAttribute("inert", "");
    this.el.setAttribute("aria-hidden", "true");
  }

  /** Draws everything but the panels: the kicker, title and line, a record's fields, and its actions. */
  private draw(o: Opened): void {
    const { p, ctx, pick } = o;
    for (const el of [...this.body.children]) if (el !== this.panels) el.remove();
    const before = <T extends HTMLElement>(el: T) => this.body.insertBefore(el, this.panels);
    const kicker = p.title ?? p.view.charAt(0).toUpperCase() + p.view.slice(1);
    this.kicker.setText(kicker);
    this.el.setAttribute("aria-label", kicker);
    const title = before(this.body.createEl("h2", { cls: "gz-sheet-title" }));
    const fields: ((row: Row) => void)[] = [];
    const own = ownRow(o);
    const shown = shownFields(o);
    if (shown.length) {
      const box = before(this.body.createDiv({ cls: "gz-sheet-fields" }));
      for (const [field, type] of shown) {
        const line = box.createDiv({ cls: "gz-sheet-field" });
        const label = labelOf(p, field);
        line.createSpan({ cls: "gz-sheet-label", text: label });
        const value = line.createDiv({ cls: "gz-sheet-value" });
        // Its own list's row moves in time here, unless its panel edits that field its own way.
        const moves = own && field === "at" && type === undefined && wallTime(pick.row.at) !== undefined;
        fields.push(moves ? whenBox(value, ctx, pick.row, label) : fieldBox(value, p, ctx, pick.row, field, type));
      }
    }
    const note = rowNote(p, pick.row);
    const deletes = own && ctx.deleteRow !== undefined;
    // Someone else's row in a shared kind: whose it is, and Not mine to set it aside here.
    const theirs = theirsOf(o);
    if (theirs) this.body.createEl("p", { cls: "gz-sheet-theirs gz-muted", text: `${theirs}.` });
    const asides = theirs !== undefined && ctx.setAside !== undefined && !ctx.readOnly && pick.row.line !== "dismissed";
    if (p.action || note || deletes || asides) {
      const actions = this.body.createDiv({ cls: "gz-sheet-actions" });
      rowAction(actions, p, ctx, () => this.shown?.pick.row ?? pick.row);
      if (note) noteLink(actions, "Open", note, ctx);
      if (deletes) this.deleteButton(actions);
      if (asides) this.asideButton(actions);
    }
    this.shown = { ...o, shape: shapeOf(o), fields, title };
    this.fill();
  }

  /**
   * Delete: takes the row shown out of its list, closes the sheet, and says so under the panel it was
   * picked in, with Undo, as a line says what it saved.
   */
  private deleteButton(parent: HTMLElement): void {
    const b = parent.createEl("button", { cls: "gz-small gz-row-action mod-warning", text: "Delete", attr: { type: "button" } });
    busy(b, async () => {
      const s = this.shown;
      if (!s?.ctx.deleteRow) return;
      const { p, ctx, pick } = s;
      // Named while it is still there, and said under its panel, which stays when the row's element goes.
      const text = `Deleted ${deletedName(p, pick.row, ctx.now)}`;
      const panel = pick.el.closest<HTMLElement>(".gz-panel");
      const done = await s.ctx.deleteRow(pick.row);
      if (!done) return;
      this.closeAll();
      if (panel?.isConnected) sayBelow(panel, ctx, text, done.entry);
    });
  }

  /** Not mine: sets the row shown aside, closes the sheet, and says so under the panel it was picked in, with Undo. */
  private asideButton(parent: HTMLElement): void {
    const b = parent.createEl("button", { cls: "gz-small gz-row-action", text: "Not mine", attr: { type: "button" } });
    busy(b, async () => {
      const s = this.shown;
      if (!s?.ctx.setAside) return;
      const { p, ctx, pick } = s;
      const text = `Set aside ${deletedName(p, pick.row, ctx.now)}`;
      const panel = pick.el.closest<HTMLElement>(".gz-panel");
      const done = await s.ctx.setAside(pick.row);
      if (!done) return;
      this.closeAll();
      if (panel?.isConnected) sayBelow(panel, ctx, text, done.entry);
    });
  }

  /** Writes the title, and the line under it when there is something to say. */
  private fill(): void {
    const s = this.shown!;
    const now = s.ctx.now;
    const names = s.pick.record ? rowFields(s.p, s.pick.row).map(([f]) => f) : [];
    s.title.setText(titleOf(s.p, s.pick, names, now));
    const text = lineOf(s.p, s.pick, now);
    let line = s.title.nextElementSibling?.classList.contains("gz-sheet-line") ? s.title.nextElementSibling as HTMLElement : undefined;
    if (!text) return line?.remove();
    if (!line) {
      line = s.title.parentElement!.createDiv({ cls: "gz-sheet-line" });
      s.title.after(line);
    }
    line.setText(text);
  }
}

/**
 * What a sheet's fields and actions are drawn from: the panel's keys, the fields shown and how each
 * is edited, the note it opens, and whether the row is its own list's.
 */
function shapeOf(o: Opened): string {
  return stableJson([o.p, shownFields(o), rowNote(o.p, o.pick.row) ?? null, ownRow(o), theirsOf(o) ?? null, o.pick.row.line ?? null]);
}

/** A record of one of the app's own saved lists, shown as it is now: one the sheet can move in time and delete. */
function ownRow(o: Opened): boolean {
  const { p, ctx, pick } = o;
  if (!pick.record || ctx.readOnly || !rowsAreSaved(p.source) || ctx.rowsWritable?.() === false || theirsOf(o)) return false;
  return rowIdOf(pick.row) !== undefined || typeof (pick.row as Record<symbol, unknown>)[ROW_INDEX] === "number";
}

/** Why the record shown isn't this vault's to change: someone else wrote it, in a shared kind. */
function theirsOf(o: Opened): string | undefined {
  return o.pick.record ? o.ctx.theirs?.(o.pick.row) : undefined;
}

/** A record's fields, as its panel shows them, with when its own list's row happened where the panel leaves that out. */
function shownFields(o: Opened): [field: string, type?: string | string[]][] {
  if (!o.pick.record) return [];
  const fields = rowFields(o.p, o.pick.row);
  if (ownRow(o) && !fields.some(([f]) => f === "at") && wallTime(o.pick.row.at) !== undefined) fields.push(["at"]);
  return fields;
}

/**
 * When a row of the app's own list happened, as a date and time to move it to: stamped with this
 * device's offset and written through the panel's edits, so the move is kept and can be undone. A
 * time still to come is put back, and refused there with why.
 */
function whenBox(box: HTMLElement, ctx: PanelCtx, row: Row, label: string): (row: Row) => void {
  let current = row;
  const shownAt = (r: Row) => {
    const t = wallTime(r.at);
    return t === undefined ? "" : minuteIn(t);
  };
  const input = box.createEl("input", { cls: "gz-edit", type: "datetime-local", attr: { "aria-label": label } });
  input.addEventListener("change", () => {
    const was = shownAt(current);
    const t = toTime(input.value);
    if (t === undefined || input.value === was) {
      input.value = was;
      return;
    }
    if (t > ctx.now.getTime()) input.value = was;
    void (async () => {
      const focused = input.ownerDocument.activeElement === input;
      input.disabled = true;
      try {
        await ctx.editRow(current, "at", stampOf(new Date(t)));
      } finally {
        input.disabled = false;
        if (focused) input.focus();
      }
    })();
  });
  const show = (r: Row) => {
    current = r;
    input.setAttr("max", minuteIn(ctx.now.getTime()));
    if (input.ownerDocument.activeElement !== input) input.value = shownAt(r);
  };
  show(row);
  return show;
}

/**
 * A row as the notice that it was deleted names it: as its list's item or its card says it, else
 * its first few values as the sheet shows them, and its time only when it has nothing else.
 */
function deletedName(p: Panel, row: Row, now: Date): string {
  if (p.item !== undefined && p.view === "list") return listItem(p, row, now);
  if (p.item !== undefined && p.view === "board") return itemText(p, row, now);
  const values = (fields: string[]) => fields.flatMap((f) => {
    const v = getPath(row, f);
    return v === undefined || v === null || v === "" ? [] : [display(p, f, v, now, "text")];
  });
  const words = values(rowFields(p, row).map(([f]) => f).filter((f) => f !== "at")).slice(0, 3);
  return (words.length ? words : values(["at"])).join(" · ") || "a row";
}

/**
 * What a picked thing is called: a record as its panel names the row (a table's by its first field
 * of free text), a day or a bar by its date or category, anything else by the label its view gave it.
 */
function titleOf(p: Panel, pick: SheetPick, fields: string[], now: Date): string {
  const { row } = pick;
  if (pick.record) {
    if (p.view === "list") return listItem(p, row, now);
    // A board card is named by its text before the first " · ", as the card shows it.
    if (p.view === "board") return itemText(p, row, now).split(" · ")[0];
    // A timeline's label carries the dates too, which its fields show.
    if (p.view === "timeline") return itemText(p, row, now);
    return pick.label ?? firstText(p, row, fields, now);
  }
  if (p.view === "scatter" && pick.label) return pick.label;
  return xText(p, row, now) ?? pick.label ?? "";
}

/** The first field of free text (not a date, nor one of a field's choices), else the first field, as the panel shows it. */
function firstText(p: Panel, row: Row, fields: string[], now: Date): string {
  const text = fields.find((f) => {
    const v = getPath(row, f);
    return typeof v === "string" && v.trim() !== "" && toTime(v) === undefined && !Array.isArray(p.schema?.[f]);
  });
  const field = text ?? fields[0];
  return field === undefined ? "" : display(p, field, getPath(row, field), now, "text");
}

/** A day, bar or slice by what it stands for: its date, or its category as the panel shows it. */
function xText(p: Panel, row: Row, now: Date): string | undefined {
  const x = p.group ?? p.x;
  if (x === undefined) return undefined;
  const v = getPath(row, x);
  const t = typeof v === "string" ? wallTime(v) : undefined;
  return t === undefined ? display(p, x, v, now, "text") : periodText(t, p.view === "calendar" ? "day" : p.per, now);
}

/** A day as "Friday, Nov 20", a week as "Week of Nov 16", a month as "November 2026"; another year's day or week says its year. */
function periodText(t: number, per: string | undefined, now: Date): string {
  const d = new Date(t);
  const year = d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const };
  if (per === "year") return String(d.getFullYear());
  if (per === "month") return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (per === "week") return `Week of ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...year })}`;
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", ...year });
}

/** What the sheet says under the title: the panel's detail filled in, else for a day, bar, slice or dot its value as the panel shows it. */
function lineOf(p: Panel, pick: SheetPick, now: Date): string {
  if (p.detail !== undefined) return detailText(p, pick.row, now);
  if (pick.record) return "";
  const row = pick.row;
  const ys = seriesNames(p);
  const shown = (f: string) => {
    const v = getPath(row, f);
    return v === undefined || v === null ? undefined : `${display(p, f, v, now)}${p.unit ? ` ${p.unit}` : ""}`;
  };
  const named = (fields: string[]) => fields.flatMap((f) => {
    const s = shown(f);
    return s === undefined ? [] : [fields.length > 1 ? `${labelOf(p, f)} ${s}` : s];
  }).join(" · ");
  if (p.view === "scatter" && p.x) return named([p.x, ...ys]);
  if (ys.length) return named(ys);
  const n = toNumber(row.count);
  if (n === undefined) return "";
  return `${display(p, "count", n, now)} ${p.view === "calendar" && p.label ? p.label : n === 1 ? "entry" : "entries"}`;
}
