import { Modal, parseYaml, type TFile } from "obsidian";
import { handler } from "./handler.ts";
import { AppController } from "./app.ts";
import { frontmatterOf, type BundleNote } from "./bundle.ts";
import { copyText, vaultNotes } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { describePermission, permissionsOf } from "./permissions.ts";
import { makeSandbox, plainHosts, type Sandbox, type SandboxNote } from "./sandbox.ts";
import { readSpec } from "./spec.ts";

/** What a try leaves out, in words: what the app would read, use or send once allowed. */
function leftOut(wanted: string[]): string[] {
  return wanted.flatMap((perm) => {
    const kind = perm.split(":")[0];
    if (kind === "read" && !/\.[A-Za-z0-9]+$/.test(perm)) return [`${describePermission(perm)}: none of them here`];
    if (kind === "edit" || kind === "tasks" || kind === "secret" || kind === "send" || kind === "post") return [describePermission(perm)];
    if (perm === "images") return ["Load pictures: their addresses are shown instead"];
    return [];
  });
}

/**
 * The real app on copies of its own notes, before anything is allowed (see makeSandbox): it can
 * be used, what it does is listed as it happens, and closing the window drops all of it.
 */
class TryModal extends Modal {
  private plugin: GizmoPlugin;
  private name: string;
  private appPath: string;
  private notes: Map<string, SandboxNote>;
  private wanted: string[];
  private done: { label: string; run: () => void | Promise<void> } | undefined;
  private controller: AppController | undefined;
  private box: Sandbox | undefined;

  constructor(plugin: GizmoPlugin, name: string, appPath: string, notes: Map<string, SandboxNote>, wanted: string[], done?: { label: string; run: () => void | Promise<void> }) {
    super(plugin.app);
    this.plugin = plugin;
    this.name = name;
    this.appPath = appPath;
    this.notes = notes;
    this.wanted = wanted;
    this.done = done;
  }

  onOpen(): void {
    this.modalEl.addClass("gz-try-modal");
    this.titleEl.setText(`Try ${this.name}`);
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share gz-try" });
    el.createEl("p", { cls: "gz-muted", text: "A try reads none of your notes, keeps nothing, and sends nothing anywhere. Use it as you would; closing this window drops everything it did." });
    const box = makeSandbox({
      appPath: this.appPath,
      notes: this.notes,
      parseYaml: (text) => parseYaml(text) as unknown,
      now: () => new Date(),
      fetch: (url, headers, init) => this.plugin.dataLayer.host.fetch(url, headers, init),
      copy: (text) => copyText(text),
    });
    this.box = box;
    const out = leftOut(this.wanted);
    if (out.length) {
      el.createEl("h4", { text: "Not in this try" });
      const ul = el.createEl("ul");
      for (const line of out) ul.createEl("li", { text: line });
    }
    const hosts = plainHosts(this.wanted);
    if (hosts.length) {
      const fetch = el.createEl("button", { text: `Fetch from ${hosts.join(", ")} for this try` });
      fetch.addEventListener("click", () => {
        box.allow(hosts);
        fetch.disabled = true;
        fetch.setText(`Fetching from ${hosts.join(", ")} for this try only`);
        this.controller?.reload();
      });
    }
    const body = el.createDiv({ cls: "gz-try-app" });
    el.createEl("h4", { text: "What it did here" });
    const did = el.createEl("ul", { cls: "gz-effects" });
    const show = () => {
      did.empty();
      if (!box.events.length) did.createEl("li", { cls: "gz-muted", text: "Nothing yet." });
      for (const e of box.events) did.createEl("li", { text: e.text });
    };
    show();
    box.onEvent(show);
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
    if (this.done) {
      const { label, run } = this.done;
      row.createEl("button", { cls: "mod-cta", text: label }).addEventListener("click", handler(async () => {
        this.close();
        await run();
      }));
    }
    this.controller = new AppController(body, this.appPath, box.env);
    this.controller.load();
    window.setTimeout(() => this.controller?.resize(), 50);
  }

  onClose(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.box = undefined;
    this.contentEl.empty();
  }
}

/** A note as a try sees it, read from the vault. */
async function noteOf(plugin: GizmoPlugin, file: TFile): Promise<SandboxNote> {
  return { frontmatter: plugin.app.metadataCache.getFileCache(file)?.frontmatter, text: await plugin.app.vault.cachedRead(file) };
}

/**
 * Tries an app in the vault before it's allowed: it sees its own note, the components it uses and
 * the templates it names, and nothing else. Allow there allows it as the prompt would.
 */
export async function tryVaultApp(plugin: GizmoPlugin, path: string): Promise<void> {
  const vault = plugin.app.vault;
  const file = vault.getFileByPath(path);
  if (!file) return;
  const spec = readSpec(plugin.app.metadataCache.getFileCache(file)?.frontmatter, { path, notes: vaultNotes(plugin.app), now: new Date() })?.spec;
  const wanted = spec ? permissionsOf(spec, path) : [];
  const notes = new Map<string, SandboxNote>([[path, await noteOf(plugin, file)]]);
  const templates = wanted.filter((p) => p.startsWith("read:") && p.endsWith(".md")).map((p) => p.slice(5));
  for (const other of [...Object.keys(spec?.read ?? {}), ...templates]) {
    const f = vault.getFileByPath(other);
    if (f && !notes.has(other)) notes.set(other, await noteOf(plugin, f));
  }
  new TryModal(plugin, file.basename, path, notes, wanted, { label: "Allow", run: () => plugin.grant(path, wanted) }).open();
}

/** Tries a shared app before installing it, on the shared notes alone, placed as the install would place them. */
export function tryBundle(plugin: GizmoPlugin, notes: BundleNote[], folder: string, install: () => Promise<void>): void {
  const pathOf = (name: string) => (folder ? `${folder}/${name}.md` : `${name}.md`);
  const all = new Map(notes.map((n): [string, SandboxNote] => [pathOf(n.name), { frontmatter: frontmatterOf(n.text, (y) => parseYaml(y) as unknown), text: n.text }]));
  const appPath = pathOf(notes[0].name);
  const reader = { resolve: (link: string) => [...all.keys()].find((p) => p.toLowerCase().endsWith(`${link.replace(/\.md$/i, "").toLowerCase()}.md`)), frontmatter: (p: string) => all.get(p)?.frontmatter };
  const spec = readSpec(all.get(appPath)?.frontmatter, { path: appPath, notes: reader, now: new Date() })?.spec;
  new TryModal(plugin, notes[0].name, appPath, all, spec ? permissionsOf(spec, appPath) : [], { label: "Install", run: install }).open();
}
