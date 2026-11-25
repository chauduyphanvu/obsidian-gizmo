import { MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type { Change } from "./activity.ts";
import { ledgerStore } from "./datastore.ts";
import { vaultFrontmatter } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { RowLines, type RowHome, type Synced } from "./row-lines.ts";
import type { Row } from "./data.ts";
import { rowIdOf } from "./ledger-store.ts";
import { basename } from "./store.ts";
import { plural } from "./text.ts";

/** How long after the last key an edited note's row lines are read: long enough that a word half typed isn't saved. */
const EDIT_WAIT_MS = 1500;
/** How long after rows change the notes' lines are written again, so several writes become one. */
const WRITE_WAIT_MS = 400;


/** What an edit of a note did to its rows, said once. */
function tell(done: Synced, note: string): void {
  const parts: string[] = [];
  if (done.set.length) parts.push(`${plural(done.set.length, "row")} changed to match ${done.set.length === 1 ? "its line" : "their lines"} in ${note}`);
  if (done.removed.length) parts.push(`${plural(done.removed.length, "row")} taken out with ${done.removed.length === 1 ? "its line" : "their lines"} (Undo in Activity)`);
  if (done.restored?.length) parts.push(`${plural(done.restored.length, "row")} put back with ${done.restored.length === 1 ? "its line" : "their lines"} in ${note}`);
  if (parts.length) new Notice(parts.join("; "));
  for (const u of done.unread.slice(0, 2)) new Notice(`“${u.line}” can't be read as a row any more: ${u.error}. Its row stays as it was.`, 10_000);
}

/**
 * Lines are rows in Obsidian (see row-lines.ts): an edit typed here sets or takes out the row of
 * each line it touched, a moment after the typing stops; a row this device changed is written back
 * to its line in every note seen with one. Only what happens on this device makes it act, so two
 * devices never write the same change twice.
 */
export function registerRowLines(plugin: GizmoPlugin): RowLines | undefined {
  const { app } = plugin;
  const ledger = plugin.runtime.dataLayer.ledger;
  if (!ledger) return undefined;
  const fm = vaultFrontmatter(app);
  const store = (home: RowHome) => ledgerStore(ledger, home.dataPath, () => fm(home.owner) ?? {});
  const log = (home: RowHome, note: string, changes: Change[]) => void plugin.runtime.activity.add({ app: home.owner, actor: "you", what: `Edited in ${basename(note)}`, changes });
  const sync = new RowLines({
    now: () => new Date(),
    index: () => plugin.runtime.background.captureIndex(),
    home: (path, shortcut) => plugin.runtime.background.rowHome(path, shortcut),
    rows: async (dataPath, list) => (await ledger.state(dataPath)).lists.get(list)?.rows ?? [],
    async set(home, row, changes, note) {
      const s = store(home);
      const made: Change[] = [];
      let shown: Row = row;
      for (const [field, value] of Object.entries(changes)) {
        const r = await s.set(home.list, { id: rowIdOf(row), shown }, field, value);
        if (!("row" in r)) continue;
        made.push({ kind: "row-edited", path: s.dataPath, list: home.list, row: r.row, field, from: shown[field], to: value, ...(r.event && { event: r.event }) });
        shown = r.row;
      }
      if (made.length) log(home, note, made);
    },
    async remove(home, row, note) {
      const s = store(home);
      const r = await s.delete(home.list, { id: rowIdOf(row), shown: row });
      if (!("row" in r)) return undefined;
      log(home, note, [{ kind: "row-deleted", path: s.dataPath, list: home.list, row: r.row, ...(r.event && { event: r.event }) }]);
      const event = r.event;
      return event ? () => s.undo([event]) : undefined;
    },
    heldElsewhere(id, path) {
      // An open editor holds a paste before it is saved; the index knows every other note.
      const open = app.workspace.getLeavesOfType("markdown").some((leaf) => (
        leaf.view instanceof MarkdownView && leaf.view.file?.path !== path && leaf.view.editor.getValue().includes(`^gz-${id}`)
      ));
      return open || app.vault.getMarkdownFiles().some((f) => f.path !== path && app.metadataCache.getFileCache(f)?.blocks?.[`gz-${id}`] !== undefined);
    },
  });

  const see = (file: TFile | null) => {
    if (file?.extension === "md") void app.vault.cachedRead(file).then((text) => sync.seen(file.path, text), () => {});
  };
  app.workspace.onLayoutReady(() => {
    for (const leaf of app.workspace.getLeavesOfType("markdown")) see(leaf.view instanceof MarkdownView ? leaf.view.file : null);
  });
  plugin.registerEvent(app.workspace.on("file-open", see));
  plugin.registerEvent(app.vault.on("rename", (file, oldPath) => sync.renamed(oldPath, file.path)));

  // An edit typed here: read once the typing has stopped.
  const waiting = new Map<string, number>();
  plugin.registerEvent(app.workspace.on("editor-change", (editor: Editor, info) => {
    const path = info.file?.path;
    if (!path) return;
    // A tab that went on to another note keeps this editor: its text then would read as every line here deleted.
    const textNow = async () => {
      if (info.file?.path === path) return editor.getValue();
      const file = app.vault.getFileByPath(path);
      return file ? app.vault.read(file) : undefined;
    };
    window.clearTimeout(waiting.get(path));
    waiting.set(path, window.setTimeout(() => {
      waiting.delete(path);
      void textNow().then(async (text) => {
        if (text !== undefined) tell(await sync.edited(path, text), basename(path));
      }).catch(() => {});
    }, EDIT_WAIT_MS));
  }));
  plugin.register(() => { for (const t of waiting.values()) window.clearTimeout(t); });

  // Rows this device changed: their lines follow, in every note seen with one.
  const changed = new Set<string>();
  let timer: number | undefined;
  const rewrite = async () => {
    const only = new Set(changed);
    changed.clear();
    for (const path of sync.notes()) {
      // A note being typed in is read when the typing stops; writing it now could land mid-word.
      if (waiting.has(path)) continue;
      const file = app.vault.getFileByPath(path);
      if (!file) continue;
      // An open editor can hold an edit Obsidian hasn't saved yet. Read from disk, its line would look
      // out of date, and writing it again would merge with the edit and double the words typed.
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) await leaf.view.save();
      }
      if (waiting.has(path)) continue;
      const text = await app.vault.read(file);
      const next = await sync.rewritten(path, text, only);
      if (next === undefined) continue;
      await app.vault.process(file, (now) => (now === text ? next : now));
    }
  };
  const wrote = ledger.onWrite;
  ledger.onWrite = (path) => {
    wrote(path);
    if (!path.endsWith(".jsonl")) return;
    changed.add(`${path.slice(0, path.lastIndexOf("/")).replace(/\/log$/, "")}.md`);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void rewrite().catch(() => {}), WRITE_WAIT_MS);
  };
  plugin.register(() => {
    window.clearTimeout(timer);
    ledger.onWrite = wrote;
  });
  return sync;
}
