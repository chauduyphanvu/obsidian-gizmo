import { withLine } from "./actions.ts";
import { formatValue, type Row } from "./data.ts";
import { fnv1a, stableJson } from "./hash.ts";
import { basename } from "./store.ts";

/**
 * One change an app made to the vault, with what undoing it needs: what was there before, and
 * what it wrote, to be sure nothing has changed it since.
 */
export type Change =
  | { kind: "row-added"; path: string; list: string; row: Row }
  /** `row` is the row as the edit left it. */
  | { kind: "row-edited"; path: string; list: string; row: Row; field: string; from: unknown; to: unknown }
  | { kind: "checklist"; path: string; list: string; item: string; checked: boolean }
  | { kind: "cleared"; path: string; list: string; items: string[] }
  /** `had` says whether the property was there before; `from` is its value then. */
  | { kind: "property"; path: string; field: string; from: unknown; to: unknown; had: boolean }
  /** `created` when the note didn't exist and the line made it. */
  | { kind: "line-added"; path: string; line: string; created: boolean }
  | { kind: "note-created"; path: string; hash: string }
  | { kind: "task"; path: string; line: number; text: string; done: boolean };

/** Who made an app act: the person in the app, a shortcut's command, a link, or another app's trigger. */
export type Actor = "you" | "shortcut" | "link" | `trigger:${string}`;

/** One run of an app's actions and the changes it made, newest last. */
export interface Entry {
  id: string;
  /** Milliseconds since 1970. */
  at: number;
  app: string;
  actor: Actor;
  /** The panel or action, as the app calls it. */
  what: string;
  changes: Change[];
  /** How many changes, from the last, have been undone. */
  undone: number;
}

export type NewEntry = Omit<Entry, "id" | "at" | "undone">;

export const MAX_ENTRIES = 1000;
export const MAX_PER_APP = 200;

/** Where the log is kept: the plugin's folder in Obsidian, memory in tests. */
export interface LogStore {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

/** A short fingerprint of a note's text, to tell whether it changed after the app wrote it. */
export function textHash(text: string): string {
  return `${fnv1a(text).toString(16)}:${text.length}`;
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** The activity of every app, kept small: the newest entries, a few hundred per app. */
export class ActivityLog {
  private entries: Entry[] = [];
  private store: LogStore;
  private loaded: Promise<void> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private counter = 0;
  private now: () => number;

  constructor(store: LogStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** Reads the kept log once; a log that can't be read starts empty. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const text = await this.store.read();
        const parsed = text ? JSON.parse(text) as unknown : [];
        if (Array.isArray(parsed)) this.entries = parsed.filter((e): e is Entry => !!e && typeof e === "object" && Array.isArray((e as Entry).changes));
      } catch {
        this.entries = [];
      }
    })();
    return this.loaded;
  }

  /** Adds a run's changes; a run that changed nothing isn't kept. */
  async add(entry: NewEntry): Promise<Entry | undefined> {
    if (!entry.changes.length) return undefined;
    await this.load();
    const at = this.now();
    // A copy, so a row the app goes on to change (or the vault's own copy of it) can't change what was kept.
    const full: Entry = { ...entry, changes: structuredClone(entry.changes), id: `${at.toString(36)}-${(this.counter++).toString(36)}`, at, undone: 0 };
    this.entries.push(full);
    this.trim(entry.app);
    await this.save();
    return full;
  }

  private trim(app: string): void {
    const mine = this.entries.filter((e) => e.app === app);
    if (mine.length > MAX_PER_APP) {
      const drop = new Set(mine.slice(0, mine.length - MAX_PER_APP));
      this.entries = this.entries.filter((e) => !drop.has(e));
    }
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
  }

  /** An app's entries (or everyone's), newest first. */
  async list(app?: string): Promise<Entry[]> {
    await this.load();
    return this.entries.filter((e) => app === undefined || e.app === app).reverse();
  }

  async get(id: string): Promise<Entry | undefined> {
    await this.load();
    return this.entries.find((e) => e.id === id);
  }

  async setUndone(id: string, undone: number): Promise<void> {
    await this.load();
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.undone = undone;
    await this.save();
  }

  /** A note moved: its entries and changes follow it, as its grants do. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.load();
    let moved = false;
    for (const e of this.entries) {
      if (e.app === oldPath) {
        e.app = newPath;
        moved = true;
      }
      for (const c of e.changes) {
        if (c.path !== oldPath) continue;
        c.path = newPath;
        moved = true;
      }
    }
    if (moved) await this.save();
  }

  private save(): Promise<void> {
    const text = JSON.stringify(this.entries);
    this.saving = this.saving.then(() => this.store.write(text)).catch(() => {});
    return this.saving;
  }
}

/** Why undoing a change can't go ahead, or nothing when it can. */
type Refusal = string | undefined;

/** The list a change is about, as it is now in the note's frontmatter. */
function listIn(fm: Record<string, unknown>, list: string): unknown[] | undefined {
  return Array.isArray(fm[list]) ? fm[list] as unknown[] : undefined;
}

/**
 * Undoes a change to a note's frontmatter in place, only while the note still holds what the app
 * wrote; otherwise leaves it untouched and says why.
 */
export function undoInFrontmatter(change: Change, fm: Record<string, unknown>): Refusal {
  const note = basename(change.path);
  switch (change.kind) {
    case "row-added": {
      const list = listIn(fm, change.list);
      const i = list ? list.findLastIndex((r) => same(r, change.row)) : -1;
      if (!list || i < 0) return `the row it saved in ${note} has changed or is gone`;
      fm[change.list] = list.filter((_, j) => j !== i);
      return undefined;
    }
    case "row-edited": {
      const list = listIn(fm, change.list);
      const i = list ? list.findLastIndex((r) => same(r, change.row)) : -1;
      if (!list || i < 0) return `the row it changed in ${note} has changed again or is gone`;
      const row = { ...(list[i] as Row) };
      if (change.from === undefined) delete row[change.field];
      else row[change.field] = change.from;
      fm[change.list] = list.map((r, j) => (j === i ? row : r));
      return undefined;
    }
    case "checklist": {
      const list = (listIn(fm, change.list) ?? []).map(String);
      if (list.includes(change.item) !== change.checked) return `“${change.item}” has been ${change.checked ? "unticked" : "ticked"} since`;
      fm[change.list] = change.checked ? list.filter((i) => i !== change.item) : [...list, change.item];
      return undefined;
    }
    case "cleared": {
      const list = listIn(fm, change.list) ?? [];
      if (list.length) return "something has been ticked since";
      fm[change.list] = [...change.items];
      return undefined;
    }
    case "property": {
      if (!same(fm[change.field], change.to)) return `${change.field} in ${note} has changed since`;
      if (change.had) fm[change.field] = change.from;
      else delete fm[change.field];
      return undefined;
    }
    default:
      return "that isn't a change to properties";
  }
}

/** A note's text without the line the app added (the last such line); undefined when it's gone. */
export function withoutLine(text: string, line: string): string | undefined {
  const lines = text.split("\n");
  const i = lines.lastIndexOf(line);
  if (i < 0) return undefined;
  lines.splice(i, 1);
  return lines.join("\n");
}

/** What undoing needs from the vault; every write re-checks the note as it writes. */
export interface UndoIO {
  /** The note's frontmatter as Obsidian has it cached, to check before writing anything. */
  frontmatter(path: string): Record<string, unknown> | undefined;
  /** Changes an existing note's frontmatter; false when the note is gone. */
  updateFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<boolean>;
  /** Changes an existing note's text in one read-and-write; false when the note is gone. */
  processText(path: string, fn: (text: string) => string): Promise<boolean>;
  /** Moves a note to the trash while `unchanged(text)` holds; says what happened. */
  trashIf(path: string, unchanged: (text: string) => boolean): Promise<"trashed" | "changed" | "gone">;
  setTaskDone(path: string, line: number, text: string, done: boolean): Promise<boolean>;
}

/** Undoes one change, re-checking it as it writes; a refusal when the vault no longer holds what the app wrote. */
async function undoOne(change: Change, io: UndoIO): Promise<Refusal> {
  const note = basename(change.path);
  switch (change.kind) {
    case "row-added":
    case "row-edited":
    case "checklist":
    case "cleared":
    case "property": {
      const cached = io.frontmatter(change.path);
      if (!cached) return `${note} is gone`;
      // Checked on a copy first, so an undo that can't go ahead doesn't rewrite the note.
      const first = undoInFrontmatter(change, structuredClone(cached));
      if (first) return first;
      let refusal: Refusal;
      const written = await io.updateFrontmatter(change.path, (fm) => { refusal = undoInFrontmatter(change, fm); });
      return written ? refusal : `${note} is gone`;
    }
    case "line-added": {
      if (change.created) {
        const trashed = await io.trashIf(change.path, (text) => text === withLine("", change.line));
        if (trashed === "trashed") return undefined;
        if (trashed === "gone") return `${note} is gone`;
      }
      let refusal: Refusal;
      const written = await io.processText(change.path, (text) => {
        const next = withoutLine(text, change.line);
        if (next === undefined) refusal = `the line it added to ${note} has changed or is gone`;
        return next ?? text;
      });
      return written ? refusal : `${note} is gone`;
    }
    case "note-created": {
      const trashed = await io.trashIf(change.path, (text) => textHash(text) === change.hash);
      if (trashed === "trashed") return undefined;
      return trashed === "gone" ? `${note} is gone already` : `${note} has been changed since; delete it yourself if you mean to`;
    }
    case "task":
      return (await io.setTaskDone(change.path, change.line, change.text, !change.done)) ? undefined : `the task “${change.text}” in ${note} has changed or is gone`;
  }
}

/** How an undo went: how many of the entry's changes are undone now, and why it stopped when it did. */
export interface UndoResult {
  undone: number;
  total: number;
  refusal?: string;
}

/**
 * Undoes an entry's changes, newest first, from where an earlier undo stopped; stops at the first
 * change the vault no longer holds as the app wrote it.
 */
export async function undoEntry(entry: Entry, io: UndoIO): Promise<UndoResult> {
  const total = entry.changes.length;
  let undone = entry.undone;
  while (undone < total) {
    const change = entry.changes[total - 1 - undone];
    let refusal: Refusal;
    try {
      refusal = await undoOne(change, io);
    } catch (e) {
      refusal = (e as Error).message;
    }
    if (refusal) return { undone, total, refusal };
    undone++;
  }
  return { undone, total };
}

/** What an undo did, as a notice says it. */
export function undoMessage(r: UndoResult): string {
  if (!r.refusal) return r.total === 1 ? "Undone" : `Undid all ${r.total} changes`;
  const what = r.undone ? `Undid ${r.undone} of ${r.total}, then stopped` : "Couldn't undo it";
  return `${what}: ${r.refusal}`;
}

/** A value as a sentence shows it. */
function shown(v: unknown): string {
  if (v === undefined || v === null || v === "") return "nothing";
  return formatValue(v, undefined, false);
}

/** A saved row in a few words: its first fields, without the time it was saved. */
function rowWords(row: Row): string {
  const fields = Object.entries(row).filter(([k, v]) => k !== "at" && v !== null && v !== "" && v !== undefined);
  const words = fields.slice(0, 3).map(([k, v]) => `${k} ${shown(v)}`).join(", ");
  return fields.length > 3 ? `${words}, …` : words;
}

/** A change as a plain sentence. */
export function describeChange(c: Change): string {
  const note = basename(c.path);
  switch (c.kind) {
    case "row-added": {
      const words = rowWords(c.row);
      return `Saved ${words ? `${words} ` : "a row "}to ${c.list} in ${note}`;
    }
    case "row-edited": return `Changed ${c.field} from ${shown(c.from)} to ${shown(c.to)} in ${c.list} in ${note}`;
    case "checklist": return `${c.checked ? "Ticked" : "Unticked"} “${c.item}”`;
    case "cleared": return `Cleared ${c.items.length} ticked ${c.items.length === 1 ? "item" : "items"}`;
    case "property": return `Set ${c.field} of ${note} to ${shown(c.to)}${c.had ? ` (was ${shown(c.from)})` : ""}`;
    case "line-added": return `${c.created ? `Created ${note} with` : `Added to ${note}`} the line “${c.line}”`;
    case "note-created": return `Created the note ${note}`;
    case "task": return `${c.done ? "Ticked" : "Unticked"} “${c.text}” in ${note}`;
  }
}

/** Who acted, as the log says it. */
export function describeActor(a: Actor): string {
  if (a === "you") return "You";
  if (a === "shortcut") return "A shortcut";
  if (a === "link") return "A link";
  return `Triggered by ${a.slice("trigger:".length)}`;
}
