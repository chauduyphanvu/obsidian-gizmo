import { Modal, Notice } from "obsidian";
import { undoMessage } from "./activity.ts";
import { completed, type Parsed } from "./capture.ts";
import type GizmoPlugin from "./main.ts";

/** A notice saying a capture line ran, with Undo for what it changed. */
export function capturedNotice(plugin: GizmoPlugin, line: string, entryId: string | undefined): void {
  if (!entryId) return;
  const frag = createFragment((f) => {
    f.createSpan({ text: `Ran “${line}”. ` });
    const undo = f.createEl("a", { text: "Undo", href: "#" });
    undo.addEventListener("click", async (e) => {
      e.preventDefault();
      const entry = await plugin.activity.get(entryId);
      if (!entry) return void new Notice("That change is no longer in the activity log");
      new Notice(undoMessage(await plugin.undo(entry)));
    });
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
        const first = this.parsed && !this.parsed.ok ? this.parsed.completions[0] : undefined;
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
    else if (parsed.ok) this.hint.setText(`${parsed.target.app}: ${parsed.target.label}${parsed.next ? ` · next, ${parsed.next}` : ""}`);
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

/** "Do…": run any app's shortcut by typing its name and values. */
export function registerCaptureCommand(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "capture",
    name: "Do…",
    callback: () => new CaptureModal(plugin).open(),
  });
}
