/**
 * Under Do…'s line, while it starts with `?`: the answer drawn as the panel it stands for, the YAML
 * of that panel, and Keep (add it to an app, copy the YAML or an embed); for a bare `?`, the grammar
 * and the kinds. Nothing is written until the panel is added to an app. On any host the runtime runs
 * in: the host gives the app's environment, a way to pick an app, and how it tells and copies.
 */
import type { AppEnv } from "./app.ts";
import { AppController } from "./app.ts";
import { addAnswer, appsToAddTo, askEnvOf, askHelp, compileAsk, panelEmbed, panelYaml, parseAsk, type AskKind } from "./ask.ts";
import { handler } from "./handler.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { basename } from "./store.ts";

/** What the line under an ask says: what it asks, or why it can't, and what could be typed next. */
export interface AskShown {
  hint: string;
  error: boolean;
  completions: string[];
}

/** What only the host of the pane can do. */
export interface AskHost {
  rt: GizmoRuntime;
  /** An app's environment on the note at `path` (the kind's), which an answer is drawn in. */
  env(path: string): AppEnv;
  /** Lets the person pick one of these apps to add the answer to. */
  chooseApp(paths: string[], choose: (path: string) => void): void;
  notify(message: string): void;
  /** Puts text on the clipboard, then calls `done`. */
  copy(text: string, done: () => void): void;
  /** Opens an app. */
  open(path: string): void;
  /** How the modifier key is written on this computer: "⌘" or "Ctrl ". */
  modKey: string;
}

export class AskPane {
  private host: AskHost;
  private el: HTMLElement;
  private help: HTMLElement;
  private body: HTMLElement;
  private answer: HTMLElement;
  private yaml: HTMLElement;
  private buttons: HTMLButtonElement[];
  private kinds: Promise<AskKind[]> | undefined;
  private controller: AppController | undefined;
  private shownKind: string | undefined;
  /** The made-up app the answer is drawn as, read again by its controller. */
  private fm: Record<string, unknown> = {};
  private current: { kind: AskKind; panel: Record<string, unknown> } | undefined;
  private done: () => void;

  /** `done` closes the window once the answer is added to an app. */
  constructor(host: AskHost, parent: HTMLElement, done: () => void) {
    this.host = host;
    this.done = done;
    this.el = parent.createDiv({ cls: "gz-ask gz-off" });
    this.help = this.el.createEl("ul", { cls: "gz-ask-help" });
    this.body = this.el.createDiv({ cls: "gz-ask-body" });
    this.answer = this.body.createDiv({ cls: "gz-ask-answer" });
    const side = this.body.createDiv({ cls: "gz-ask-side" });
    side.createDiv({ cls: "gz-label", text: "The panel it stands for" });
    this.yaml = side.createEl("pre", { cls: "gz-example gz-ask-yaml" });
    const row = side.createDiv({ cls: "gz-actions" });
    const add = row.createEl("button", { cls: "mod-cta", text: "Add to an app…" });
    add.addEventListener("click", () => this.keep());
    const yaml = row.createEl("button", { text: "Copy YAML" });
    yaml.addEventListener("click", () => this.copy(yaml, "Copy YAML", (p) => panelYaml(p), "the panel's YAML; paste it under panels: in an app"));
    const embed = row.createEl("button", { text: "Copy embed" });
    embed.addEventListener("click", () => this.copy(embed, "Copy embed", (p) => panelEmbed(p), "an embed of the answer; paste it into any note"));
    this.buttons = [add, yaml, embed];
  }

  /** Reads an ask line (the text after `?`) and shows its answer, or what keeps it from one. */
  async show(text: string): Promise<AskShown> {
    const rt = this.host.rt;
    this.el.removeClass("gz-off");
    this.el.closest(".modal")?.addClass("gz-asking");
    // The kinds and the values their rows hold, read once for the window.
    this.kinds ??= rt.background.askKinds();
    const kinds = await this.kinds;
    const now = new Date();
    const r = parseAsk(text, kinds, now);
    if (!r.ok && r.help) {
      this.help.empty();
      for (const line of askHelp(kinds)) this.help.createEl("li", { text: line });
      this.help.removeClass("gz-off");
      this.body.addClass("gz-off");
      return { hint: "Ask a question of your kinds; nothing is saved", error: false, completions: r.completions };
    }
    this.help.addClass("gz-off");
    if (!r.ok) return this.stale(r.error, r.completions);
    const c = compileAsk(r.kind, r.panel, { notes: rt.host.notes, now });
    if (!c.spec) return this.stale(c.errors.join("; "), []);
    if (!rt.host.exists(r.kind.path)) return this.stale(`can't find ${r.kind.path}`, []);
    this.current = { kind: r.kind, panel: r.panel };
    this.fm = c.fm;
    this.yaml.setText(panelYaml(r.panel));
    this.body.removeClass("gz-off");
    this.body.removeClass("is-stale");
    for (const b of this.buttons) b.disabled = false;
    if (this.controller && this.shownKind === r.kind.path) this.controller.recheck();
    else {
      this.controller?.dispose();
      this.answer.empty();
      this.shownKind = r.kind.path;
      const env = askEnvOf(this.host.env(r.kind.path), `kind:${r.kind.path}`);
      this.controller = new AppController(this.answer, c.path, env, { kind: "embed", grantKey: `ask:${r.kind.path}`, hostPath: c.path, definition: () => this.fm });
      this.controller.load();
      window.setTimeout(() => this.controller?.resize(), 50);
    }
    return { hint: `Asks ${basename(r.kind.path)}: reads its rows, saves nothing. ${this.host.modKey}Enter adds the answer to an app.`, error: false, completions: [] };
  }

  /** The answer drawn last stays, faded, under what is wrong with the line now; Keep waits for a good one. */
  private stale(error: string, completions: string[]): AskShown {
    this.body.addClass("is-stale");
    if (!this.controller) this.body.addClass("gz-off");
    for (const b of this.buttons) b.disabled = true;
    this.current = undefined;
    return { hint: error, error: true, completions };
  }

  /** Takes the pane away, for a line that doesn't start with `?`. */
  hide(): void {
    this.el.addClass("gz-off");
    this.el.closest(".modal")?.removeClass("gz-asking");
  }

  dispose(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }

  private copy(button: HTMLButtonElement, label: string, text: (panel: Record<string, unknown>) => string, what: string): void {
    const current = this.current;
    if (!current) return;
    this.host.copy(text(current.panel), () => {
      this.host.notify(`Copied ${what}`);
      button.setText("Copied");
      window.setTimeout(() => button.setText(label), 1000);
    });
  }

  /** Keep: pick an app, and the answer becomes its last panel, as Insert panel adds one; the app then asks to read the kind. */
  keep(): void {
    const current = this.current;
    if (!current) return;
    const rt = this.host.rt;
    this.host.chooseApp(appsToAddTo(rt), handler(async (path: string) => {
      const { kind, panel } = current;
      const { refusal } = await addAnswer(rt, path, kind.path, panel);
      if (refusal) return this.host.notify(`Couldn't add it to ${basename(path)}: ${refusal}`);
      this.host.notify(`Added “${String(panel.title)}” to ${basename(path)}`);
      this.done();
      this.host.open(path);
    }));
  }
}
