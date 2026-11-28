import { Modal } from "obsidian";
import type { BundleNote } from "./bundle.ts";
import { copyText } from "./clipboard.ts";
import type GizmoPlugin from "./main.ts";
import type { SandboxNote } from "./sandbox.ts";
import { drawTry, tryTitle } from "./try-pane.ts";
import { bundleTry, vaultTry } from "./try.ts";

/** A try in a window of its own (see drawTry). */
class TryModal extends Modal {
  private plugin: GizmoPlugin;
  private name: string;
  private appPath: string;
  private notes: Map<string, SandboxNote>;
  private wanted: string[];
  private done: { label: string; run: () => void | Promise<void> } | undefined;
  private stop: (() => void) | undefined;

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
    this.titleEl.setText(tryTitle(this.name));
    this.stop = drawTry(this.contentEl, this.plugin.runtime, {
      name: this.name, appPath: this.appPath, notes: this.notes, wanted: this.wanted, done: this.done,
      copy: (text) => copyText(text),
      close: () => this.close(),
    });
  }

  onClose(): void {
    this.stop?.();
    this.stop = undefined;
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
  const t = bundleTry(notes, folder, (yaml) => plugin.runtime.dataLayer.host.parseYaml(yaml));
  new TryModal(plugin, t.name, t.appPath, t.notes, t.wanted, { label: "Install", run: install }).open();
}
