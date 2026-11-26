/**
 * A capture line as Do… and Next show it, on any host the runtime runs in: the line, under it what
 * comes next or what's wrong, completions for the last word (Tab takes the first), and what running
 * it would change, worked out by a dry run. The host says which app is open, shows an app ahead,
 * and tells what a line did.
 */
import { parseWhatIf, whatIfLine } from "./ahead.ts";
import { askLine } from "./ask.ts";
import type { AskPane, AskShown } from "./ask-pane.ts";
import { completed, parseLine, whenText, type Parsed } from "./capture.ts";
import { runsText, submitLine, whatIfAppOf } from "./capture-run.ts";
import type { DoChoice } from "./do-choices.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { basename } from "./store.ts";

/** What only the host of a line can do. */
export interface LineHost {
  rt: GizmoRuntime;
  /** The app open in front, which a what-if is tried in when it reads the line's kind. */
  openApp(): string | undefined;
  /** Shows an app ahead, `line` saved as a what-if row first. */
  ahead(app: string, line: string): void | Promise<void>;
  /** Says what a line did, with Undo when it changed something (`entryId`). */
  told(text: string, entryId: string | undefined): void;
}

/**
 * Enter calls `onEnter`. With an `ask` pane (Do…), a line that starts with `?` asks a question of
 * the vault's kinds instead, and shows the answer there (see AskPane).
 */
export class LineBox {
  readonly input: HTMLInputElement;
  private host: LineHost;
  private hint: HTMLElement;
  private chips: HTMLElement;
  private effects: HTMLElement;
  private ask: AskPane | undefined;
  /** What the ask line said last, for Tab to take its first completion. */
  private asked: AskShown | undefined;
  private run = 0;
  private timer: number | undefined;
  /** Do… only: what to offer for a line no shortcut reads (see do-choices.ts), and what taking one ends. */
  private fallback: { choices(line: string): DoChoice[]; done(): void } | undefined;

  constructor(host: LineHost, el: HTMLElement, placeholder: string, onEnter: () => void, ask?: (el: HTMLElement) => AskPane, fallback?: LineBox["fallback"]) {
    this.host = host;
    this.fallback = fallback;
    this.input = el.createEl("input", { cls: "gz-capture-input", type: "text", attr: { placeholder, spellcheck: "false", autocapitalize: "off" } });
    this.hint = el.createDiv({ cls: "gz-capture-hint gz-muted" });
    this.chips = el.createDiv({ cls: "gz-capture-chips" });
    this.effects = el.createEl("ul", { cls: "gz-effects" });
    this.ask = ask?.(el);
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => {
      const asking = this.asking();
      if (e.key === "Tab") {
        // What was typed since the last preview counts: the line is read again as it is now.
        const bg = this.host.rt.background;
        const now = asking ? undefined : this.whatIf()?.parsed ?? parseLine(this.input.value, bg.captureIndex(), new Date());
        const first = asking ? this.asked?.completions[0] : now && !now.ok ? now.completions[0] : undefined;
        if (first === undefined) return;
        e.preventDefault();
        this.take(first);
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        if (asking && (e.metaKey || e.ctrlKey)) this.ask!.keep();
        else onEnter();
      }
    });
  }

  /** Whether the line is a question for the ask pane, not a shortcut to run. */
  private asking(): boolean {
    return this.ask !== undefined && askLine(this.input.value) !== undefined;
  }

  /** A line that starts `what if`, read as a what-if: nothing real is run or worked out, so it shows only where it goes. */
  private whatIf(): { line: string; parsed: Parsed } | undefined {
    const bg = this.host.rt.background;
    const line = whatIfLine(this.input.value);
    return line !== undefined ? { line, parsed: parseWhatIf(line, bg.captureIndex(), new Date()) } : undefined;
  }

  /** Stops a preview waiting to be worked out, and the answer an ask drew. */
  stop(): void {
    window.clearTimeout(this.timer);
    this.ask?.dispose();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.show(), 120);
  }

  private take(completion: string): void {
    const question = this.asking() ? askLine(this.input.value) : undefined;
    this.input.value = question === undefined ? completed(this.input.value, completion) : `? ${completed(question.trimStart(), completion)}`;
    this.input.focus();
    void this.show();
  }

  /**
   * Do… only: what the line offers when no shortcut reads it and no shortcut's name starts it (an app
   * to open, a Gizmo window), read from the line as it is now; none for a question or a what-if.
   */
  choices(): DoChoice[] {
    const bg = this.host.rt.background;
    const line = this.input.value.trim();
    if (!this.fallback || !line || this.asking() || this.whatIf()) return [];
    const parsed = parseLine(line, bg.captureIndex(), new Date());
    return parsed.ok || parsed.completions.length ? [] : this.fallback.choices(line);
  }

  /** Works out what the line would do as it stands, and shows it. */
  async show(): Promise<void> {
    const bg = this.host.rt.background;
    const run = ++this.run;
    const question = this.ask && askLine(this.input.value);
    if (this.ask && question !== undefined) {
      const shown = await this.ask.show(question);
      if (run !== this.run) return;
      this.asked = shown;
      this.hint.setText(shown.hint);
      this.hint.toggleClass("gz-error-text", shown.error);
      this.chips.empty();
      for (const c of shown.completions.slice(0, 12)) this.chips.createEl("button", { cls: "gz-small gz-capture-chip", text: c }).addEventListener("click", () => this.take(c));
      this.effects.empty();
      return;
    }
    this.ask?.hide();
    const whatIf = this.whatIf();
    const { parsed, effects } = whatIf ? { parsed: whatIf.parsed, effects: [] } : await bg.previewLine(this.input.value);
    if (run !== this.run) return;
    this.hint.empty();
    this.hint.toggleClass("gz-error-text", !parsed.ok && this.input.value.trim() !== "");
    if (!parsed.ok && this.input.value.trim() !== "") this.hint.setText(parsed.next ? `${parsed.error} · ${parsed.next}` : parsed.error);
    else if (parsed.ok && whatIf) this.hint.setText(`What if, in ${basename(whatIfAppOf(this.host.rt, parsed.target, this.host.openApp()))}: ${parsed.target.label}${parsed.at ? ` for ${whenText(parsed.at, new Date())}` : ""}. Nothing real changes until Keep.`);
    else if (parsed.ok) this.hint.setText(`${runsText(parsed, new Date())}${parsed.next ? ` · next, ${parsed.next}` : ""}`);
    else this.hint.setText("Type a shortcut's name, then its values");
    this.chips.empty();
    for (const c of parsed.ok ? [] : parsed.completions.slice(0, 12)) {
      const chip = this.chips.createEl("button", { cls: "gz-small gz-capture-chip", text: c });
      chip.addEventListener("click", () => this.take(c));
    }
    const offered = whatIf ? [] : this.choices();
    if (offered.length) {
      this.hint.toggleClass("gz-error-text", false);
      this.hint.setText(`No shortcut is called that · Enter: ${offered[0].label}`);
      for (const c of offered) {
        this.chips.createEl("button", { cls: "gz-small gz-capture-chip gz-capture-open", text: c.label }).addEventListener("click", () => {
          c.run();
          this.fallback?.done();
        });
      }
    }
    this.effects.empty();
    for (const line of effects ?? []) this.effects.createEl("li", { text: line });
  }

  /**
   * Runs the line, as the Do… command does, and says so with Undo; true when it ran. A line it
   * couldn't read is shown where it was typed; one that ran and failed has said why.
   */
  async submit(): Promise<boolean> {
    const done = await submitLine(this.host.rt, this.input.value, {
      asks: this.ask !== undefined,
      open: this.host.openApp(),
      busy: (busy) => { this.input.disabled = busy; },
    });
    switch (done.kind) {
      case "ask":
        window.clearTimeout(this.timer);
        await this.show();
        return false;
      case "unread":
        await this.show();
        return false;
      case "what-if":
        await this.host.ahead(done.app, done.line);
        return true;
      case "ran":
        // A run that changed nothing to undo is still told, once.
        this.host.told(done.text, done.entryId);
        return true;
      default:
        return false;
    }
  }
}
