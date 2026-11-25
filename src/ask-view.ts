import { FuzzySuggestModal, Notice, Platform, parseYaml, type App, type TFile } from "obsidian";
import { AppController, type AppEnv } from "./app.ts";
import { addToApp, askHelp, compileAsk, panelEmbed, panelYaml, parseAsk, type AskKind } from "./ask.ts";
import { handler } from "./handler.ts";
import { copyText, obsidianAppEnv, vaultFrontmatter, vaultNotes } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { basename, isApp } from "./store.ts";

/** What the line under an ask says: what it asks, or why it can't, and what could be typed next. */
export interface AskShown {
  hint: string;
  error: boolean;
  completions: string[];
}

const READ_ONLY = "an ask only reads";

/**
 * The app an answer is drawn in: the kind's rows through the data layer, and nothing else. It runs
 * without a grant prompt only while all it asks for is reading that kind; it can't write a note,
 * keep a row, log, run another app or reach out of Obsidian (pictures are drawn as their address).
 */
function askEnv(plugin: GizmoPlugin, kindFile: TFile, reads: string): AppEnv {
  const refuse = () => Promise.reject(new Error(READ_ONLY));
  return {
    ...obsidianAppEnv(plugin, undefined, kindFile),
    isGranted: (_key, wanted) => wanted.length === 1 && wanted[0] === reads,
    granted: () => undefined,
    grant: refuse,
    writeFrontmatter: refuse,
    updateFrontmatter: refuse,
    appendLine: refuse,
    createNote: refuse,
    setTaskDone: refuse,
    store: undefined,
    addPanels: undefined,
    log: undefined,
    undo: undefined,
    trigger: undefined,
    opened: undefined,
    tryFirst: undefined,
    asks: undefined,
    preview: true,
  };
}

/** The vault's apps, to add an answer to. */
class AppChooser extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private choose: (file: TFile) => void;

  constructor(app: App, files: TFile[], choose: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.choose = choose;
    this.setPlaceholder("Add the answer to an app: choose one");
    this.emptyStateText = "No apps in this vault yet";
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path.replace(/\.md$/i, "");
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

/**
 * Under Do…'s line, while it starts with `?`: the answer drawn as the panel it stands for, the
 * YAML of that panel, and Keep (add it to an app, copy the YAML or an embed); for a bare `?`, the
 * grammar and the kinds. Nothing is written until the panel is added to an app.
 */
export class AskPane {
  private plugin: GizmoPlugin;
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
  constructor(plugin: GizmoPlugin, parent: HTMLElement, done: () => void) {
    this.plugin = plugin;
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
    const bg = this.plugin.background;
    if (!bg) return { hint: "Gizmo is starting", error: true, completions: [] };
    this.el.removeClass("gz-off");
    this.el.closest(".modal")?.addClass("gz-asking");
    // The kinds and the values their rows hold, read once for the window.
    this.kinds ??= bg.askKinds();
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
    const c = compileAsk(r.kind, r.panel, { notes: vaultNotes(this.plugin.app), now });
    if (!c.spec) return this.stale(c.errors.join("; "), []);
    const file = this.plugin.app.vault.getFileByPath(r.kind.path);
    if (!file) return this.stale(`can't find ${r.kind.path}`, []);
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
      const env = askEnv(this.plugin, file, `kind:${r.kind.path}`);
      this.controller = new AppController(this.answer, c.path, env, { kind: "embed", grantKey: `ask:${r.kind.path}`, hostPath: c.path, definition: () => this.fm });
      this.controller.load();
      window.setTimeout(() => this.controller?.resize(), 50);
    }
    return { hint: `Asks ${basename(r.kind.path)}: reads its rows, saves nothing. ${modKey()}Enter adds the answer to an app.`, error: false, completions: [] };
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
    copyText(text(current.panel), () => {
      new Notice(`Copied ${what}`);
      button.setText("Copied");
      window.setTimeout(() => button.setText(label), 1000);
    });
  }

  /** Keep: pick an app, and the answer becomes its last panel, as Insert panel adds one; the app then asks to read the kind. */
  keep(): void {
    const current = this.current;
    if (!current) return;
    const app = this.plugin.app;
    const frontmatter = vaultFrontmatter(app);
    const apps = app.vault.getMarkdownFiles().filter((f) => isApp(frontmatter(f.path))).sort((a, b) => a.path.localeCompare(b.path));
    new AppChooser(app, apps, handler(async (file: TFile) => {
      const { kind, panel } = current;
      // The app's own place decides what `[[Spend]]` finds from there.
      const name = basename(kind.path);
      const source = app.metadataCache.getFirstLinkpathDest(name, file.path)?.path === kind.path ? `[[${name}]]` : `[[${kind.path.replace(/\.md$/i, "")}]]`;
      let refusal: string | undefined;
      await app.vault.process(file, (text) => {
        const found = addToApp(text, { ...panel, source }, { path: file.path, notes: vaultNotes(app), parse: (yaml) => parseYaml(yaml) as unknown, now: new Date() });
        if ("refusal" in found) {
          refusal = found.refusal;
          return text;
        }
        return found.text;
      });
      if (refusal) return void new Notice(`Couldn't add it to ${file.basename}: ${refusal}`);
      new Notice(`Added “${String(panel.title)}” to ${file.basename}`);
      this.done();
      await app.workspace.openLinkText(file.path, "", false);
    })).open();
  }
}

const modKey = () => (Platform.isMacOS ? "⌘" : "Ctrl ");
