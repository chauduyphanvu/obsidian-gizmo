import { Modal, Notice } from "obsidian";
import { keyAction, type Ask } from "./asks.ts";
import { LineBox, undoNotice } from "./capture-command.ts";
import type GizmoPlugin from "./main.ts";

/** What the main button of an ask says: what Enter does with it. */
function answerLabel(ask: Ask): string {
  if ("line" in ask.answer) return "Run";
  if ("writer" in ask.answer) return "Accept";
  return "open" in ask.answer ? `Open ${ask.app}` : "It happened";
}

/**
 * "Next": what needs the person, one ask at a time, oldest due first (see asks.ts). An ask with a
 * line shows it ready to run, editable, with the Do… window's preview; Enter answers the ask, then
 * the next one shows. While no line is being typed in, s skips the ask until tomorrow and x
 * dismisses it for good; the buttons do the same on a phone.
 */
class NextModal extends Modal {
  private plugin: GizmoPlugin;
  private body!: HTMLElement;
  private count: HTMLElement | undefined;
  private ask: Ask | undefined;
  private box: LineBox | undefined;
  /** Asks answered, skipped or dismissed in this window, left out while the queue catches up. */
  private done = new Set<string>();
  private acting = false;
  private unsubscribe: (() => void) | undefined;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Next");
    this.modalEl.addClass("gz-next-modal");
    this.body = this.contentEl.createDiv({ cls: "gizmo gz-share gz-capture gz-next", attr: { tabindex: "-1" } });
    this.modalEl.addEventListener("keydown", (e) => this.onKey(e));
    // An ask answered elsewhere meanwhile gives way to the next; any other change only moves the count.
    this.unsubscribe = this.plugin.background?.asks.subscribe(() => {
      const queue = this.queue();
      if (!this.ask || !queue.some((a) => a.id === this.ask!.id)) this.draw();
      else this.count?.setText(this.countText(queue.length));
    });
    this.draw();
  }

  /** Obsidian puts the keys in the window's first input as it opens it; the ask decides where they go. */
  open(): void {
    super.open();
    this.aim();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.box?.stop();
    this.contentEl.empty();
  }

  private queue(): Ask[] {
    return (this.plugin.background?.asks.list() ?? []).filter((a) => !this.done.has(a.id));
  }

  private countText(n: number): string {
    return `${this.ask?.app ?? ""} · 1 of ${n}`;
  }

  private draw(): void {
    this.box?.stop();
    this.box = undefined;
    this.body.empty();
    const queue = this.queue();
    const ask = queue[0];
    this.ask = ask;
    if (!ask) {
      this.count = undefined;
      this.body.createEl("p", { cls: "gz-next-empty", text: "Nothing needs you." });
      this.aim();
      return;
    }
    this.count = this.body.createDiv({ cls: "gz-muted gz-next-count", text: this.countText(queue.length) });
    this.body.createDiv({ cls: "gz-next-text", text: ask.text });
    if ("line" in ask.answer) {
      this.box = new LineBox(this.plugin, this.body, "", () => void this.act("answer"));
      this.box.input.value = ask.answer.line;
      void this.box.show();
    }
    const row = this.body.createDiv({ cls: "modal-button-container gz-next-buttons" });
    const button = (text: string, what: "answer" | "skip" | "dismiss", cta = false) => {
      const b = row.createEl("button", { text, cls: cta ? "mod-cta" : "" });
      b.addEventListener("click", () => void this.act(what));
    };
    button("Skip", "skip");
    if (ask.refuse) button("Refuse", "dismiss");
    else if (ask.dismiss) button("Dismiss", "dismiss");
    button(answerLabel(ask), "answer", true);
    const keys = [ask.refuse ? "Enter accepts" : "Enter answers", "s skips until tomorrow", ...(ask.refuse ? ["x refuses"] : ask.dismiss ? ["x dismisses"] : []), "Esc closes"];
    this.body.createDiv({ cls: "gz-muted gz-next-keys", text: [...keys.slice(0, -1), ...(this.box ? ["Tab edits the line"] : []), keys.at(-1)].join(" · ") });
    this.aim();
  }

  /** A line still to be typed in takes the keys, its cursor where typing goes; otherwise they act on the ask. */
  private aim(): void {
    const ask = this.ask;
    if (ask && "line" in ask.answer && !ask.answer.ready && this.box) {
      this.box.input.focus();
      this.box.input.setSelectionRange(ask.answer.cursor, ask.answer.cursor);
    } else this.body.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    // Enter or Space on a button is that button's own click.
    if (!this.ask || e.isComposing || (tag === "BUTTON" && (e.key === "Enter" || e.key === " "))) return;
    // Tab from the window goes into the line where typing goes, rather than selecting all of it.
    if (e.key === "Tab" && !e.shiftKey && e.target === this.body && this.box && "line" in this.ask.answer) {
      e.preventDefault();
      this.box.input.focus();
      this.box.input.setSelectionRange(this.ask.answer.cursor, this.ask.answer.cursor);
      return;
    }
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    const what = keyAction({ key: e.key, mod: e.ctrlKey || e.metaKey || e.altKey, typing }, this.ask);
    if (!what) return;
    e.preventDefault();
    void this.act(what);
  }

  private async act(what: "answer" | "skip" | "dismiss"): Promise<void> {
    const ask = this.ask;
    const bg = this.plugin.background;
    if (!ask || !bg || this.acting) return;
    this.acting = true;
    try {
      if (what === "skip") await bg.skipAsk(ask.id);
      else if (what === "dismiss" || "change" in ask.answer || "writer" in ask.answer) {
        const r = await bg.settleAsk(ask, what);
        if (!r.ok) return void new Notice(r.error ?? "Nothing changed");
        const text = `${ask.app}: ${r.what ?? "done"}.`;
        // Accepting a writer with no rows waiting changed no row: still told, with nothing to undo.
        if (r.entryId) undoNotice(this.plugin, text, r.entryId);
        else new Notice(text);
      } else if ("open" in ask.answer) {
        this.close();
        void this.app.workspace.openLinkText(ask.path, "", false);
        return;
      } else if (!(await this.box?.submit())) return void this.box?.input.focus();
      this.done.add(ask.id);
      this.draw();
    } finally {
      this.acting = false;
    }
  }
}

export function openNext(plugin: GizmoPlugin): void {
  new NextModal(plugin).open();
}

/** "Next", and the status bar's count that opens it (see background-glue.ts). */
export function registerNextCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({ id: "next", name: "Next", callback: () => openNext(plugin) });
}
