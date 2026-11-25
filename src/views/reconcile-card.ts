import { handler } from "../handler.ts";
import { formatValue, type Row } from "../data.ts";
import { rowIdOf } from "../ledger-store.ts";
import type { Reconcile } from "../match.ts";
import { wallTime } from "../time.ts";
import { queue, type QueueItem } from "./queue.ts";

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

/** What accepting or setting aside rows read from a file does: each is one entry in the log, Undo takes it back. */
export interface ReconcileActs {
  accept: (open: Reconcile["open"]) => Promise<void>;
  dismiss: (rows: Row[]) => Promise<void>;
}

/**
 * Rows read from a file that wait for a look: how they pair with what was logged, in four counts,
 * with Accept all; each open row with a dot (paired, or not logged), what it pairs with, Accept and
 * Not mine. Accepting a paired row pairs it; accepting one that pairs with nothing makes it logged;
 * Not mine sets it aside. The rows are a queue (see queue.ts): Enter accepts, x is Not mine, Space
 * selects, ⇧Enter accepts the selection, else every row. `home` keeps the focus and the selection
 * while the card is drawn again.
 */
export function renderReconcile(host: HTMLElement, r: Reconcile, fields: readonly string[], act: ReconcileActs, home: object = host): HTMLElement {
  const card = host.createDiv({ cls: "gz-card gz-hand-edit gz-reconcile" });
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
  let running = false;
  const run = async (fn: () => Promise<unknown>) => {
    if (running) return;
    running = true;
    for (const x of buttons) x.disabled = true;
    try {
      await fn();
    } finally {
      running = false;
      for (const x of buttons) x.disabled = false;
    }
  };
  const button = (row: HTMLElement, text: string, cta: boolean, fn: () => Promise<void>, title?: string) => {
    const b = row.createEl("button", { text, ...(cta && { cls: "mod-cta" }), ...(title && { attr: { title } }) });
    buttons.push(b);
    b.addEventListener("click", handler(() => run(fn)));
  };
  button(card.createDiv({ cls: "gz-actions" }), "Accept all", true, () => act.accept(r.open), "Accept all (Shift+Enter)");
  const ul = card.createEl("ul", { cls: "gz-reconcile-rows" });
  const keyOf = (row: Row, i: number) => rowIdOf(row) ?? `#${i}`;
  const shown = r.open.slice(0, RECONCILE_ROWS);
  const items = shown.map((o, i): QueueItem => {
    const li = ul.createEl("li");
    li.createSpan({ cls: `gz-status ${o.pair ? "is-ok" : "is-warn"}`, attr: { "aria-hidden": "true" } });
    const what = li.createDiv({ cls: "gz-reconcile-what" });
    what.createSpan({ cls: "gz-reconcile-row", text: rowWords(o.row, fields) });
    what.createSpan({ cls: "gz-muted", text: o.pair ? ` pairs with ${rowWords(o.pair, fields)}` : " · not logged" });
    const row = li.createDiv({ cls: "gz-actions" });
    button(row, "Accept", false, () => act.accept([o]), "Accept (Enter)");
    button(row, "Not mine", false, () => act.dismiss([o.row]), "Not mine (x)");
    return { key: keyOf(o.row, i), el: li, primary: () => act.accept([o]), secondary: () => act.dismiss([o.row]) };
  });
  const chosen = (keys: string[]) => shown.filter((o, i) => keys.includes(keyOf(o.row, i)));
  const bar = card.createDiv({ cls: "gz-queue-bulk", attr: { role: "toolbar", "aria-label": "Selected rows" } });
  queue(ul, items, {
    home,
    run,
    all: (keys) => act.accept(keys ? chosen(keys) : r.open),
    select: { bar, actions: [["Accept", (keys) => act.accept(chosen(keys))], ["Not mine", (keys) => act.dismiss(chosen(keys).map((o) => o.row))]] },
  });
  if (n > RECONCILE_ROWS) card.createDiv({ cls: "gz-muted", text: `and ${n - RECONCILE_ROWS} more; Accept all takes them too` });
  card.createDiv({ cls: "gz-queue-keys gz-muted", text: "↑↓ move · Enter accept · x not mine · Space select · Shift+Enter accept the selection, or all" });
  return card;
}
