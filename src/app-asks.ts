import { answerLabel, type Ask } from "./asks.ts";
import { handler } from "./handler.ts";
import { queue, type QueueItem } from "./views/queue.ts";

/** What an ask's answer did: the entry it was kept as, and what it says. */
export interface AskDone {
  ok: boolean;
  error?: string;
  entryId?: string;
  what?: string;
}

/**
 * What the person is asked across the vault, as Next has them (see background-asks.ts), and how
 * an app's own tab answers them: the same answers, skips and dismissals Next makes.
 */
export interface AppAsks {
  list(): Ask[];
  /** Calls back on every change; returns what stops it. */
  subscribe(cb: () => void): () => void;
  settle(ask: Ask, how: "answer" | "dismiss"): Promise<AskDone>;
  skip(id: string): Promise<void>;
  /** Runs a line as Do… does, telling nothing: `told` is what it would have said. */
  run(line: string): Promise<{ ok: boolean; error?: string; told?: string; entryId?: string }>;
  /** Opens Do… with a line still to be finished, typing going in at `cursor`. */
  fill(line: string, cursor: number): void;
}

/** What the card needs of the app it is drawn in. */
export interface AsksSite {
  asks: AppAsks;
  appPath: string;
  /** Where it goes: the section for what waits to be acted on; undefined while the app shows no panels. */
  host(): HTMLElement | undefined;
  /** Says what an answer did under `at` (the card, else the app's header), with Undo when it was kept. */
  said(at: HTMLElement | undefined, text: string, entryId: string | undefined): void;
  notify(text: string): void;
}

/** This app's asks: those it makes, less those whose answer is only to open it, as it already is. */
export function ownAsks(all: readonly Ask[], appPath: string): Ask[] {
  return all.filter((a) => a.path === appPath && !("open" in a.answer));
}

/**
 * The asks of an app, in its own tab, as a card above its records: each with what answering does,
 * worked with Next's keys (see queue.ts). Drawn again only when what is asked changes, or the app
 * is laid out again.
 */
export class AsksCard {
  private site: AsksSite;
  private card: HTMLElement | undefined;
  private shown = "";
  private unsubscribe: (() => void) | undefined;

  constructor(site: AsksSite) {
    this.site = site;
  }

  /** Draws the card if what is asked changed, or it is no longer on the page; follows the feed from then on. */
  draw(): void {
    this.unsubscribe ??= this.site.asks.subscribe(() => this.draw());
    const asks = ownAsks(this.site.asks.list(), this.site.appPath);
    const json = JSON.stringify(asks);
    if (json === this.shown && (this.card?.isConnected || !asks.length)) return;
    this.shown = json;
    const host = this.site.host();
    const old = this.card;
    this.card = undefined;
    if (!asks.length || !host) return void old?.remove();
    const card = host.ownerDocument.createElement("div");
    card.className = "gz-card gz-asks";
    // In the page before it is filled, so the focus can come back to a row of it.
    if (old?.isConnected && old.parentElement === host) old.replaceWith(card);
    else {
      old?.remove();
      host.appendChild(card);
    }
    this.card = card;
    this.fill(card, asks);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.card?.remove();
    this.card = undefined;
    this.shown = "";
  }

  /** Said under the card as it is now, drawn again since the answer, else under the header. */
  private say(text: string, entryId: string | undefined): void {
    this.site.said(this.card?.isConnected ? this.card : undefined, text, entryId);
  }

  private fill(card: HTMLElement, asks: Ask[]): void {
    card.createDiv({ cls: "gz-title", text: `Needs you · ${asks.length}` });
    const ul = card.createEl("ul", { cls: "gz-asks-rows" });
    const buttons: HTMLButtonElement[] = [];
    let running = false;
    const run = async (fn: () => Promise<unknown>) => {
      if (running) return;
      running = true;
      for (const b of buttons) b.disabled = true;
      try {
        await fn();
      } finally {
        running = false;
        for (const b of buttons) b.disabled = false;
      }
    };
    const items = asks.map((ask): QueueItem => {
      const li = ul.createEl("li");
      li.createSpan({ cls: "gz-status is-warn", attr: { "aria-hidden": "true" } });
      const what = li.createDiv({ cls: "gz-asks-what" });
      what.createDiv({ cls: "gz-asks-text", text: ask.text });
      if ("line" in ask.answer) what.createDiv({ cls: "gz-muted gz-asks-line", text: ask.answer.line });
      const row = li.createDiv({ cls: "gz-actions" });
      const button = (text: string, keyName: string, fn: () => Promise<unknown>, cta = false) => {
        const b = row.createEl("button", { text, attr: { title: `${text} (${keyName})` }, ...(cta && { cls: "mod-cta" }) });
        buttons.push(b);
        b.addEventListener("click", handler(() => run(fn)));
      };
      const primary = () => this.answer(ask);
      const secondary = ask.refuse || ask.dismiss ? () => this.dismiss(ask) : undefined;
      const skip = () => this.skip(ask);
      button("Skip", "s", skip);
      if (secondary) button(ask.refuse ? "Refuse" : "Dismiss", "x", secondary);
      button(this.label(ask), "Enter", primary, true);
      return { key: ask.id, el: li, primary, secondary, skip };
    });
    queue(ul, items, { home: this, run });
    const x = asks.some((a) => a.refuse) ? "x refuses" : asks.some((a) => a.dismiss) ? "x dismisses" : undefined;
    card.createDiv({ cls: "gz-queue-keys gz-muted", text: ["↑↓ move", "Enter answers", "s skips until tomorrow", ...(x ? [x] : [])].join(" · ") });
  }

  /** A line still to be finished is finished in Do…; every other answer is made here. */
  private label(ask: Ask): string {
    return "line" in ask.answer && !ask.answer.ready ? "Fill in…" : answerLabel(ask);
  }

  private async answer(ask: Ask): Promise<void> {
    const asks = this.site.asks;
    if ("line" in ask.answer) {
      if (!ask.answer.ready) return asks.fill(ask.answer.line, ask.answer.cursor);
      const r = await asks.run(ask.answer.line);
      if (!r.ok) return this.site.notify(r.error ?? "Nothing changed");
      return this.say(r.told ?? `Ran ${ask.answer.line}`, r.entryId);
    }
    this.done(await asks.settle(ask, "answer"));
  }

  private async dismiss(ask: Ask): Promise<void> {
    this.done(await this.site.asks.settle(ask, "dismiss"));
  }

  private async skip(ask: Ask): Promise<void> {
    await this.site.asks.skip(ask.id);
    this.say("Skipped until tomorrow", undefined);
  }

  private done(r: AskDone): void {
    if (!r.ok) return this.site.notify(r.error ?? "Nothing changed");
    this.say(r.what ?? "Done", r.entryId);
  }
}
