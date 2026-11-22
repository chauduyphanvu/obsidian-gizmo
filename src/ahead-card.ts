import type { Ahead, Kept, WhatIfRow } from "./ahead.ts";
import { whatIfText } from "./ahead.ts";
import { handler } from "./handler.ts";
import { pastText } from "./replay.ts";
import { dayIn, toTime } from "./time.ts";

/** What the card does: each a write the app shown ahead makes, or the person's way back. */
export interface AheadActions {
  remove(r: WhatIfRow): Promise<void>;
  keep(rows: WhatIfRow[]): Promise<Kept>;
  discard(): Promise<void>;
  /** Undoes the activity entry Keep made. */
  undo?(entry: string): Promise<string>;
  back?(): void;
}

/** What the look ahead found, to fill the card with. */
export interface AheadFound {
  rows: WhatIfRow[];
  /** A line for each alert or rule that would go off; undefined when the app has none. */
  lines?: string[];
  /** It stopped short of the time shown, at this time (see MAX_STEPS). */
  cutAt?: number;
  errors: string[];
}

/** The card's parts filled again as the what-if changes. */
export interface AheadCard {
  el: HTMLElement;
  fill(found: AheadFound): void;
}

const DAY = 86_400_000;

/**
 * The banner of an app shown ahead: what it is and when for, what the time shown doesn't reach,
 * a way to pick another day, the what-if rows (each with Remove), what the app's rules would do
 * on the way, and Keep, Discard and Back to now.
 */
export function renderAheadCard(header: HTMLElement, ahead: Ahead, asNow: { now: string[]; kept: string[] }, actions: AheadActions): AheadCard {
  const now = ahead.live.now();
  const el = header.createDiv({ cls: "gz-card gz-past gz-ahead" });
  const top = el.createDiv({ cls: "gz-ahead-top" });
  const said = top.createSpan({ cls: "gz-past-text" });
  // Beside the time rail, which names the moment, CSS hides the date, as it does the past's.
  said.createSpan({ cls: "gz-past-when gz-ahead-when", text: `What if: as of ${pastText(ahead.at)}. ` });
  said.append("Rows added here are what-ifs; nothing real changes until Keep.");
  if (asNow.now.length) said.append(` Shown as they are now: ${asNow.now.join(", ")}.`);
  if (asNow.kept.length) said.append(` Shown with the latest answer kept: ${asNow.kept.join(", ")}.`);
  const pick = top.createEl("label", { cls: "gz-ahead-pick" });
  pick.createSpan({ text: "Show at " });
  const date = pick.createEl("input", { type: "date", attr: { "aria-label": "Show the app as it would be at the end of this day" } });
  date.min = dayIn(now.getTime());
  date.max = dayIn(now.getTime() + 365 * DAY);
  date.value = dayIn(ahead.at);
  date.addEventListener("change", () => {
    const [y, m, d] = date.value.split("-").map(Number);
    if (!y || !m || !d) return;
    // The end of the day picked, so what happens on it counts; never before now.
    ahead.show(Math.max(new Date(y, m - 1, d, 23, 59).getTime(), now.getTime()));
  });
  if (actions.back) top.createEl("button", { cls: "gz-past-back", text: "Back to now" }).addEventListener("click", () => actions.back!());
  const body = el.createDiv({ cls: "gz-ahead-body" });
  const status = el.createDiv({ cls: "gz-ahead-said", attr: { role: "status" } });
  const tell = (text: string, entry?: string) => {
    status.empty();
    status.createSpan({ text });
    if (entry !== undefined && actions.undo) {
      const undo = status.createEl("button", { cls: "gz-small", text: "Undo" });
      undo.addEventListener("click", handler(async () => {
        undo.disabled = true;
        tell(await actions.undo!(entry));
      }));
    }
  };
  let busy = false;
  const act = (fn: () => Promise<void>) => handler(async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      tell(`Couldn't do it: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  });

  const fill = (found: AheadFound) => {
    body.empty();
    const { rows } = found;
    if (!rows.length) body.createDiv({ cls: "gz-muted", text: "No what-if rows yet. Add one with the line below, or type “what if” and a line in Do…." });
    else {
      body.createDiv({ cls: "gz-ahead-head", text: rows.length === 1 ? "1 what-if row" : `${rows.length} what-if rows` });
      const ul = body.createEl("ul", { cls: "gz-ahead-rows" });
      for (const r of rows) {
        const li = ul.createEl("li");
        const at = toTime(r.row.at);
        const later = at !== undefined && at > ahead.at ? ` (after ${pastText(ahead.at).replace(/, \d\d:\d\d$/, "")}, so not counted yet)` : "";
        li.createSpan({ text: `${r.list}: ${whatIfText(r.row, now)}${later}` });
        li.createEl("button", { cls: "gz-small", text: "Remove", attr: { "aria-label": `Remove the what-if row ${whatIfText(r.row, now)}` } })
          .addEventListener("click", act(() => actions.remove(r)));
      }
    }
    if (found.lines) {
      body.createDiv({ cls: "gz-ahead-head", text: "On the way there" });
      if (!found.lines.length) body.createDiv({ cls: "gz-muted", text: "None of the app's alerts or rules would go off." });
      else {
        const ul = body.createEl("ul", { cls: "gz-ahead-lines" });
        for (const line of found.lines) ul.createEl("li", { text: line });
      }
      if (found.cutAt !== undefined) body.createDiv({ cls: "gz-muted", text: `It looked only as far as ${pastText(found.cutAt)}.` });
      if (found.errors.length) body.createDiv({ cls: "gz-muted", text: `Couldn't read: ${found.errors.join("; ")}` });
      if (found.lines.some((line) => line.includes("; it would run "))) body.createDiv({ cls: "gz-muted", text: "A then is only named; nothing runs." });
    }
    const keepable = rows.filter((r) => r.note.kind === r.list);
    const stay = [...new Set(rows.filter((r) => r.note.kind !== r.list).map((r) => r.list))];
    if (stay.length) body.createDiv({ cls: "gz-muted", text: `Keep isn't offered for ${stay.join(", ")}: planned rows need a kind. Those rows stay what-ifs until Discard.` });
    const buttons = body.createDiv({ cls: "gz-ahead-actions" });
    if (keepable.length) {
      buttons.createEl("button", { cls: "mod-cta", text: keepable.length === 1 ? "Keep as planned" : `Keep ${keepable.length} as planned` }).addEventListener("click", act(async () => {
        const k = await actions.keep(keepable);
        if (k.kept) tell(`Kept ${k.kept === 1 ? "1 row" : `${k.kept} rows`} as planned.`, k.entry);
        else if (k.gone) tell("These rows were kept before, and that was undone; nothing was added.");
        else tell("These rows were kept already; nothing was added.");
      }));
    }
    if (rows.length) {
      buttons.createEl("button", { text: "Discard" }).addEventListener("click", act(async () => {
        await actions.discard();
        tell("Discarded the what-if rows.");
      }));
    }
  };
  body.createDiv({ cls: "gz-muted", text: "Reading the what-if…" });
  return { el, fill };
}
