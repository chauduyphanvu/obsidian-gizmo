import {
  EditorSuggest, Modal, Notice, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo,
} from "obsidian";
import { handler } from "./handler.ts";
import { undoMessage } from "./activity.ts";
import { copyText } from "./host.ts";
import { captureLine, completed, parseLine, plannedText, receipt, whenText, type CaptureTarget, type Parsed } from "./capture.ts";
import { frozen, rowLineText } from "./row-lines.ts";
import { parseWhatIf, whatIfLine } from "./ahead.ts";
import { askLine } from "./ask.ts";
import { AskPane, type AskShown } from "./ask-view.ts";
import type GizmoPlugin from "./main.ts";
import { openAppAhead } from "./past-views.ts";
import { kindOfPanel } from "./sources/kind.ts";
import { basename } from "./store.ts";
import { AppView } from "./view.ts";

/**
 * What a line that can run runs, and for when if not now: `Budget: Spent something at Thu Nov 19,
 * 13:00`; for a kind, `planned for` a time still to come, or each time of an `@every`.
 */
function runs(parsed: Parsed & { ok: true }): string {
  const now = new Date();
  const when = parsed.at && (plannedText({ at: parsed.at, plan: parsed.plan }, now) ?? `at ${whenText(parsed.at, now)}`);
  return `${parsed.target.app}: ${parsed.target.label}${when ? ` ${when}` : ""}`;
}

/**
 * The app a `what if` line is tried in: the app open in the active tab, when the line saves to a
 * kind that app reads or saves to; else the app the line's shortcut is in.
 */
function whatIfApp(plugin: GizmoPlugin, target: CaptureTarget): string {
  const kindIn = (path: string, shortcut?: string) => plugin.background?.spec(path)?.panels
    .filter((ps) => shortcut === undefined || ps.panel.shortcut === shortcut)
    .map((ps) => kindOfPanel(ps.panel)?.path)
    .filter((p): p is string => p !== undefined) ?? [];
  const [kind] = kindIn(target.path, target.shortcut);
  const open = plugin.app.workspace.getActiveViewOfType(AppView)?.file?.path;
  return kind !== undefined && open !== undefined && kindIn(open).includes(kind) ? open : target.path;
}

/** A notice saying a capture line ran, with Undo for what it changed. */
export function capturedNotice(plugin: GizmoPlugin, line: string, told: string | undefined, entryId: string | undefined): void {
  const text = told === undefined ? `Ran “${line}”.` : /[.!?]$/.test(told) ? told : `${told}.`;
  // A run that changed nothing to undo is still told, once.
  if (entryId) undoNotice(plugin, text, entryId);
  else new Notice(text);
}

/** A notice saying what was just done, with Undo for what it changed in the activity log. */
export function undoNotice(plugin: GizmoPlugin, text: string, entryId: string | undefined): void {
  if (!entryId) return;
  const frag = createFragment((f) => {
    f.createSpan({ text: `${text} ` });
    const undo = f.createEl("a", { text: "Undo", href: "#" });
    undo.addEventListener("click", handler(async (e) => {
      e.preventDefault();
      const entry = await plugin.activity.get(entryId);
      if (!entry) return void new Notice("That change is no longer in the activity log");
      new Notice(undoMessage(await plugin.undo(entry)));
    }));
  });
  new Notice(frag, 8000);
}

/**
 * A capture line as Do… and Next show it: the line, under it what comes next or what's wrong,
 * completions for the last word (Tab takes the first), and what running it would change, worked
 * out by a dry run. Enter calls `onEnter`. With an `ask` pane (Do…), a line that starts with `?`
 * asks a question of the vault's kinds instead, and shows the answer there (see AskPane).
 */
export class LineBox {
  readonly input: HTMLInputElement;
  private plugin: GizmoPlugin;
  private hint: HTMLElement;
  private chips: HTMLElement;
  private effects: HTMLElement;
  private ask: AskPane | undefined;
  /** What the ask line said last, for Tab to take its first completion. */
  private asked: AskShown | undefined;
  private run = 0;
  private timer = 0;

  constructor(plugin: GizmoPlugin, el: HTMLElement, placeholder: string, onEnter: () => void, ask?: (el: HTMLElement) => AskPane) {
    this.plugin = plugin;
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
        const bg = this.plugin.background;
        const now = asking ? undefined : bg ? (this.whatIf()?.parsed ?? parseLine(this.input.value, bg.captureIndex(), new Date())) : undefined;
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
    const bg = this.plugin.background;
    const line = whatIfLine(this.input.value);
    return bg && line !== undefined ? { line, parsed: parseWhatIf(line, bg.captureIndex(), new Date()) } : undefined;
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

  /** Works out what the line would do as it stands, and shows it. */
  async show(): Promise<void> {
    const bg = this.plugin.background;
    if (!bg) return;
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
    else if (parsed.ok && whatIf) this.hint.setText(`What if, in ${basename(whatIfApp(this.plugin, parsed.target))}: ${parsed.target.label}${parsed.at ? ` for ${whenText(parsed.at, new Date())}` : ""}. Nothing real changes until Keep.`);
    else if (parsed.ok) this.hint.setText(`${runs(parsed)}${parsed.next ? ` · next, ${parsed.next}` : ""}`);
    else this.hint.setText("Type a shortcut's name, then its values");
    this.chips.empty();
    for (const c of parsed.ok ? [] : parsed.completions.slice(0, 12)) {
      const chip = this.chips.createEl("button", { cls: "gz-small gz-capture-chip", text: c });
      chip.addEventListener("click", () => this.take(c));
    }
    this.effects.empty();
    for (const line of effects ?? []) this.effects.createEl("li", { text: line });
  }

  /**
   * Runs the line, as the Do… command does, and says so with Undo; true when it ran. A line it
   * couldn't read is shown where it was typed; one that ran and failed has said why in a notice.
   */
  async submit(): Promise<boolean> {
    const bg = this.plugin.background;
    const line = this.input.value.trim();
    if (!bg || !line) return false;
    // A question saves nothing: Enter only shows its answer at once.
    if (this.asking()) {
      window.clearTimeout(this.timer);
      await this.show();
      return false;
    }
    const whatIf = this.whatIf();
    if (whatIf) {
      if (!whatIf.parsed.ok) {
        await this.show();
        return false;
      }
      await openAppAhead(this.plugin, whatIfApp(this.plugin, whatIf.parsed.target), whatIf.line);
      return true;
    }
    this.input.disabled = true;
    try {
      // What it did is told once, here, with Undo, not also by the run.
      const result = await bg.capture(line, undefined, true);
      if (!result.ok) {
        if (!result.parsed.ok) await this.show();
        return false;
      }
      capturedNotice(this.plugin, line, result.told, result.entryId);
      return true;
    } finally {
      this.input.disabled = false;
    }
  }
}

/**
 * "Do…": one line that runs any app's shortcut with its values (`spend 14.5 food lunch`), shown with
 * what it would do (see LineBox). Enter runs it.
 */
class CaptureModal extends Modal {
  private plugin: GizmoPlugin;
  private box: LineBox | undefined;
  /** A line to start from, typing going in at `cursor`: an ask's line that still needs a value. */
  private start: { line: string; cursor: number } | undefined;

  constructor(plugin: GizmoPlugin, start?: { line: string; cursor: number }) {
    super(plugin.app);
    this.plugin = plugin;
    this.start = start;
  }

  onOpen(): void {
    this.titleEl.setText("Do…");
    this.modalEl.addClass("gz-capture-modal");
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share gz-capture" });
    const box = new LineBox(this.plugin, el, "spend 14.5 food lunch, or ? spend this month", () => void this.submit(), (at) => new AskPane(this.plugin, at, () => this.close()));
    this.box = box;
    el.createDiv({ cls: "gz-muted", text: "Enter runs it · ? asks your kinds · Tab completes · Esc closes" });
    if (this.start) box.input.value = this.start.line;
    void box.show();
    box.input.focus();
    if (this.start) box.input.setSelectionRange(this.start.cursor, this.start.cursor);
  }

  onClose(): void {
    this.box?.stop();
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const box = this.box;
    if (!box) return;
    const ran = await box.submit();
    if (ran) this.close();
    else box.input.focus();
  }
}

/** What a `;;` line offers: to run it (with what that would do), a word to complete it with, or why it can't run. */
type LineSuggestion =
  | { kind: "run"; parsed: Parsed & { ok: true }; effects: string[] }
  | { kind: "complete"; text: string; hint?: string }
  | { kind: "problem"; message: string };

/** How far up a note is read to tell whether a line sits inside a fenced code block. */
const MAX_FENCE_LINES = 2000;

/** Whether a line is inside a ``` or ~~~ code block, where `;;` may be a comment. */
function inCode(editor: Editor, line: number): boolean {
  let open = false;
  for (let i = Math.max(0, line - MAX_FENCE_LINES); i < line; i++) if (/^\s*(```|~~~)/.test(editor.getLine(i))) open = !open;
  return open;
}

/**
 * A line starting `;;` in any note is a capture line: `;; spend 14.5 food lunch`. It offers
 * itself only once its first word is, or starts, a shortcut's name, so Enter on any other line
 * is left alone. Choosing it runs the line and puts a receipt in its place, linking to what it
 * changed in the activity log.
 */
class CaptureSuggest extends EditorSuggest<LineSuggestion> {
  private plugin: GizmoPlugin;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const text = editor.getLine(cursor.line);
    const line = captureLine(text);
    const index = this.plugin.background?.captureIndex();
    if (line === undefined || !index || cursor.ch < text.length - text.trimStart().length + 2) return null;
    const first = line.trimStart().split(/\s/)[0].toLowerCase();
    const known = index.names.has(first) || index.clashes.has(first);
    const starts = !/\s/.test(line.trimStart()) && [...index.names.keys()].some((n) => n.startsWith(first));
    if (!known && !starts) return null;
    if (inCode(editor, cursor.line)) return null;
    return { start: { line: cursor.line, ch: 0 }, end: { line: cursor.line, ch: text.length }, query: line };
  }

  async getSuggestions(context: EditorSuggestContext): Promise<LineSuggestion[]> {
    const bg = this.plugin.background;
    if (!bg) return [];
    const { parsed, effects } = await bg.previewLine(context.query);
    if (parsed.ok) return [{ kind: "run", parsed, effects: effects ?? [] }];
    if (parsed.completions.length) return parsed.completions.slice(0, 12).map((text) => ({ kind: "complete", text, hint: parsed.next }));
    return [{ kind: "problem", message: parsed.next ? `${parsed.error} · ${parsed.next}` : parsed.error }];
  }

  renderSuggestion(s: LineSuggestion, el: HTMLElement): void {
    if (s.kind === "run") {
      el.createDiv({ cls: "gz-suggest-key", text: `Run in ${runs(s.parsed)}` });
      for (const line of s.effects) el.createDiv({ cls: "gz-suggest-hint", text: line });
    } else if (s.kind === "complete") {
      el.createDiv({ cls: "gz-suggest-key", text: s.text });
      if (s.hint) el.createDiv({ cls: "gz-suggest-hint", text: s.hint });
    } else {
      el.createDiv({ cls: "gz-suggest-hint gz-error-text", text: s.message });
    }
  }

  selectSuggestion(s: LineSuggestion): void {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start, end, query } = ctx;
    // A line that can't run yet is only told why; Enter goes on as it would without the hint.
    if (s.kind === "problem") {
      editor.replaceRange("\n", end);
      editor.setCursor({ line: end.line + 1, ch: 0 });
      return;
    }
    if (s.kind === "complete") {
      const text = editor.getLine(start.line);
      const prefix = text.slice(0, text.length - query.length);
      const next = `${prefix}${completed(query, s.text)}`;
      editor.replaceRange(next, start, end);
      editor.setCursor({ line: start.line, ch: next.length });
      return;
    }
    void this.runLine(editor, start.line, query.trim(), s.parsed.target.app);
  }

  private async runLine(editor: Editor, at: number, line: string, app: string): Promise<void> {
    const result = await this.plugin.background?.capture(line);
    if (!result?.ok) return;
    // The line may have moved while it ran; it is replaced only where it still is.
    const where = editor.getLine(at) !== undefined && captureLine(editor.getLine(at))?.trim() === line ? at
      : [...Array(editor.lineCount()).keys()].find((i) => captureLine(editor.getLine(i))?.trim() === line);
    if (where === undefined) return;
    const text = editor.getLine(where);
    const id = await this.rowOf(result.entryId);
    // A line that saved one row stays as that row (see row-lines.ts); any other gets a receipt.
    const parsed = result.parsed;
    const written = id !== undefined && parsed.ok
      ? rowLineText({ indent: /^\s*/.exec(text)![0], live: true, line: frozen(line, parsed.plan ? undefined : parsed.at), id })
      : receipt(line, app, new Date(), result.entryId);
    editor.replaceRange(written, { line: where, ch: 0 }, { line: where, ch: text.length });
    const path = this.plugin.app.workspace.getActiveFile()?.path;
    if (id !== undefined && path) this.plugin.rowLines?.seen(path, editor.getValue());
  }

  /** The id of the one row a run saved, from its entry in the activity log; undefined when it saved none, or several. */
  private async rowOf(entryId: string | undefined): Promise<string | undefined> {
    const entry = entryId === undefined ? undefined : await this.plugin.activity.get(entryId);
    const added = entry?.changes.filter((c) => c.kind === "row-added") ?? [];
    return added.length === 1 && added[0].kind === "row-added" ? added[0].id : undefined;
  }
}

/** The link a phone's shortcut or a launcher opens with a capture line after `line=`. */
export function captureLinkOf(key: string): string {
  return `obsidian://gizmo?key=${encodeURIComponent(key)}&line=`;
}

/**
 * "Copy capture link": which names a new key may run without asking (all of them to start with),
 * then copies the link that sends a line with it.
 */
class CaptureLinkModal extends Modal {
  private plugin: GizmoPlugin;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Copy capture link");
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share gz-capture" });
    const index = this.plugin.background?.captureIndex();
    const targets = [...(index?.names.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (!targets.length) {
      el.createEl("p", { cls: "gz-muted", text: "No shortcut has a name to type yet: add alias: or shortcut: to a form, button or checklist." });
      return;
    }
    el.createEl("p", { text: "A phone's shortcut or a launcher opens this link with a line after line=, URL-encoded. Lines for the names ticked here run without asking; any other line asks first." });
    const picked = new Set(targets.map((t) => t.name));
    const list = el.createDiv({ cls: "gz-capture-names" });
    for (const t of targets) {
      const label = list.createEl("label", { cls: "gz-input" });
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = true;
      box.addEventListener("change", () => (box.checked ? picked.add(t.name) : picked.delete(t.name)));
      label.createSpan({ text: ` ${t.name}` });
      label.createSpan({ cls: "gz-muted", text: ` · ${t.app}: ${t.label}` });
    }
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { cls: "mod-cta", text: "Copy link" }).addEventListener("click", handler(async () => {
      const key = await this.plugin.newCaptureKey(targets.filter((t) => picked.has(t.name)));
      copyText(captureLinkOf(key), () => { new Notice(`Copied a capture link for ${picked.size ? [...picked].sort().join(", ") : "no names (every line asks)"}. Revoke it on the automation map.`); });
      this.close();
    }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** "Do…" and `;;` lines: run any app's shortcut by typing its name and values. */
/** Opens Do… with a line typed in, typing going in at `cursor`. */
export function openCaptureWith(plugin: GizmoPlugin, line: string, cursor: number): void {
  new CaptureModal(plugin, { line, cursor }).open();
}

export function registerCaptureCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "capture",
    name: "Do…",
    callback: () => new CaptureModal(plugin).open(),
  });
  plugin.registerEditorSuggest(new CaptureSuggest(plugin));
  plugin.addCommand({
    id: "copy-capture-link",
    name: "Copy capture link",
    callback: () => new CaptureLinkModal(plugin).open(),
  });
}
