import { Modal, Notice, type App } from "obsidian";
import { toBundle, type BundleNote, type InstallPreview } from "./bundle.ts";
import { installAndOpen } from "./gallery-command.ts";
import { copyText } from "./clipboard.ts";
import { notesToShare, planShared, previewShared, readShared, sharedLink } from "./install.ts";
import type GizmoPlugin from "./main.ts";
import { tryBundle } from "./try-modal.ts";
import { basename } from "./store.ts";

/** Shows the shared text before it leaves: every line of it travels, the note's own text included. */
class ShareModal extends Modal {
  private name: string;
  private notes: BundleNote[];
  private text: string;
  private warnings: string[];

  constructor(app: App, name: string, notes: BundleNote[], text: string, warnings: string[]) {
    super(app);
    this.name = name;
    this.notes = notes;
    this.text = text;
    this.warnings = warnings;
  }

  onOpen(): void {
    this.titleEl.setText(`Share ${this.name}`);
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share" });
    const names = this.notes.map((n) => n.name);
    el.createEl("p", {
      text: names.length > 1 ? `It takes ${names.slice(1).join(", ")} along with ${names[0]}.` : `It's ${names[0]} on its own.`,
    });
    for (const w of this.warnings) el.createEl("p", { cls: "gz-warning-text", text: w });
    el.createEl("p", {
      cls: "gz-muted",
      text: "Whoever gets this can read every line below, the notes' own text included. Your saved data and other notes aren't in it.",
    });
    const area = el.createEl("textarea", { cls: "gz-share-text", attr: { readonly: "", rows: "14", spellcheck: "false" } });
    area.value = this.text;
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { cls: "mod-cta", text: "Copy" }).addEventListener("click", () => {
      copyText(this.text, () => { new Notice(`Copied ${this.name}; paste it in a gist or a message to share it`); this.close(); });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Reads shared text or a link, shows what installing it would do, and installs it on a click. */
class InstallModal extends Modal {
  private plugin: GizmoPlugin;
  private start: string;
  private notes: BundleNote[] = [];
  private preview: InstallPreview | undefined;
  private output!: HTMLElement;
  private installButton!: HTMLButtonElement;
  private tryButton!: HTMLButtonElement;
  private folder = "";

  constructor(plugin: GizmoPlugin, start = "") {
    super(plugin.app);
    this.plugin = plugin;
    this.start = start;
  }

  onOpen(): void {
    this.titleEl.setText("Install an app");
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share" });
    el.createEl("p", { text: "Paste an app someone shared, or a link to one (a gist, or a note's raw text)." });
    const area = el.createEl("textarea", { cls: "gz-share-text", attr: { rows: "6", spellcheck: "false", placeholder: "https://… or the shared text" } });
    area.value = this.start;
    this.output = el.createDiv({ cls: "gz-install-preview" });
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Preview" }).addEventListener("click", () => void this.read(area.value));
    this.tryButton = row.createEl("button", { text: "Try it" });
    this.tryButton.disabled = true;
    this.tryButton.addEventListener("click", () => tryBundle(this.plugin, this.notes, this.folder, () => this.install()));
    this.installButton = row.createEl("button", { cls: "mod-cta", text: "Install" });
    this.installButton.disabled = true;
    this.installButton.addEventListener("click", () => void this.install());
    // A link fills the box but fetches nothing until Preview: any web page can send an install link.
    const { url } = sharedLink(this.start);
    if (url) this.say(`Press Preview to fetch ${new URL(url).hostname}`);
    else if (this.start) void this.read(this.start);
    else area.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private say(text: string, cls = "gz-muted"): void {
    this.output.empty();
    this.output.createEl("p", { cls, text });
    this.installButton.disabled = true;
    this.tryButton.disabled = true;
    this.preview = undefined;
  }

  private async read(input: string): Promise<void> {
    if (!input.trim()) return this.say("Paste something first");
    const rt = this.plugin.runtime;
    const got = await readShared(input, (url, headers) => rt.dataLayer.host.fetch(url, headers), (yaml) => rt.dataLayer.host.parseYaml(yaml), (host) => this.say(`Fetching ${host}…`));
    if ("error" in got) return this.say(got.error, "gz-error-text");
    this.notes = got.notes;
    const previewed = await previewShared(rt, got.notes);
    if ("error" in previewed) return this.say(previewed.error, "gz-error-text");
    this.folder = previewed.folder;
    this.show(previewed.preview);
  }

  private show(p: InstallPreview): void {
    this.preview = p;
    this.output.empty();
    this.output.createEl("h4", { text: p.name });
    if (p.about) this.output.createEl("p", { text: p.about });
    if ("refusal" in p.plan) {
      this.output.createEl("p", { cls: "gz-error-text", text: `${p.plan.refusal}; rename or move that note to install this.` });
    } else {
      const created = p.plan.create.map((n) => basename(n.path));
      this.output.createEl("p", { text: `Creates ${created.join(", ")}${p.plan.reuse.length ? `, and uses your ${p.plan.reuse.join(", ")}` : ""}.` });
    }
    for (const extra of p.extras) this.output.createEl("p", { cls: "gz-warning-text", text: `${extra}.` });
    if (p.errors.length) {
      this.output.createEl("p", { cls: "gz-error-text", text: "Its own check says:" });
      const ul = this.output.createEl("ul");
      for (const e of p.errors) ul.createEl("li", { text: e });
    }
    if (p.policy?.violations.length) {
      this.output.createEl("p", { cls: "gz-error-text", text: "Checked against your data policy: it would be blocked, as it sends data where your policy keeps it from going:" });
      const ul = this.output.createEl("ul");
      for (const v of p.policy.violations) ul.createEl("li", { text: v });
    } else if (p.policy) {
      this.output.createEl("p", { text: `Checked against your data policy: it fits${p.policy.covered.length ? `, and your policy lets it ${p.policy.covered.join("; ")} without asking` : ""}.` });
    }
    const kind = p.kind === "app" ? "When you open it, it will ask your OK to:" : "Where it's used, it will ask your OK to:";
    if (p.asks.length) {
      this.output.createEl("p", { text: kind });
      const ul = this.output.createEl("ul");
      for (const a of p.asks) ul.createEl("li", { text: a });
    } else {
      this.output.createEl("p", { text: "It asks for nothing: it only keeps its own data beside it." });
    }
    this.installButton.disabled = "refusal" in p.plan;
    this.tryButton.disabled = p.kind !== "app";
  }

  private async install(): Promise<void> {
    const p = this.preview;
    if (!p || "refusal" in p.plan) return;
    if (await installAndOpen(this.plugin, await planShared(this.plugin.runtime, this.notes), p.name)) this.close();
  }
}

/** Opens the install window, reading `start` (a link or shared text) right away when given. */
export function openInstall(plugin: GizmoPlugin, start = ""): void {
  new InstallModal(plugin, start).open();
}

/** "Share this app" and "Install an app from a link or text". */
export function registerShareCommands(plugin: GizmoPlugin): void {
  plugin.addCommand({
    id: "share-app",
    name: "Share this app",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || !plugin.isApp(file)) return false;
      if (!checking) {
        void (async () => {
          const got = await notesToShare(plugin.runtime, file.path);
          if ("error" in got) return void new Notice(got.error);
          const bundle = toBundle(got.notes, got.about);
          if ("error" in bundle) return void new Notice(`Can't share ${file.basename}: ${bundle.error}`);
          new ShareModal(plugin.app, file.basename, got.notes, bundle.text, got.runs).open();
        })();
      }
      return true;
    },
  });
  plugin.addCommand({
    id: "install-app",
    name: "Install an app from a link or text",
    callback: () => openInstall(plugin),
  });
}
