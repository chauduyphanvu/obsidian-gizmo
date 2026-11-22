import {
  EditorSuggest, Modal, Notice, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo,
} from "obsidian";
import { handler } from "./handler.ts";
import { undoMessage } from "./activity.ts";
import { copyText } from "./host.ts";
import { captureLine, completed, parseLine, receipt, whenText, type Parsed } from "./capture.ts";
import type GizmoPlugin from "./main.ts";

/** What a line that can run runs, and for when if not now: `Budget: Spent something at Thu Nov 19, 13:00`. */
function runs(parsed: Parsed & { ok: true }): string {
  return `${parsed.target.app}: ${parsed.target.label}${parsed.at ? ` at ${whenText(parsed.at, new Date())}` : ""}`;
}

/** A notice saying a capture line ran, with Undo for what it changed. */
export function capturedNotice(plugin: GizmoPlugin, line: string, entryId: string | undefined): void {
  if (!entryId) return;
  const frag = createFragment((f) => {
    f.createSpan({ text: `Ran “${line}”. ` });
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
 * "Do…": one line that runs any app's shortcut with its values (`spend 14.5 food lunch`). Under it,
 * what comes next or what's wrong, completions for the last word (Tab takes the first), and what
 * running it would change, worked out by a dry run. Enter runs it.
 */
class CaptureModal extends Modal {
  private plugin: GizmoPlugin;
  private input!: HTMLInputElement;
  private hint!: HTMLElement;
  private chips!: HTMLElement;
  private effects!: HTMLElement;
  private parsed: Parsed | undefined;
  private run = 0;
  private timer = 0;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Do…");
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share gz-capture" });
    this.input = el.createEl("input", { cls: "gz-capture-input", type: "text", attr: { placeholder: "spend 14.5 food lunch", spellcheck: "false", autocapitalize: "off" } });
    this.hint = el.createDiv({ cls: "gz-capture-hint gz-muted" });
    this.chips = el.createDiv({ cls: "gz-capture-chips" });
    this.effects = el.createEl("ul", { cls: "gz-effects" });
    el.createDiv({ cls: "gz-muted", text: "Enter runs it · Tab completes · Esc closes" });
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        // What was typed since the last preview counts: the line is read again as it is now.
        const bg = this.plugin.background;
        const now = bg ? parseLine(this.input.value, bg.captureIndex(), new Date()) : undefined;
        const first = now && !now.ok ? now.completions[0] : undefined;
        if (first === undefined) return;
        e.preventDefault();
        this.take(first);
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    void this.show();
    this.input.focus();
  }

  onClose(): void {
    window.clearTimeout(this.timer);
    this.contentEl.empty();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.show(), 120);
  }

  private take(completion: string): void {
    this.input.value = completed(this.input.value, completion);
    this.input.focus();
    void this.show();
  }

  private async show(): Promise<void> {
    const bg = this.plugin.background;
    if (!bg) return;
    const run = ++this.run;
    const { parsed, effects } = await bg.previewLine(this.input.value);
    if (run !== this.run) return;
    this.parsed = parsed;
    this.hint.empty();
    this.hint.toggleClass("gz-error-text", !parsed.ok && this.input.value.trim() !== "");
    if (!parsed.ok && this.input.value.trim() !== "") this.hint.setText(parsed.next ? `${parsed.error} · ${parsed.next}` : parsed.error);
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

  private async submit(): Promise<void> {
    const bg = this.plugin.background;
    const line = this.input.value.trim();
    if (!bg || !line) return;
    this.input.disabled = true;
    try {
      const result = await bg.capture(line);
      if (!result.ok) {
        // A line it couldn't read is shown where it was typed; one that ran and failed has said why in a notice.
        if (!result.parsed.ok) await this.show();
        return;
      }
      capturedNotice(this.plugin, line, result.entryId);
      this.close();
    } finally {
      this.input.disabled = false;
      this.input.focus();
    }
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
    editor.replaceRange(receipt(line, app, new Date(), result.entryId), { line: where, ch: 0 }, { line: where, ch: text.length });
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
