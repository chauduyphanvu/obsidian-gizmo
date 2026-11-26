import {
  EditorSuggest, Modal, Notice, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo,
} from "obsidian";
import { handler } from "./handler.ts";
import { captureLinkOf } from "./links.ts";
import { copyText } from "./clipboard.ts";
import { captureLine, completed, receipt, type Parsed } from "./capture.ts";
import { capturedText, runsText, singleRowAdded } from "./capture-run.ts";
import { frozen, rowLineText } from "./row-lines.ts";
import { obsidianAskHost } from "./ask-view.ts";
import { DoPane } from "./do-pane.ts";
import type { LineHost } from "./line-box.ts";
import { orderApps } from "./open-app.ts";
import type GizmoPlugin from "./main.ts";
import { openAppAhead } from "./past-views.ts";
import { AppView } from "./view.ts";

/** A notice saying a capture line ran, with Undo for what it changed. */
export function capturedNotice(plugin: GizmoPlugin, line: string, told: string | undefined, entryId: string | undefined): void {
  const text = capturedText(line, told);
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
      new Notice(await plugin.runtime.undoById(entryId));
    }));
  });
  new Notice(frag, 8000);
}

/** Lines on Obsidian: the app in the active tab, a what-if in a tab of its own, and notices with Undo. */
export function obsidianLineHost(plugin: GizmoPlugin): LineHost {
  return {
    rt: plugin.runtime,
    openApp: () => plugin.app.workspace.getActiveViewOfType(AppView)?.file?.path,
    ahead: (app, line) => openAppAhead(plugin, app, line),
    told: (text, entryId) => {
      if (entryId) undoNotice(plugin, text, entryId);
      else new Notice(text);
    },
  };
}

/** Gizmo's own windows Do… opens by name (see registerCaptureCommand). */
let doActions: () => { name: string; run(): void }[] = () => [];

/** "Do…" in a window of Obsidian's (see DoPane). */
class CaptureModal extends Modal {
  private plugin: GizmoPlugin;
  private pane: DoPane | undefined;
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
    const plugin = this.plugin;
    this.pane = new DoPane(el, {
      ...obsidianLineHost(plugin),
      ask: obsidianAskHost(plugin),
      apps: () => orderApps(plugin.runtime.background.list().map((a) => ({ name: a.name, description: a.description, path: a.path })), plugin.app.workspace.getLastOpenFiles(), new Map()),
      actions: () => doActions(),
      open: (path) => void plugin.app.workspace.openLinkText(path, "", false),
      close: () => this.close(),
    }, this.start);
  }

  onClose(): void {
    this.pane?.stop();
    this.contentEl.empty();
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
    const index = this.plugin.runtime.background.captureIndex();
    if (line === undefined || !index || cursor.ch < text.length - text.trimStart().length + 2) return null;
    const first = line.trimStart().split(/\s/)[0].toLowerCase();
    const known = index.names.has(first) || index.clashes.has(first);
    const starts = !/\s/.test(line.trimStart()) && [...index.names.keys()].some((n) => n.startsWith(first));
    if (!known && !starts) return null;
    if (inCode(editor, cursor.line)) return null;
    return { start: { line: cursor.line, ch: 0 }, end: { line: cursor.line, ch: text.length }, query: line };
  }

  async getSuggestions(context: EditorSuggestContext): Promise<LineSuggestion[]> {
    const { parsed, effects } = await this.plugin.runtime.background.previewLine(context.query);
    if (parsed.ok) return [{ kind: "run", parsed, effects: effects ?? [] }];
    if (parsed.completions.length) return parsed.completions.slice(0, 12).map((text) => ({ kind: "complete", text, hint: parsed.next }));
    return [{ kind: "problem", message: parsed.next ? `${parsed.error} · ${parsed.next}` : parsed.error }];
  }

  renderSuggestion(s: LineSuggestion, el: HTMLElement): void {
    if (s.kind === "run") {
      el.createDiv({ cls: "gz-suggest-key", text: `Run in ${runsText(s.parsed, new Date())}` });
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
    const result = await this.plugin.runtime.background.capture(line);
    if (!result?.ok) return;
    // The line may have moved while it ran; it is replaced only where it still is.
    const where = editor.getLine(at) !== undefined && captureLine(editor.getLine(at))?.trim() === line ? at
      : [...Array(editor.lineCount()).keys()].find((i) => captureLine(editor.getLine(i))?.trim() === line);
    if (where === undefined) return;
    const text = editor.getLine(where);
    const id = await singleRowAdded(this.plugin.runtime, result.entryId);
    // A line that saved one row stays as that row (see row-lines.ts); any other gets a receipt.
    const parsed = result.parsed;
    const written = id !== undefined && parsed.ok
      ? rowLineText({ indent: /^\s*/.exec(text)![0], live: true, line: frozen(line, parsed.plan ? undefined : parsed.at), id })
      : receipt(line, app, new Date(), result.entryId);
    editor.replaceRange(written, { line: where, ch: 0 }, { line: where, ch: text.length });
    const path = this.plugin.app.workspace.getActiveFile()?.path;
    if (id !== undefined && path) this.plugin.rowLines?.seen(path, editor.getValue());
  }

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
    const index = this.plugin.runtime.background.captureIndex();
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
      const key = await this.plugin.runtime.newCaptureKey(targets.filter((t) => picked.has(t.name)));
      copyText(captureLinkOf(key), () => { new Notice(`Copied a capture link for ${picked.size ? [...picked].sort().join(", ") : "no names (every line asks)"}. Revoke it on the automation map.`); });
      this.close();
    }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** "Do…" and `;;` lines: run any app's shortcut by typing its name and values. */
/** Opens Do…. */
export function openCapture(plugin: GizmoPlugin): void {
  new CaptureModal(plugin).open();
}

/** Opens Do… with a line typed in, typing going in at `cursor`. */
export function openCaptureWith(plugin: GizmoPlugin, line: string, cursor: number): void {
  new CaptureModal(plugin, { line, cursor }).open();
}

/** `actions`: Gizmo's own windows Do… opens by name. */
export function registerCaptureCommand(plugin: GizmoPlugin, actions: () => { name: string; run(): void }[] = () => []): void {
  doActions = actions;
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
