import { withLine } from "./actions.ts";
import { formatValue, type Row } from "./data.ts";
import { stableJson, textHash } from "./hash.ts";
import { parseStamp } from "./ledger.ts";
import { basename } from "./store.ts";

/**
 * One change an app made to the vault, with what undoing it needs: what was there before, and
 * what it wrote, to be sure nothing has changed it since.
 */
export type Change =
  /** `id`: the row's id in the ledger, when the store gives one, so a note's line can be paired with it (see row-lines.ts). */
  | { kind: "row-added"; path: string; list: string; row: Row; event?: string; id?: string }
  /** `row` is the row as the edit left it. */
  | { kind: "row-edited"; path: string; list: string; row: Row; field: string; from: unknown; to: unknown; event?: string }
  /** `row` is the row as it was kept; `index`, its place in a list kept in the note's properties. */
  | { kind: "row-deleted"; path: string; list: string; row: Row; index?: number; event?: string }
  | { kind: "checklist"; path: string; list: string; item: string; checked: boolean; event?: string }
  | { kind: "cleared"; path: string; list: string; items: string[]; event?: string }
  /** `had` says whether the property was there before; `from` is its value then. */
  | { kind: "property"; path: string; field: string; from: unknown; to: unknown; had: boolean }
  /** `created` when the note didn't exist and the line made it. */
  | { kind: "line-added"; path: string; line: string; created: boolean }
  | { kind: "note-created"; path: string; hash: string }
  | { kind: "task"; path: string; line: number; text: string; done: boolean };

/** Who made an app act: the person in the app, a shortcut's command, a link, another app's trigger, or a folder a kind imports from. */
export type Actor = "you" | "shortcut" | "link" | "import" | "share" | `trigger:${string}`;

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
  /** A value it sent out of Obsidian, answering a link: where to, and the value as shown. */
  sent?: { to: string; shown: string };
  /**
   * On an entry another device kept: that device's name. Only the device that made a change undoes
   * it, unless every change is kept as a ledger event, which any device can take back.
   */
  device?: string;
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

/** When an entry's changes were all made: its time, or its latest event's when that came later. */
export function doneAt(entry: Entry): number {
  const walls = (eventsOf(entry) ?? []).map((e) => parseStamp(e.event.slice(e.event.indexOf("@") + 1))?.wall ?? 0);
  return Math.max(entry.at, ...walls);
}

/** The ledger events an entry's changes are, when every one of them is one; else undefined. */
export function eventsOf(entry: Entry): { path: string; event: string }[] | undefined {
  const out = entry.changes.map((c) => ("event" in c && c.event ? { path: c.path, event: c.event } : undefined));
  return out.length && out.every(Boolean) ? (out as { path: string; event: string }[]) : undefined;
}

/**
 * How many of an entry's changes, from the last, are undone, as every device's ledger says: an entry
 * of events is undone wherever its undo was made.
 */
export function undoneIn(entry: Entry, undone: (path: string) => Set<string>): number {
  const events = eventsOf(entry);
  if (!events) return entry.undone;
  let n = 0;
  for (let i = events.length - 1; i >= 0 && undone(events[i].path).has(events[i].event); i--) n++;
  return Math.max(n, entry.undone);
}

/** What other devices kept, each log's text with the name of the device that kept it. */
export type OtherLogs = () => Promise<{ device: string; text: string }[]>;

function entriesIn(text: string | undefined): Entry[] {
  const parsed = text ? JSON.parse(text) as unknown : [];
  return Array.isArray(parsed) ? parsed.filter((e): e is Entry => !!e && typeof e === "object" && Array.isArray((e as Entry).changes)) : [];
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
  private listeners = new Set<() => void>();

  private others: OtherLogs;

  /**
   * `store` is this device's own log, the only one it writes; `others` are the other devices'
   * logs, read when listing, so what every device did shows and none of them writes another's.
   */
  constructor(store: LogStore, now: () => number = Date.now, others: OtherLogs = async () => []) {
    this.store = store;
    this.now = now;
    this.others = others;
  }

  /** Reads the kept log once; a log that can't be read starts empty. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.entries = entriesIn(await this.store.read());
      } catch {
        this.entries = [];
      }
    })();
    return this.loaded;
  }

  /** Other devices' entries, each with its device's name; one this device also has (a log copied over) is its own. */
  private async theirs(): Promise<Entry[]> {
    const mine = new Set(this.entries.map((e) => e.id));
    const out: Entry[] = [];
    for (const { device, text } of await this.others().catch(() => [])) {
      try {
        for (const e of entriesIn(text)) if (!mine.has(e.id)) out.push({ ...e, device });
      } catch {
        // A log another device is halfway through writing is read next time.
      }
    }
    return out;
  }

  /** Calls `cb` whenever an entry is added, undone or moved; returns how to stop. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Adds a run's changes; a run that changed nothing and sent nothing isn't kept. */
  async add(entry: NewEntry): Promise<Entry | undefined> {
    if (!entry.changes.length && !entry.sent) return undefined;
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

  /**
   * An app's entries (or everyone's), every device's, newest first. `shared` are data notes other
   * apps write too (the kinds it reads, or its own rows when it is a kind): what any app changed
   * there is listed with its own.
   */
  async list(app?: string, shared: readonly string[] = []): Promise<Entry[]> {
    await this.load();
    const all = [...this.entries, ...(await this.theirs())].sort((a, b) => a.at - b.at);
    const touches = (e: Entry) => shared.length > 0 && e.changes.some((c) => shared.includes(c.path));
    return all.filter((e) => app === undefined || e.app === app || touches(e)).reverse();
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
    for (const cb of [...this.listeners]) cb();
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
  /** Takes back events in a data note's ledger, whichever device made them. */
  undoEvents?(dataPath: string, events: string[]): Promise<void>;
}

/** A value as a sentence shows it. */
function shown(v: unknown): string {
  if (v === undefined || v === null || v === "") return "nothing";
  // A number reads as it was saved: the log and a preview say exactly what a row holds (11.99, not 12.0).
  if (typeof v === "number") return String(v);
  return formatValue(v, undefined, false);
}

/** A saved row in a few words: its first fields, without the time it was saved. */
function rowWords(row: Row): string {
  const fields = Object.entries(row).filter(([k, v]) => k !== "at" && v !== null && v !== "" && v !== undefined);
  const words = fields.slice(0, 3).map(([k, v]) => `${k} ${shown(v)}`).join(", ");
  return fields.length > 3 ? `${words}, …` : words;
}

/**
 * One kind of change: what it did, as the log says it; what it would do, as a dry run says it; and
 * how it's undone, either in the note's frontmatter (which is checked on a copy first, and only
 * while the note still holds what the app wrote) or through the vault.
 */
interface ChangeKind<C extends Change> {
  done(c: C, note: string): string;
  ahead(c: C, note: string): string;
  undo: { inFrontmatter(c: C, fm: Record<string, unknown>, note: string): Refusal } | { inVault(c: C, io: UndoIO, note: string): Promise<Refusal> };
}

const CHANGES: { [K in Change["kind"]]: ChangeKind<Extract<Change, { kind: K }>> } = {
  "row-added": {
    done: (c, note) => `Saved ${rowWords(c.row) ? `${rowWords(c.row)} ` : "a row "}to ${c.list} in ${note}`,
    ahead: (c, note) => `Save ${rowWords(c.row) ? `${rowWords(c.row)} ` : "a row "}to ${c.list} in ${note}`,
    undo: {
      inFrontmatter(c, fm, note) {
        const list = listIn(fm, c.list);
        const i = list ? list.findLastIndex((r) => same(r, c.row)) : -1;
        if (!list || i < 0) return `the row it saved in ${note} has changed or is gone`;
        fm[c.list] = list.filter((_, j) => j !== i);
        return undefined;
      },
    },
  },
  "row-edited": {
    done: (c, note) => `Changed ${c.field} from ${shown(c.from)} to ${shown(c.to)} in ${c.list} in ${note}`,
    ahead: (c, note) => `Change ${c.field} from ${shown(c.from)} to ${shown(c.to)} in ${c.list} in ${note}`,
    undo: {
      inFrontmatter(c, fm, note) {
        const list = listIn(fm, c.list);
        const i = list ? list.findLastIndex((r) => same(r, c.row)) : -1;
        if (!list || i < 0) return `the row it changed in ${note} has changed again or is gone`;
        const row = { ...(list[i] as Row) };
        if (c.from === undefined) delete row[c.field];
        else row[c.field] = c.from;
        fm[c.list] = list.map((r, j) => (j === i ? row : r));
        return undefined;
      },
    },
  },
  "row-deleted": {
    done: (c, note) => `Deleted ${rowWords(c.row) ? `${rowWords(c.row)} ` : "a row "}from ${c.list} in ${note}`,
    ahead: (c, note) => `Delete ${rowWords(c.row) ? `${rowWords(c.row)} ` : "a row "}from ${c.list} in ${note}`,
    undo: {
      inFrontmatter(c, fm, note) {
        const list = listIn(fm, c.list);
        if (!list) return `${c.list} in ${note} is gone`;
        // Back where it was, unless the list has grown shorter than that since.
        const at = c.index !== undefined && c.index <= list.length ? c.index : list.length;
        fm[c.list] = [...list.slice(0, at), c.row, ...list.slice(at)];
        return undefined;
      },
    },
  },
  checklist: {
    done: (c) => `${c.checked ? "Ticked" : "Unticked"} “${c.item}”`,
    ahead: (c) => `${c.checked ? "Tick" : "Untick"} “${c.item}”`,
    undo: {
      inFrontmatter(c, fm) {
        const list = (listIn(fm, c.list) ?? []).map(String);
        if (list.includes(c.item) !== c.checked) return `“${c.item}” has been ${c.checked ? "unticked" : "ticked"} since`;
        fm[c.list] = c.checked ? list.filter((i) => i !== c.item) : [...list, c.item];
        return undefined;
      },
    },
  },
  cleared: {
    done: (c) => `Cleared ${c.items.length} ticked ${c.items.length === 1 ? "item" : "items"}`,
    ahead: (c) => `Clear ${c.items.length} ticked ${c.items.length === 1 ? "item" : "items"}`,
    undo: {
      inFrontmatter(c, fm) {
        if ((listIn(fm, c.list) ?? []).length) return "something has been ticked since";
        fm[c.list] = [...c.items];
        return undefined;
      },
    },
  },
  property: {
    done: (c, note) => `Set ${c.field} of ${note} to ${shown(c.to)}${c.had ? ` (was ${shown(c.from)})` : ""}`,
    ahead: (c, note) => `Set ${c.field} of ${note} to ${shown(c.to)}${c.had ? ` (now ${shown(c.from)})` : ""}`,
    undo: {
      inFrontmatter(c, fm, note) {
        if (!same(fm[c.field], c.to)) return `${c.field} in ${note} has changed since`;
        if (c.had) fm[c.field] = c.from;
        else delete fm[c.field];
        return undefined;
      },
    },
  },
  "line-added": {
    done: (c, note) => `${c.created ? `Created ${note} with` : `Added to ${note}`} the line “${c.line}”`,
    ahead: (c, note) => (c.created ? `Create ${note} with the line “${c.line}”` : `Add the line “${c.line}” to ${note}`),
    undo: {
      async inVault(c, io, note) {
        if (c.created) {
          const trashed = await io.trashIf(c.path, (text) => text === withLine("", c.line));
          if (trashed === "trashed") return undefined;
          if (trashed === "gone") return `${note} is gone`;
        }
        let refusal: Refusal;
        const written = await io.processText(c.path, (text) => {
          const next = withoutLine(text, c.line);
          if (next === undefined) refusal = `the line it added to ${note} has changed or is gone`;
          return next ?? text;
        });
        return written ? refusal : `${note} is gone`;
      },
    },
  },
  "note-created": {
    done: (_c, note) => `Created the note ${note}`,
    ahead: (_c, note) => `Create the note ${note}`,
    undo: {
      async inVault(c, io, note) {
        const trashed = await io.trashIf(c.path, (text) => textHash(text) === c.hash);
        if (trashed === "trashed") return undefined;
        return trashed === "gone" ? `${note} is gone already` : `${note} has been changed since; delete it yourself if you mean to`;
      },
    },
  },
  task: {
    done: (c, note) => `${c.done ? "Ticked" : "Unticked"} “${c.text}” in ${note}`,
    ahead: (c, note) => `${c.done ? "Tick" : "Untick"} “${c.text}” in ${note}`,
    undo: {
      inVault: async (c, io, note) => ((await io.setTaskDone(c.path, c.line, c.text, !c.done)) ? undefined : `the task “${c.text}” in ${note} has changed or is gone`),
    },
  },
};

const kindOf = (c: Change) => CHANGES[c.kind] as unknown as ChangeKind<Change>;

/**
 * Undoes a change to a note's frontmatter in place, only while the note still holds what the app
 * wrote; otherwise leaves it untouched and says why.
 */
export function undoInFrontmatter(change: Change, fm: Record<string, unknown>): Refusal {
  const undo = kindOf(change).undo;
  return "inFrontmatter" in undo ? undo.inFrontmatter(change, fm, basename(change.path)) : "that isn't a change to properties";
}

/** Undoes one change, re-checking it as it writes; a refusal when the vault no longer holds what the app wrote. */
async function undoOne(change: Change, io: UndoIO): Promise<Refusal> {
  const note = basename(change.path);
  // A change kept as an event is undone by another event, which holds after later edits and on every device.
  if ("event" in change && change.event && io.undoEvents) {
    await io.undoEvents(change.path, [change.event]);
    return undefined;
  }
  const undo = kindOf(change).undo;
  if ("inVault" in undo) return undo.inVault(change, io, note);
  const cached = io.frontmatter(change.path);
  if (!cached) return `${note} is gone`;
  // Checked on a copy first, so an undo that can't go ahead doesn't rewrite the note.
  const first = undo.inFrontmatter(change, structuredClone(cached), note);
  if (first) return first;
  let refusal: Refusal;
  const written = await io.updateFrontmatter(change.path, (fm) => { refusal = undo.inFrontmatter(change, fm, note); });
  return written ? refusal : `${note} is gone`;
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
    // Changes kept as events of one note, newest first, are taken back by one event: a batch of
    // hundreds of rows is one write, not hundreds.
    const events = io.undoEvents ? eventRun(entry.changes, total - undone) : [];
    if (events.length > 1) {
      try {
        await io.undoEvents!(change.path, events);
      } catch (e) {
        return { undone, total, refusal: (e as Error).message };
      }
      undone += events.length;
      continue;
    }
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

/** The events of the changes before `end` that are kept as events of the same note as the last of them, newest first. */
function eventRun(changes: readonly Change[], end: number): string[] {
  const path = changes[end - 1].path;
  const out: string[] = [];
  for (let i = end - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.path !== path || !("event" in c) || !c.event) break;
    out.push(c.event);
  }
  return out;
}

/** What an undo did, as a notice says it. */
export function undoMessage(r: UndoResult): string {
  if (!r.refusal) return r.total === 1 ? "Undone" : `Undid all ${r.total} changes`;
  const what = r.undone ? `Undid ${r.undone} of ${r.total}, then stopped` : "Couldn't undo it";
  return `${what}: ${r.refusal}`;
}

/** A change as a plain sentence. */
export function describeChange(c: Change): string {
  return kindOf(c).done(c, basename(c.path));
}

/**
 * A change as said under the panel that made it, where the list and note it is in go without
 * saying: "Changed status from idea to doing" rather than the log's "… in projects in Board".
 */
export function sayChange(c: Change): string {
  if (c.kind === "row-edited") return `Changed ${c.field} from ${shown(c.from)} to ${shown(c.to)}`;
  if (c.kind === "row-added") return rowWords(c.row) ? `Saved ${rowWords(c.row)}` : "Saved a row";
  if (c.kind === "row-deleted") return rowWords(c.row) ? `Deleted ${rowWords(c.row)}` : "Deleted a row";
  return describeChange(c);
}

/** A change a run would make, worded as what it is about to do (a dry run's list). */
export function describeAhead(c: Change): string {
  return kindOf(c).ahead(c, basename(c.path));
}

/** A value an app sent out, answering a link. */
export function describeSent(what: string, sent: { to: string; shown: string }): string {
  return `Sent “${what}” (${sent.shown}) to ${sent.to}`;
}

/** Who acted, as the log says it. */
export function describeActor(a: Actor): string {
  if (a === "you") return "You";
  if (a === "shortcut") return "A shortcut";
  if (a === "link") return "A link";
  if (a === "import") return "A file in an import folder";
  if (a === "share") return "Someone you share the kind with";
  return `Triggered by ${a.slice("trigger:".length)}`;
}
