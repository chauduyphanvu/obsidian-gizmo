import { ItemView, MarkdownView, Modal, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { openActivity } from "./activity-view.ts";
import { drawDryRun, dryRunTitle, type MapShortcut } from "./dry-run-pane.ts";
import { copyShortcutLink } from "./link-command.ts";
import type GizmoPlugin from "./main.ts";
import { mapCanvas } from "./map-canvas.ts";
import { MapPane } from "./map-pane.ts";
import { PolicyModal } from "./policy-command.ts";
import { dayIn } from "./time.ts";

export const MAP_VIEW = "gizmo-map";

/** The automation map in a tab of its own (see MapPane). */
export class MapView extends ItemView {
  private plugin: GizmoPlugin;
  private note: string | undefined;
  private pane: MapPane | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: GizmoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return MAP_VIEW; }
  getDisplayText(): string { return "Automation map"; }
  getIcon(): string { return "network"; }

  getState(): Record<string, unknown> {
    return { note: this.pane ? this.pane.note : this.note };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const note = (state as { note?: unknown } | null)?.note;
    this.note = typeof note === "string" ? note : undefined;
    await super.setState(state, result);
    this.pane?.setNote(this.note);
  }

  async onOpen(): Promise<void> {
    const plugin = this.plugin;
    this.pane = new MapPane(this.contentEl, {
      rt: plugin.runtime,
      notify: (message) => new Notice(message),
      open: (path) => void this.app.workspace.openLinkText(path, "", false),
      activity: (path) => openActivity(plugin, path),
      dryRun: (path, name, shortcut) => new DryRunModal(plugin, path, name, shortcut).open(),
      policy: () => new PolicyModal(plugin).open(),
      copyLink: copyShortcutLink,
      saveCanvas: () => void saveMapCanvas(plugin),
    }, this.note);
  }

  async onClose(): Promise<void> {
    this.pane?.stop();
  }
}

/** A shortcut's dry run in a window (see drawDryRun). */
class DryRunModal extends Modal {
  private plugin: GizmoPlugin;
  private path: string;
  private name: string;
  private shortcut: MapShortcut;
  private stop: (() => void) | undefined;

  constructor(plugin: GizmoPlugin, path: string, name: string, shortcut: MapShortcut) {
    super(plugin.app);
    this.plugin = plugin;
    this.path = path;
    this.name = name;
    this.shortcut = shortcut;
  }

  onOpen(): void {
    this.titleEl.setText(dryRunTitle(this.shortcut, this.name));
    this.stop = drawDryRun(this.contentEl, this.plugin.runtime, this.path, this.shortcut);
  }

  onClose(): void {
    this.stop?.();
    this.contentEl.empty();
  }
}

/** Saves the map as a new canvas at the vault's top, never over one already there, and opens it. */
export async function saveMapCanvas(plugin: GizmoPlugin): Promise<void> {
  const vault = plugin.app.vault;
  const data = mapCanvas(plugin.runtime.background.list(), (path) => !!vault.getFileByPath(path));
  const day = dayIn(Date.now());
  let path = `Gizmo map ${day}.canvas`;
  for (let n = 2; vault.getAbstractFileByPath(path); n++) path = `Gizmo map ${day} ${n}.canvas`;
  const file = await vault.create(path, JSON.stringify(data, null, "\t"));
  new Notice(`Saved the map as ${file.basename}`);
  await plugin.app.workspace.getLeaf("tab").openFile(file);
}

/** Opens the map (one tab, reused), optionally starting with the apps that can change a note. */
export async function openMap(plugin: GizmoPlugin, note?: string): Promise<void> {
  const ws = plugin.app.workspace;
  const leaf = ws.getLeavesOfType(MAP_VIEW)[0] ?? ws.getLeaf("tab");
  await leaf.setViewState({ type: MAP_VIEW, state: { note }, active: true });
  void ws.revealLeaf(leaf);
}

export function registerMap(plugin: GizmoPlugin): void {
  plugin.registerView(MAP_VIEW, (leaf) => new MapView(leaf, plugin));
  plugin.addCommand({ id: "open-map", name: "Open the automation map", callback: () => void openMap(plugin) });
  plugin.addCommand({ id: "save-map-canvas", name: "Save the automation map as a canvas", callback: () => void saveMapCanvas(plugin) });
  plugin.addCommand({
    id: "who-changes-note",
    name: "Which apps can change this note?",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile() ?? plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (!file) return false;
      if (!checking) void openMap(plugin, file.path);
      return true;
    },
  });
}
