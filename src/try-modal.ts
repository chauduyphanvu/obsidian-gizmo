import { Modal, parseYaml } from "obsidian";
import { handler } from "./handler.ts";
import { AppController } from "./app.ts";
import type { BundleNote } from "./bundle.ts";
import { copyText } from "./clipboard.ts";
import type GizmoPlugin from "./main.ts";
import { makeSandbox, plainHosts, type Sandbox, type SandboxNote } from "./sandbox.ts";
import { bundleTry, leftOut, vaultTry } from "./try.ts";

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
      schedule: (cb) => this.plugin.runtime.dataLayer.host.schedule(cb),
      fetch: (url, headers, init) => this.plugin.runtime.dataLayer.host.fetch(url, headers, init),
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

/**
 * Tries an app in the vault before it's allowed: it sees its own note, the components it uses and
 * the templates it names, and nothing else. Allow there allows it as the prompt would.
 */
export async function tryVaultApp(plugin: GizmoPlugin, path: string): Promise<void> {
  const t = await vaultTry(plugin.runtime, path);
  if (!t) return;
  new TryModal(plugin, t.name, t.appPath, t.notes, t.wanted, { label: "Allow", run: () => plugin.runtime.grant(path, t.wanted) }).open();
}

/** Tries a shared app before installing it, on the shared notes alone, placed as the install would place them. */
export function tryBundle(plugin: GizmoPlugin, notes: BundleNote[], folder: string, install: () => Promise<void>): void {
  const t = bundleTry(notes, folder, (yaml) => parseYaml(yaml) as unknown);
  new TryModal(plugin, t.name, t.appPath, t.notes, t.wanted, { label: "Install", run: install }).open();
}
