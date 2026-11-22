// What the plugin's modules take from "obsidian" when they load, for tests that load the plugin
// itself (see test/support/plugin.ts). Only enough to load them and run what those tests drive:
// the classes the modules extend, and the few things they read. The workspace is the test's fake.

export class Component {
  register(_cb: () => void): void {}
  registerEvent(_ref: unknown): void {}
  addChild<T>(child: T): T { return child; }
  load(): void {}
  unload(): void {}
}

export class Plugin extends Component {
  app: unknown;
  manifest: { id: string; dir?: string };
  constructor(app: unknown, manifest: { id: string; dir?: string }) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
}

export class View extends Component {
  leaf: unknown;
  containerEl: unknown;
  constructor(leaf: unknown) {
    super();
    this.leaf = leaf;
  }
}
export class ItemView extends View {}
export class FileView extends ItemView {}
export class BasesView extends Component {}
export class MarkdownRenderChild extends Component {}
export class PluginSettingTab {}
export class Modal {}
export class FuzzySuggestModal extends Modal {}
export class EditorSuggest {}
export class Setting {}
export class Scope {}
export class Notice {
  message: string;
  constructor(message: string) { this.message = message; }
}

export class TAbstractFile {
  path = "";
  name = "";
}
export class TFile extends TAbstractFile {
  basename = "";
  extension = "md";
}

/** The editor of a markdown tab: its text by lines, and where its cursor was put. */
export class FakeEditor {
  lines: string[] = [];
  cursor: { line: number; ch: number } | undefined;
  focused = false;
  lineCount(): number { return this.lines.length; }
  setCursor(at: { line: number; ch: number }): void { this.cursor = at; }
  scrollIntoView(): void {}
  focus(): void { this.focused = true; }
}

/** A markdown tab's view: its note, its mode, and the actions in its header. */
export class MarkdownView extends FileView {
  file: TFile | null = null;
  editor = new FakeEditor();
  mode: "source" | "preview" = "source";
  actions: { icon: string; title: string; el: { removed: boolean; remove(): void }; callback: () => unknown }[] = [];
  getMode(): string { return this.mode; }
  addAction(icon: string, title: string, callback: () => unknown): unknown {
    const el = { removed: false, remove() { this.removed = true; } };
    this.actions.push({ icon, title, el, callback });
    return el;
  }
}

export class WorkspaceLeaf {
  setViewState(_state: unknown): Promise<void> { return Promise.resolve(); }
}

export const Platform = { isPhone: false, isMobile: false, isMacOS: true, isDesktopApp: true };
export const Keymap = { isModifier: () => false };

export class BooleanValue {}
export class ListValue {}
export class NullValue {}
export class NumberValue {}

export function normalizePath(path: string): string { return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }
export function getLinkpath(link: string): string { return link.replace(/#.*$/, ""); }
export function getAllTags(): string[] { return []; }
export function parseYaml(): unknown { throw new Error("not in these tests"); }
export function stringifyYaml(): string { throw new Error("not in these tests"); }
export function requestUrl(): never { throw new Error("not in these tests"); }
export function setIcon(): void {}
