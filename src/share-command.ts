import { Modal, Notice, parseYaml, type App, type TFile } from "obsidian";
import {
  fromBundle, fromFetched, previewInstall, sharedUrl, thenTargets, toBundle, type BundleNote, type InstallPreview,
} from "./bundle.ts";
import { existingNotes, installNotes } from "./gallery-command.ts";
import { copyText, vaultNotes } from "./host.ts";
import { planCopy } from "./gallery.ts";
import type GizmoPlugin from "./main.ts";
import { readComponentPreview, readSpec } from "./spec.ts";
import { basename, isApp, isComponent, storeTarget } from "./store.ts";

/**
 * The notes sharing an app takes along: the note itself, every component it reads at any depth,
 * and the template notes its panels make notes from. Never its data note or the notes it keeps.
 */
async function notesToShare(app: App, file: TFile): Promise<{ notes: BundleNote[]; about: string; runs: string[] } | { error: string }> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  const notes = vaultNotes(app);
  const component = isComponent(fm);
  if (!fm || (!component && !isApp(fm))) return { error: "Only an app or a component can be shared" };
  const opts = { now: new Date(), notes, path: file.path };
  const spec = (component ? readComponentPreview(fm, opts).result : readSpec(fm, opts))?.spec;
  if (!spec) return { error: `${file.basename} has a problem to fix before it can be shared` };
  const paths = new Set(Object.keys(spec.read));
  for (const { panel } of spec.panels) {
    const template = panel.template && notes.resolve(storeTarget(panel.template), file.path);
    if (template) paths.add(template);
  }
  paths.delete(file.path);
  const others = [...paths].flatMap((p) => app.vault.getFileByPath(p) ?? []);
  const read = await Promise.all([file, ...others].map(async (f) => ({ name: f.basename, text: await app.vault.read(f) })));
  const names = new Set(read.map((n) => n.name.toLowerCase()));
  const runs = thenTargets(spec.panels).filter((t) => !names.has(t.app.toLowerCase())).map((t) => `It runs “${t.do}” in ${t.app}, which isn't included; whoever installs it needs an app of that name with that shortcut.`);
  return { notes: read, about: String((component ? fm.component : fm.app) ?? ""), runs };
}

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
    this.installButton = row.createEl("button", { cls: "mod-cta", text: "Install" });
    this.installButton.disabled = true;
    this.installButton.addEventListener("click", () => void this.install());
    if (this.start) void this.read(this.start);
    else area.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private say(text: string, cls = "gz-muted"): void {
    this.output.empty();
    this.output.createEl("p", { cls, text });
    this.installButton.disabled = true;
    this.preview = undefined;
  }

  private async read(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return this.say("Paste something first");
    const url = /^\w+:\/\//.test(trimmed) ? sharedUrl(trimmed) : undefined;
    if (/^\w+:\/\//.test(trimmed) && !url) return this.say("Only https links can be installed", "gz-error-text");
    let got: { notes: BundleNote[] } | { error: string };
    if (url) {
      this.say(`Fetching ${new URL(url).hostname}…`);
      try {
        const res = await this.plugin.dataLayer.host.fetch(url, {});
        if (res.status >= 400) return this.say(`${new URL(url).hostname} answered ${res.status}`, "gz-error-text");
        got = fromFetched(res.text, url, parseYaml);
        if ("error" in got && new URL(trimmed).hostname === "gist.github.com") got = { error: `${got.error}. For a gist of several files, use the raw link of the shared file` };
      } catch (e) {
        return this.say(`Couldn't fetch it: ${(e as Error).message}`, "gz-error-text");
      }
    } else {
      got = fromBundle(trimmed);
    }
    if ("error" in got) return this.say(cap(got.error), "gz-error-text");
    this.notes = got.notes;
    const existing = await existingNotes(this.app, got.notes.map((n) => n.name));
    const folder = this.app.fileManager.getNewFileParent("").path;
    const preview = previewInstall(got.notes, {
      folder: folder === "/" ? "" : folder,
      existing: (name) => existing[name] ?? [],
      notes: vaultNotes(this.app),
      parse: parseYaml,
    });
    if ("error" in preview) return this.say(cap(preview.error), "gz-error-text");
    this.show(preview);
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
    const kind = p.kind === "app" ? "When you open it, it will ask your OK to:" : "Where it's used, it will ask your OK to:";
    if (p.asks.length) {
      this.output.createEl("p", { text: kind });
      const ul = this.output.createEl("ul");
      for (const a of p.asks) ul.createEl("li", { text: a });
    } else {
      this.output.createEl("p", { text: "It asks for nothing: it only keeps its own data beside it." });
    }
    this.installButton.disabled = "refusal" in p.plan;
  }

  private async install(): Promise<void> {
    const p = this.preview;
    if (!p || "refusal" in p.plan) return;
    // Names may have been taken since the preview.
    const existing = await existingNotes(this.app, this.notes.map((n) => n.name));
    const asGallery = (n: BundleNote) => ({ path: `${n.name}.md`, text: n.text });
    const plan = planCopy(asGallery(this.notes[0]), this.notes.slice(1).map(asGallery), existing);
    if (await installNotes(this.app, plan, p.name)) this.close();
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
          const got = await notesToShare(plugin.app, file);
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
