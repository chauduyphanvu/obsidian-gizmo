import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { TFile as ObsidianFile } from "obsidian";

// The plugin's own modules take classes from "obsidian" as they load: here they get
// test/support/obsidian.ts in its place, so a test can drive the plugin on a fake workspace.
const stub = new URL("./obsidian.ts", import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => (specifier === "obsidian" ? { url: stub, shortCircuit: true } : next(specifier, context)),
});
const [{ default: GizmoPlugin }, host, obsidian] = await Promise.all([
  import("../../src/main.ts"),
  import("../../src/host.ts"),
  import("./obsidian.ts"),
]);
export const { obsidianAppEnv } = host;
export { obsidian };

const { MarkdownView, TFile } = obsidian;
type View = InstanceType<typeof MarkdownView>;
type Notes = Record<string, { fm?: Record<string, unknown>; text: string }>;

/**
 * The plugin on a workspace of tabs: each keeps the view state it was given, as Obsidian's do, and
 * a markdown one has a MarkdownView of its note, its editor holding the note's text. What was
 * revealed and focused is kept. A note made in the vault has no properties in the metadata cache
 * until `index` reads them, as Obsidian's cache reads them a moment after.
 */
export function workspace(notes: Notes, index: (text: string) => Record<string, unknown> | undefined = () => undefined) {
  const files = new Map<string, InstanceType<typeof TFile>>();
  const fileOf = (path: string) => {
    const f = new TFile();
    f.path = path;
    f.name = path.split("/").pop()!;
    f.basename = f.name.replace(/\.md$/, "");
    files.set(path, f);
    return f;
  };
  for (const path of Object.keys(notes)) fileOf(path);
  const rootSplit = { name: "root" };
  const rightSplit = { name: "right" };
  const leftSplit = { name: "left" };
  const leaves: Leaf[] = [];
  const revealed: Leaf[] = [];
  const changed = new Set<(f: unknown) => void>();
  let active: Leaf | undefined;

  class Leaf {
    state: { type: string; state?: Record<string, unknown> } = { type: "empty" };
    view: unknown;
    root: unknown;
    /** The tab it was split from, and which way. */
    from?: { leaf: Leaf; direction?: string };
    constructor(root: unknown = rootSplit) {
      this.root = root;
      leaves.push(this);
    }
    getRoot() { return this.root; }
    getViewState() { return this.state; }
    async setViewState(s: { type: string; state?: Record<string, unknown>; active?: boolean }) {
      this.state = { type: s.type, state: { ...s.state } };
      const path = String(s.state?.file);
      if (s.type === "markdown") {
        const kept = this.view instanceof MarkdownView && this.view.file === files.get(path) ? this.view : new MarkdownView(this);
        kept.file = files.get(path) ?? null;
        kept.mode = s.state?.mode === "preview" ? "preview" : "source";
        kept.editor.lines = notes[path]?.text.split("\n") ?? [];
        this.view = kept;
      } else {
        this.view = { getViewType: () => s.type, file: files.get(path) };
      }
      if (s.active) active = this;
    }
    detach() { leaves.splice(leaves.indexOf(this), 1); }
  }

  const ws = {
    rootSplit, leftSplit, rightSplit,
    getLeavesOfType: (type: string) => leaves.filter((l) => l.state.type === type),
    createLeafBySplit(leaf: Leaf, direction?: string) {
      const made = new Leaf(leaf.root);
      made.from = { leaf, direction };
      return made;
    },
    getLeaf: (kind?: string) => {
      assert.equal(kind, "tab");
      return new Leaf(rootSplit);
    },
    revealLeaf: async (leaf: Leaf) => { revealed.push(leaf); },
    setActiveLeaf: (leaf: Leaf) => { active = leaf; },
  };
  const app = {
    workspace: ws,
    vault: {
      getFileByPath: (path: string) => files.get(path) ?? null,
      async process(file: { path: string }, fn: (text: string) => string) {
        notes[file.path].text = fn(notes[file.path].text);
        return notes[file.path].text;
      },
      async create(path: string, text: string) {
        if (files.has(path)) throw new Error("File already exists.");
        notes[path] = { text };
        const f = fileOf(path);
        setTimeout(() => {
          notes[path].fm = index(text);
          for (const cb of changed) cb(f);
        }, 5);
        return f;
      },
    },
    metadataCache: {
      getFileCache: (f: { path: string }) => ({ frontmatter: notes[f.path]?.fm }),
      on: (_name: "changed", cb: (f: unknown) => void) => { changed.add(cb); return cb; },
      offref: (ref: (f: unknown) => void) => { changed.delete(ref); },
    },
  };
  const plugin = new GizmoPlugin(app as never, { id: "gizmo", dir: ".obsidian/plugins/gizmo" } as never);
  // What the env reads of the plugin's runtime when it is made, and its writes' createText, which
  // makes a note through the vault as Obsidian's writes do (see vaultWrites).
  const createText = async (path: string, text: string) => {
    if (files.has(path)) return false;
    await app.vault.create(path, text);
    return true;
  };
  (plugin as unknown as { runtime: unknown }).runtime = { dataLayer: { ledger: undefined }, background: {}, host: { writes: { createText } } };
  /** A tab showing a note: as the app, or as text in a mode. */
  const open = async (path: string, type: "gizmo" | "markdown", root: unknown = rootSplit, state: Record<string, unknown> = {}) => {
    const leaf = new Leaf(root);
    await leaf.setViewState({ type, state: { file: path, ...(type === "markdown" && { mode: "source", source: true }), ...state } });
    return leaf;
  };
  // The plugin's own steps that aren't commands, as the header action and the events run them.
  const own = plugin as unknown as { showApp(view: View): Promise<void>; syncShowAppActions(): void };
  return {
    plugin, own, leaves, revealed, open, notes,
    file: (path: string) => files.get(path) as unknown as ObsidianFile,
    get active() { return active; },
    rightSplit,
    /** How many are waiting to hear that a note's properties were read. */
    listening: () => changed.size,
  };
}
