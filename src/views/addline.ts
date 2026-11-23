import { textOf } from "../text.ts";
import { handler } from "../handler.ts";
import { parseFields, whenText, type FieldValues } from "../capture.ts";
import type { Row } from "../data.ts";
import { display, formatFor, labelOf } from "../format.ts";
import { isPlainObject, startOf } from "../keys.ts";
import type { Panel } from "../spec.ts";
import { basename, notePath, storeTarget } from "../store.ts";
import { stampParts } from "../time.ts";
import { svg } from "./chart.ts";
import type { PanelCtx, PanelHandle, RunResult } from "./registry.ts";

/**
 * The composed layout's line to add things (rules 2 and 7): a form becomes one typed line that
 * reads the capture grammar and shows what it will save before Enter, a button becomes one big
 * button, and what either did is said under it with Undo, in place of a notice.
 */

/** How long what was saved is said, and then how long what Undo did is. */
const SAID_MS = 6000;
const UNDONE_MS = 3000;
/** Whether Undo is ⌘Z where `el` is shown: Obsidian marks its body `mod-macos` on a Mac and on iOS. */
const mac = (el: Element) => el.ownerDocument.body.classList.contains("mod-macos");
/** A choice with more options than this is shown as its value, not as a row of chips. */
const MAX_CHIPS = 6;

type Field = [string, string | string[]];

const fieldsOf = (p: Panel): Field[] => Object.entries(p.fields ?? p.schema ?? {});
const isText = (type: string | string[]) => type === "text" || type === "textarea";

/** Whether a form reads as one typed line: at most five fields, none of them a text box or a tick box. */
export function fitsOneLine(p: Panel): boolean {
  const types = fieldsOf(p).map(([, type]) => type);
  return types.length <= 5 && !types.some((t) => t === "textarea" || t === "checkbox");
}

/** The word the line starts with: the panel's alias, else its shortcut, else its title. */
function verbOf(p: Panel): string {
  return (p.alias ?? p.shortcut ?? p.title ?? "add").toLowerCase();
}

/** Where a panel's actions put what it saves, as what it said names it. */
function whereOf(p: Panel): string | undefined {
  if (p.target?.kind === "list") return p.target.name;
  if (p.target?.kind === "folder") return p.target.folder.split("/").pop();
  return p.append === undefined ? undefined : basename(notePath(storeTarget(p.append)));
}

const ICONS = {
  check: ["M20 6 9 17l-5-5"],
  enter: ["M9 10l-5 5 5 5", "M20 4v7a4 4 0 0 1-4 4H4"],
};

function icon(parent: Element, name: keyof typeof ICONS, size: number): void {
  const s = svg("svg", {
    class: "gz-icon", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  }, parent);
  for (const d of ICONS[name]) svg("path", { d }, s);
}

// ---- Said in place, with Undo -------------------------------------------------------------------

/** The latest thing said with Undo in any app: the one ⌘Z undoes. */
const latest: { said?: Said } = {};
/** What each app is saying, by the app's element: one notice at a time there, so one Undo and one ⌘Z. */
const sayingIn = new WeakMap<Element, Said>();

/**
 * What a panel's last run did, said under it for six seconds with Undo when the run kept an entry
 * in the activity log; after Undo, what that did, for three. `changed` draws the panel's under-line
 * again whenever it comes or goes.
 */
export class Said {
  private text: string | undefined;
  private entry: string | undefined;
  private timer: number | undefined;
  private shown: HTMLElement | undefined;
  private ctx: PanelCtx;
  readonly changed: () => void;

  constructor(ctx: PanelCtx, changed: () => void) {
    this.ctx = ctx;
    this.changed = changed;
  }

  get showing(): boolean {
    return this.text !== undefined;
  }

  /** Whether Undo is on screen now, so ⌘Z may take it. */
  get undoable(): boolean {
    return this.entry !== undefined && latest.said === this && !!this.shown?.isConnected && !this.shown.closest(".gz-off");
  }

  /**
   * Says `text`; `entry`, the activity log's, gives it Undo where the app can undo. What the app was
   * saying elsewhere goes, as when its time is up.
   */
  say(text: string, entry: string | undefined): void {
    this.text = text;
    this.entry = this.ctx.undo ? entry : undefined;
    latest.said = this;
    this.hideIn(SAID_MS);
    this.changed();
    const app = this.shown?.closest(".gizmo");
    if (!app) return;
    const before = sayingIn.get(app);
    sayingIn.set(app, this);
    if (before !== undefined && before !== this && before.showing) before.end();
  }

  async undo(): Promise<void> {
    const entry = this.entry;
    if (entry === undefined || !this.ctx.undo) return;
    this.entry = undefined;
    this.changed();
    let text: string;
    try {
      text = await this.ctx.undo(entry);
    } catch (e) {
      text = `Couldn't undo it: ${(e as Error).message}`;
    }
    this.text = text;
    this.hideIn(UNDONE_MS);
    this.changed();
  }

  draw(into: HTMLElement): void {
    this.shown = undefined;
    if (this.text === undefined) return;
    const box = into.createDiv({ cls: "gz-notice", attr: { role: "status" } });
    icon(box, "check", 15);
    box.createSpan({ cls: "gz-notice-text", text: this.text });
    if (this.entry !== undefined) {
      box.createEl("button", { cls: "gz-undo", type: "button", text: "Undo" }).addEventListener("click", () => void this.undo());
      box.createEl("kbd", { text: mac(box) ? "⌘Z" : "Ctrl Z" });
    }
    this.shown = box;
  }

  clear(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.text = this.entry = undefined;
    if (latest.said === this) latest.said = undefined;
  }

  /** Stops saying it, as when its time is up. */
  private end(): void {
    this.clear();
    this.changed();
  }

  private hideIn(ms: number): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.end(), ms);
  }
}

/** What says, under a panel, what was done to its rows from outside it, and where; by the panel's element. */
const below = new WeakMap<HTMLElement, { said: Said; under: HTMLElement }>();

/**
 * Says what was done to a row of a panel from outside the panel (the side sheet's Delete) just
 * under it, as a line says what it saved: for six seconds, with Undo and ⌘Z, then gone. Under a
 * long panel that is below the pane's edge, so the pane scrolls just enough to show it.
 */
export function sayBelow(panel: HTMLElement, ctx: PanelCtx, text: string, entry: string | undefined): void {
  let shown = below.get(panel);
  if (!shown) {
    // Made from the panel to be in its document (a pop-out has its own), and placed when there is something to say.
    const under = panel.createDiv({ cls: "gz-addline-under" });
    under.remove();
    let unlisten: (() => void) | undefined;
    const s: Said = new Said(ctx, () => {
      under.empty();
      if (!s.showing) {
        under.remove();
        unlisten?.();
        unlisten = undefined;
        return;
      }
      if (under.previousElementSibling !== panel) panel.after(under);
      unlisten ??= listen(under, s);
      s.draw(under);
    });
    shown = { said: s, under };
    below.set(panel, shown);
  }
  shown.said.say(text, entry);
  shown.under.scrollIntoView({ block: "nearest" });
}

/** Whether a run went through, or wrote part of what it does, so the line can let go of what was typed. */
const wentThrough = (r: RunResult | void) => !r || r.failed !== undefined || (r.error === undefined && r.ok !== false);

/**
 * What to say after a run: what it wrote and what it then couldn't do, when it stopped part way;
 * the panel's `notify` as filled; else what it saved and where, if it saves anything.
 */
function sayAfter(said: Said, p: Panel, r: RunResult | void, saved: () => string, whatIf: boolean): void {
  if (r?.failed !== undefined) return said.say(r.failed, r.entry);
  // Shown ahead, what was saved is a what-if, which a panel's own notify can't know to say.
  const real = (text: string) => (whatIf ? `${text}; nothing real changed` : text);
  if (r?.told !== undefined) return said.say(real(whatIf ? `What if: ${r.told}` : r.told), r.entry);
  if (p.target || p.append !== undefined) said.say(real(saved()), r?.entry);
}

// ---- Keys ---------------------------------------------------------------------------------------

function editing(el: Element | null): boolean {
  return !!el && (el.matches("input, textarea, select") || !!el.closest('[contenteditable]:not([contenteditable="false"])'));
}

/** Only an app open in its own tab, the active one, reacts to keys; not one in an embed, a lens or a base. */
function inActiveApp(el: HTMLElement): boolean {
  return el.isConnected && !el.closest(".gz-embed, .gz-lens, .gz-bases, .gz-off") && !!el.closest(".workspace-leaf.mod-active");
}

/** The first add line in the part of the app on screen: the one outside any tab, else the open tab's. */
function firstLine(el: HTMLElement): HTMLInputElement | undefined {
  const lines = el.closest(".gizmo")?.querySelectorAll<HTMLInputElement>("input.gz-addline-input") ?? [];
  return [...lines].find((i) => !i.closest(".gz-off"));
}

/**
 * `/` focuses the first add line on screen, and ⌘Z (Ctrl Z) takes the latest Undo, while nothing
 * editable has focus; `input` is this panel's line, if it has one. Returns how to stop listening.
 */
function listen(el: HTMLElement, said: Said, input?: HTMLInputElement): () => void {
  const doc = el.ownerDocument;
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || editing(doc.activeElement) || !inActiveApp(el)) return;
    if (input && e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (firstLine(el) !== input) return;
      e.preventDefault();
      input.focus();
    } else if (e.key.toLowerCase() === "z" && (mac(el) ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && said.undoable) {
      e.preventDefault();
      void said.undo();
    }
  };
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
}

// ---- What a line says, and saves ----------------------------------------------------------------

/** One field's value as the line stands: typed, picked from its chips, guessed, its default, or none. */
interface Value {
  value?: string;
  how: "typed" | "picked" | "guessed" | "default" | "missing";
  /** For a guess, the word it was guessed from. */
  from?: string;
}

/** A field's default, as the form shows it: its own `default`, today for a date, the first choice. */
function defaultOf(p: Panel, [name, type]: Field, now: Date): string | undefined {
  const start = startOf(p.fieldInfo?.[name], now) ?? (type === "date" ? stampParts(now).date : undefined);
  if (Array.isArray(type)) return textOf(type.find((o) => textOf(o) === textOf(start)) ?? type[0]);
  return start === undefined || start === null ? undefined : textOf(start);
}

const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 3);

/**
 * A choice not typed, guessed from the list's rows, newest first: the choice of the latest row whose
 * text shares a word of 3 letters or more with the text typed. Only ever one of the field's choices.
 */
function guess(rows: readonly Row[], fields: Field[], [name, type]: Field, params: Record<string, string>): Value | undefined {
  if (!Array.isArray(type)) return undefined;
  const texts = fields.filter(([, t]) => isText(t)).map(([n]) => n);
  const typed = texts.flatMap((n) => (params[n] ? wordsOf(params[n]) : []));
  if (!typed.length) return undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const choice = type.find((o) => String(o) === String(rows[i][name]));
    if (choice === undefined) continue;
    const theirs = new Set(texts.flatMap((n) => (typeof rows[i][n] === "string" ? wordsOf(rows[i][n] as string) : [])));
    const word = typed.find((w) => theirs.has(w));
    if (word) return { value: String(choice), how: "guessed", from: word };
  }
  return undefined;
}

/** A value as the classic form saves it: numbers as numbers, a choice as typed in the list. */
function typed(type: string | string[], v: string | undefined): unknown {
  if (type === "checkbox") return v === "true";
  if (type === "number") return v === undefined || v === "" ? null : Number(v);
  if (Array.isArray(type)) return type.find((o) => String(o) === v) ?? v ?? "";
  return v ?? "";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as a person says it: Today, Yesterday, else Fri Nov 20 (with its year when not this one). */
function dayText(value: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = stampParts(now).date;
  if (value === today) return "Today";
  if (value === stampParts(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)).date) return "Yesterday";
  const year = d.getFullYear() === now.getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

function shown(p: Panel, [name, type]: Field, value: string, now: Date): string {
  if (type === "number") return display(p, name, Number(value), now);
  if (type === "date") return dayText(value, now);
  return value;
}

/**
 * What a form saved, as it is said: its first field's value, where it went, and when for, if not
 * now; for a kind, planned for a time still to come, or each time of an `@every`; in a what-if, a
 * what-if row.
 */
function addedText(p: Panel, value: unknown, now: Date, at?: Date, plan?: Date[], whatIf = false): string {
  const field = fieldsOf(p)[0];
  const v = value === undefined || value === null ? "" : textOf(value);
  const what = !field || v === "" ? "" : isText(field[1]) ? ` “${v}”` : ` ${shown(p, field, v, now)}`;
  const where = whereOf(p) ?? verbOf(p);
  if (whatIf) {
    const times = plan && plan.length > 1 ? ` ${plan.length} times, to ${whenText(plan[plan.length - 1], now)}` : at ? ` for ${whenText(at, now)}` : "";
    return `Added${what} to ${where} as a what-if${times}`;
  }
  if (plan && plan.length > 1) return `Planned${what} in ${where} ${plan.length} times, to ${whenText(plan[plan.length - 1], now)}`;
  if (at && at.getTime() > now.getTime()) return `Planned${what} in ${where} for ${whenText(at, now)}`;
  return `Added${what} to ${where}${at ? ` for ${whenText(at, now)}` : ""}`;
}

// ---- Examples -----------------------------------------------------------------------------------

const MONEY = /\b(spent|spend|amount|cost|price|paid|total)\b/;

/** Three plausible numbers for a field, from its format or what it is called. */
function numbersFor(p: Panel, name: string): string[] {
  const format = formatFor(p, name) ?? "";
  const called = `${name} ${labelOf(p, name)}`.toLowerCase();
  if (/0\.00/.test(format) || (MONEY.test(called) && !/[$€£¥]/.test(format))) return ["12.50", "9.80", "42"];
  if (/[$€£¥]/.test(format)) return ["1200", "980", "4500"];
  if (/weight|kg|lb/.test(called)) return ["81.2", "80.8", "81.0"];
  if (/sleep|slept|hour/.test(called)) return ["7.5", "8", "6.5"];
  if (/shares|quantity|qty/.test(called)) return ["5", "10", "2"];
  return ["12", "3", "20"];
}

const WORDS: [RegExp, string[]][] = [
  [/symbol|ticker/, ["VTI", "QQQ", "AAPL"]],
  [/upkeep|repair/, ["Replace the furnace filter", "Test the smoke alarms", "Car service"]],
  [/chore/, ["Vacuum the house", "Take the bins out", "Do the laundry"]],
  [/renew|deadline/, ["Renew passport", "Car registration", "Home insurance"]],
  [/bill|subscription/, ["BRIGHT MOBILE", "STREAMFLIX", "CITY POWER"]],
  [/task|todo/, ["Call the bank", "Renew passport", "Buy milk"]],
  [/decision|decide/, ["Take the new job", "Move in March", "Sell the car"]],
  [/project|name|title/, ["Paint the shed", "Garden beds", "Photo book"]],
  [/item|thing/, ["Coffee", "Train ticket", "Ramen"]],
];

/**
 * Three short texts for a field, from what it is called, else what its form is called (a field
 * named `what` says nothing); `money`: the form saves an amount spent.
 */
function wordsFor(p: Panel, name: string, money: boolean): string[] {
  const called = `${name} ${labelOf(p, name)}`.toLowerCase();
  const title = (p.title ?? "").toLowerCase();
  // In a title, only a word that starts there counts: "Spent something" is not about a thing.
  const found = WORDS.find(([re]) => re.test(called))?.[1] ?? WORDS.find(([re]) => new RegExp(`\\b(?:${re.source})`).test(title))?.[1];
  return found ?? (money ? ["lunch", "coffee", "groceries"] : ["morning", "felt good", "with Sam"]);
}

/** A form that plans rows: it saves to a kind, and its label or title says it plans (`Plan bill`). */
const plans = (p: Panel) => p.target?.kind === "list" && p.target.at !== undefined && /\bplan/i.test(`${p.label ?? ""} ${p.title ?? ""}`);

/** A date field named for a day still to come: a deadline, a due date, an expiry. */
const DEADLINE = /\b(due|deadline|expir\w*|renew\w*|until)\b/;

/** A day `days` from now, as a line takes it. */
const ahead = (now: Date, days: number) => stampParts(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)).date;

/**
 * An example line from a form's fields: `k` 0 is the placeholder, with every number and choice;
 * 1 and 2 are the hint's, the first taking yesterday for a date and, beside a number, leaving the
 * choices to their defaults. A number after the words is left out once a number came before them:
 * a second one there reads as part of the words. A date named like a deadline is one still to
 * come; a form that plans rows ends each line with a day still to come, for when, and leaves its
 * choices out, as a bill or a renewal reads.
 */
function example(p: Panel, fields: Field[], k: number, now: Date): string {
  const parts: string[] = [];
  const planning = plans(p);
  const money = fields.some(([n, t]) => t === "number" && numbersFor(p, n)[0] === "12.50");
  const first = (fits: (t: string | string[]) => boolean) => fields.find(([, t]) => fits(t))?.[0];
  // Only the first text field: the words left over go to it.
  const text = first(isText);
  const date = first((t) => t === "date");
  const bare = planning || (k === 1 && first((t) => t === "number") !== undefined);
  let numbered = false;
  let worded = false;
  for (const [name, type] of fields) {
    if (Array.isArray(type)) {
      if (bare) continue;
      const o = String(type[Math.min(k, 1) % type.length]);
      parts.push(/\s/.test(o) ? `"${o}"` : o);
    } else if (type === "number") {
      if (numbered && worded) continue;
      numbered = true;
      const ofMoney = numbersFor(p, name)[0] === "12.50";
      parts.push(planning && ofMoney ? ["45", "15.49", "65"][k] : numbersFor(p, name)[k]);
    } else if (name === date && DEADLINE.test(`${name} ${labelOf(p, name)}`.toLowerCase())) {
      if (planning || k === 1) parts.push(ahead(now, [120, 90, 150][k]));
    } else if (name === date && k === 1) parts.push("yday");
    else if (name === text) {
      worded = true;
      parts.push(wordsFor(p, name, money)[k]);
    }
  }
  if (planning) parts.push(`@${ahead(now, [20, 35, 50][k])}`);
  return parts.join(" ");
}

// ---- The add line -------------------------------------------------------------------------------

/**
 * A form as one typed line: the verb, the line, `/` while it's empty, and its button; under it, an
 * example to try, then what the line will save as it's typed, then what was saved, with Undo.
 * `other` switches the panel to its fields. Rows given to `update` are the list it saves to, which
 * a choice not typed may be guessed from.
 */
export function addLine(el: HTMLElement, p: Panel, ctx: PanelCtx, other?: () => void): PanelHandle {
  const fields = fieldsOf(p);
  const verb = verbOf(p);
  // A line that saves to a kind plans a row for a time still to come; in a what-if, any line takes one.
  const ahead = ctx.whatIf !== undefined || (p.target?.kind === "list" && p.target.at !== undefined);
  // In a what-if, times typed are read from now, not from the time the app is shown at.
  const clock = () => ctx.whatIf ?? ctx.now;
  let rows: Row[] = [];
  const picks = new Map<string, string>();
  let refused: string | undefined;
  let saving = false;

  hiddenTitle(el, p);
  el.removeClass("gz-form-fields");
  el.addClass("gz-form-line");
  const f = el.createEl("form", { cls: "gz-addline" });
  f.createSpan({ cls: "gz-addline-verb", text: verb });
  const input = f.createEl("input", {
    cls: "gz-addline-input", type: "text",
    attr: { "aria-label": p.title ?? p.label ?? verb, placeholder: example(p, fields, 0, clock()), autocomplete: "off", spellcheck: "false", enterkeyhint: "done" },
  });
  const key = f.createEl("kbd", { cls: "gz-addline-key", text: "/", attr: { "aria-hidden": "true" } });
  const label = p.label ?? "Add";
  // A long label gives way to its icon on a narrow screen, where the line needs the room.
  const go = f.createEl("button", { cls: label.length > 8 ? "gz-addline-go mod-cta is-long" : "gz-addline-go mod-cta", type: "submit", attr: { "aria-label": label } });
  go.createSpan({ cls: "gz-addline-go-label", text: label });
  icon(go, "enter", 14);
  const under = el.createDiv({ cls: "gz-addline-under" });
  const more = other && createMore(el, "Use the form", other);
  const said = new Said(ctx, () => render());
  const unlisten = listen(el, said, input);

  const read = () => {
    const now = clock();
    const r: FieldValues = parseFields(input.value, fields, now, { name: verb, loose: true, ahead });
    const values = new Map<string, Value>(fields.map((field) => {
      const [name] = field;
      const picked = picks.get(name);
      if (picked !== undefined) return [name, { value: picked, how: "picked" }];
      if (Object.hasOwn(r.params, name)) return [name, { value: r.params[name], how: "typed" }];
      const guessed = guess(rows, fields, field, r.params);
      if (guessed) return [name, guessed];
      // For a row logged for another day, a default of today means that day.
      const d = defaultOf(p, field, r.at ?? now);
      return [name, d === undefined || d === "" ? { how: "missing" } : { value: d, how: "default" }];
    }));
    const first = fields.length ? values.get(fields[0][0])?.value : "";
    const savable = !saving && input.value.trim() !== "" && !r.errors.length && first !== undefined && first !== "";
    return { r, values, savable };
  };

  const clearLine = () => {
    input.value = "";
    picks.clear();
    refused = undefined;
  };

  const drawPreview = (state: ReturnType<typeof read>) => {
    for (const field of fields) {
      const [name, type] = field;
      const v = state.values.get(name)!;
      const pv = under.createSpan({ cls: "gz-pv" });
      if (v.how === "default" || v.how === "missing") pv.addClass(`is-${v.how}`);
      pv.createSpan({ cls: "gz-pv-label", text: labelOf(p, name) });
      if (Array.isArray(type) && type.length <= MAX_CHIPS) {
        pv.addClass("gz-pv-chips");
        const chips = pv.createSpan({ cls: "gz-chips" });
        for (const option of type.map(String)) {
          const chip = chips.createEl("button", { cls: "gz-chip", type: "button", text: option });
          if (option === v.value) chip.addClass(v.how === "default" ? "is-default" : "is-on");
          chip.addEventListener("click", () => {
            picks.set(name, option);
            render();
            input.focus();
          });
        }
        if (v.how === "guessed") pv.createSpan({ cls: "gz-pv-guess", text: `guessed from “${v.from}”` });
      } else {
        pv.createSpan({ cls: "gz-pv-value", text: v.value === undefined ? "—" : shown(p, field, v.value, clock()) });
      }
    }
    if (state.r.at) {
      const { at, plan } = state.r;
      const now = clock();
      const planned = plan !== undefined || at.getTime() > now.getTime();
      const pv = under.createSpan({ cls: "gz-pv" });
      pv.createSpan({ cls: "gz-pv-label", text: ctx.whatIf ? "what if" : planned ? "planned" : "at" });
      const when = plan && plan.length > 1 ? `${plan.length} times, ${whenText(plan[0], now)} to ${whenText(plan[plan.length - 1], now)}` : whenText(at, now);
      pv.createSpan({ cls: "gz-pv-value", text: when });
    }
    if (state.r.errors.length) under.createSpan({ cls: "gz-addline-error", text: state.r.errors[0] });
    if (refused !== undefined) under.createSpan({ cls: "gz-addline-error", text: `Not saved: ${refused}` });
  };

  const drawHint = () => {
    const lines = [...new Set([example(p, fields, 1, clock()), example(p, fields, 2, clock())])].filter((x) => x && x !== input.placeholder);
    if (!lines.length) return;
    under.createSpan({ cls: "gz-addline-try", text: "Try" });
    for (const line of lines) {
      under.createEl("button", { cls: "gz-addline-example", type: "button", text: line }).addEventListener("click", () => {
        clearLine();
        input.value = line;
        render();
        input.focus();
      });
    }
  };

  const render = () => {
    const state = read();
    const empty = input.value === "";
    if (empty) key.removeAttribute("hidden");
    else key.setAttribute("hidden", "");
    go.disabled = !state.savable;
    under.empty();
    if (!empty) drawPreview(state);
    else if (said.showing) said.draw(under);
    else drawHint();
    if (more) under.appendChild(more);
  };

  const save = async () => {
    const state = read();
    if (!state.savable) return;
    const row: Row = Object.fromEntries(fields.map(([name, type]) => [name, typed(type, state.values.get(name)!.value)]));
    const { at, plan } = state.r;
    saving = true;
    render();
    try {
      const r = await ctx.runActions(p, row, { inPlace: true, ...(at && { at }), ...(plan && { plan }) });
      if (r && r.error !== undefined) refused = r.error;
      else if (wentThrough(r)) {
        clearLine();
        sayAfter(said, p, r, () => addedText(p, row[fields[0]?.[0]], clock(), at, plan, ctx.whatIf !== undefined), ctx.whatIf !== undefined);
      }
    } finally {
      saving = false;
      render();
    }
  };

  input.addEventListener("input", () => {
    refused = undefined;
    if (input.value.trim() === "") picks.clear();
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    clearLine();
    render();
    input.blur();
  });
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    void save();
  });
  render();

  return {
    update(data) {
      rows = Array.isArray(data) ? data.filter(isPlainObject) : [];
      if (input.value !== "") render();
    },
    destroy() {
      unlisten();
      said.clear();
    },
  };
}

// ---- A button, and a form kept as fields --------------------------------------------------------

/** The panel's title, kept for screen readers (and finding the panel) though the line's verb says it on screen. */
function hiddenTitle(el: HTMLElement, p: Panel): void {
  if (p.title) el.createDiv({ cls: "gz-title gz-addline-title", text: p.title });
}

/** The small button that switches a form between one line and its fields. */
function createMore(el: HTMLElement, text: string, other: () => void): HTMLButtonElement {
  const b = el.createEl("button", { cls: "gz-addline-more", type: "button", text });
  b.addEventListener("click", () => other());
  return b;
}

/** A button in the line to add things: one big button, with what it did said beside it, with Undo. */
export function verbButton(el: HTMLElement, p: Panel, ctx: PanelCtx): PanelHandle {
  hiddenTitle(el, p);
  const row = el.createDiv({ cls: "gz-verb-row" });
  // gz-button too: it is still the button view's button.
  const b = row.createEl("button", { cls: "gz-verb gz-button mod-cta", type: "button" });
  icon(b, "check", 18);
  b.createSpan({ text: p.label ?? "Log" });
  const under = row.createDiv({ cls: "gz-addline-under" });
  const said = new Said(ctx, () => {
    under.empty();
    said.draw(under);
  });
  const unlisten = listen(el, said);
  b.addEventListener("click", handler(async () => {
    b.disabled = true;
    try {
      const r = await ctx.runActions(p, {}, { inPlace: true });
      if (wentThrough(r)) sayAfter(said, p, r, () => `Added to ${whereOf(p) ?? verbOf(p)}${ctx.whatIf === undefined ? "" : " as a what-if"}`, ctx.whatIf !== undefined);
    } finally {
      b.disabled = false;
    }
  }));
  return {
    update() {},
    destroy() {
      unlisten();
      said.clear();
    },
  };
}

/**
 * What a form kept as fields in the line to add things says under them once it saved, with Undo,
 * and the button that switches it to one line (`other`, when it reads as one).
 */
export function underFields(el: HTMLElement, p: Panel, ctx: PanelCtx, other?: () => void): { saved(row: Row, r: RunResult | void): void; destroy(): void } {
  const under = el.createDiv({ cls: "gz-addline-under" });
  const more = other && createMore(el, "Use one line", other);
  const said = new Said(ctx, () => {
    under.empty();
    said.draw(under);
    if (more) under.appendChild(more);
  });
  said.changed();
  const unlisten = listen(el, said);
  return {
    saved(row, r) {
      if (wentThrough(r)) sayAfter(said, p, r, () => addedText(p, row[fieldsOf(p)[0]?.[0]], ctx.whatIf ?? ctx.now, undefined, undefined, ctx.whatIf !== undefined), ctx.whatIf !== undefined);
    },
    destroy() {
      unlisten();
      said.clear();
    },
  };
}
