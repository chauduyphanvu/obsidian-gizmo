import { handler } from "./handler.ts";
import { formatValue, type Row } from "./data.ts";
import type { Reconcile } from "./match.ts";
import { wallTime } from "./time.ts";

/** How many open rows the reconcile card lists, one by one; the rest are counted. */
const RECONCILE_ROWS = 20;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A kind's row in a few words: its day, then what each field holds, a number to the cent, as a bank's statement says it. */
function rowWords(row: Row, fields: readonly string[]): string {
  const t = wallTime(row.at);
  const day = t === undefined ? "" : `${MONTHS[new Date(t).getMonth()]} ${new Date(t).getDate()}`;
  const values = fields.map((f) => row[f]).filter((v) => v !== undefined && v !== null && v !== "")
    .map((v) => formatValue(v, typeof v === "number" && !Number.isInteger(v) ? 2 : undefined));
  return [day, ...values].filter(Boolean).join(" · ");
}

/** What accepting or setting aside rows read from a file does, one click at a time. */
export interface ReconcileActs {
  accept: (open: Reconcile["open"]) => Promise<void>;
  dismiss: (row: Row) => Promise<void>;
}

/**
 * Rows read from a file that wait for a look: how they pair with what was logged, in four counts,
 * with Accept all; each open row with what it pairs with, Accept and Not mine. Accepting a paired
 * row pairs it; accepting one that pairs with nothing makes it logged; Not mine sets it aside.
 */
export function renderReconcile(header: HTMLElement, r: Reconcile, fields: readonly string[], act: ReconcileActs): HTMLElement {
  const card = header.createDiv({ cls: "gz-card gz-hand-edit gz-reconcile" });
  const n = r.open.length;
  card.createDiv({ cls: "gz-title", text: `${n} ${n === 1 ? "row" : "rows"} from a file to check` });
  const { pairs, attestedOnly, loggedOnly, loggedTwice } = r.counts;
  const counts = card.createDiv({ cls: "gz-reconcile-counts" });
  for (const [count, words] of [[pairs, "pair with rows you logged"], [attestedOnly, "only in the file"], [loggedOnly, "only logged"], [loggedTwice, "logged twice"]] as const) {
    const c = counts.createSpan({ cls: "gz-reconcile-count" });
    c.createSpan({ cls: "gz-reconcile-n", text: String(count) });
    c.createSpan({ text: ` ${words}` });
  }
  const buttons: HTMLButtonElement[] = [];
  const button = (row: HTMLElement, text: string, cta: boolean, run: () => Promise<void>) => {
    const b = row.createEl("button", { text, ...(cta && { cls: "mod-cta" }) });
    buttons.push(b);
    b.addEventListener("click", handler(async () => {
      for (const x of buttons) x.disabled = true;
      await run();
      for (const x of buttons) x.disabled = false;
    }));
  };
  button(card.createDiv({ cls: "gz-actions" }), "Accept all", true, () => act.accept(r.open));
  const ul = card.createEl("ul", { cls: "gz-reconcile-rows" });
  for (const o of r.open.slice(0, RECONCILE_ROWS)) {
    const li = ul.createEl("li");
    const what = li.createDiv({ cls: "gz-reconcile-what" });
    what.createSpan({ cls: "gz-reconcile-row", text: rowWords(o.row, fields) });
    what.createSpan({ cls: "gz-muted", text: o.pair ? ` = ${rowWords(o.pair, fields)}` : " · not logged" });
    const row = li.createDiv({ cls: "gz-actions" });
    button(row, "Accept", false, () => act.accept([o]));
    button(row, "Not mine", false, () => act.dismiss(o.row));
  }
  if (n > RECONCILE_ROWS) card.createDiv({ cls: "gz-muted", text: `and ${n - RECONCILE_ROWS} more; Accept all takes them too` });
  return card;
}
