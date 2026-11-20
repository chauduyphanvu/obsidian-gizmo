import { noteText, withLine } from "./actions.ts";
import { isPolicyPath } from "./policy.ts";
import { tickLine } from "./sources/tasks.ts";

/** The least a host does with files: Obsidian's vault, or gizmod's folder on disk. */
export interface VaultFiles {
  /** A path as the host spells it (Obsidian normalizes slashes and spaces). */
  normalize(path: string): string;
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  /** Writes a file whole. */
  write(path: string, text: string): Promise<void>;
  /** Makes a new file and its folders; throws when one is there. */
  create(path: string, text: string): Promise<void>;
  /** Changes a note's frontmatter in one read-and-write, keeping the rest of the note. */
  processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  /** Changes a file's text in one read-and-write, when the host has its own (Obsidian's keeps an open editor in step). */
  process?(path: string, fn: (text: string) => string): Promise<void>;
  /** Adds text at the end of an existing file. */
  append(path: string, text: string): Promise<void>;
  trash?(path: string): Promise<void>;
  /** After a write failed: whether the file is gone from the disk though the host still lists it. */
  vanished?(path: string): Promise<boolean>;
}

/** Writing notes as apps do, the same on every host. */
export interface VaultWrites {
  /** Changes a note's frontmatter, making the note when there's none. */
  writeFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  /** Changes an existing note's frontmatter; false, writing nothing, when the note is gone. */
  updateFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<boolean>;
  /** Adds a line at the end of a note, making it when there's none; true when it made it. */
  appendLine(path: string, line: string): Promise<boolean>;
  /** Makes a note; its text, or false when one is already there. Never overwrites. */
  createNote(path: string, frontmatter: Record<string, unknown>, body: string): Promise<string | false>;
  /** Ticks or unticks a task; false, writing nothing, when it can't be found for sure. */
  setTaskDone(path: string, line: number, text: string, done: boolean): Promise<boolean>;
  /** Changes an existing note's text in one read-and-write; false when the note is gone. */
  processText(path: string, fn: (text: string) => string): Promise<boolean>;
  /** Moves a note to the trash while `unchanged(text)` holds. */
  trashIf(path: string, unchanged: (text: string) => boolean): Promise<"trashed" | "changed" | "gone">;
  /** Adds text at the end of a file (a ledger's log), making it and its folders when there's none. */
  appendFile(path: string, text: string): Promise<void>;
  /** Writes a file whole (base.json, a checkpoint), making it and its folders when there's none. */
  writeFile(path: string, text: string): Promise<void>;
}

/**
 * Writes to notes through a host's files: one write to a note at a time, across every app; never
 * to the policy note; and each change made from the text as it is when written, read again just
 * before writing and made again when another program wrote the note meanwhile.
 */
export function vaultWrites(files: VaultFiles, yaml: (fm: Record<string, unknown>) => string): VaultWrites {
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(given: string, write: (path: string) => Promise<T>): Promise<T> => {
    const path = files.normalize(given);
    // The policy says what apps may do with data, so no app may change it; a person edits it by hand.
    if (isPolicyPath(path)) return Promise.reject(new Error(`${given} is your Gizmo policy; apps can't change it`));
    const run = (queues.get(path) ?? Promise.resolve()).then(() => write(path), () => write(path));
    const settled = run.catch(() => {});
    queues.set(path, settled);
    void settled.finally(() => { if (queues.get(path) === settled) queues.delete(path); });
    return run;
  };
  /** A write that failed because its note vanished a moment before (another program deleted or moved it) writes nothing. */
  const unlessVanished = async (path: string, write: () => Promise<void>): Promise<boolean> => {
    try {
      await write();
      return true;
    } catch (e) {
      if (await files.vanished?.(path)) return false;
      throw e;
    }
  };
  const process = async (path: string, fn: (text: string) => string): Promise<void> => {
    if (files.process) return files.process(path, fn);
    for (let attempt = 0; ; attempt++) {
      const before = await files.read(path);
      const next = fn(before);
      if (next === before) return;
      // Written over only as it was read: an edit made meanwhile is read and the change made again.
      if ((await files.read(path)) !== before && attempt < 3) continue;
      await files.write(path, next);
      return;
    }
  };
  return {
    writeFrontmatter: (given, fn) => queued(given, async (path) => {
      if (!files.exists(path)) await files.create(path, "");
      await files.processFrontmatter(path, fn);
    }),
    updateFrontmatter: (given, fn) => queued(given, async (path) => files.exists(path) && unlessVanished(path, () => files.processFrontmatter(path, fn))),
    appendLine: (given, line) => queued(given, async (path) => {
      if (files.exists(path)) {
        await process(path, (text) => withLine(text, line));
        return false;
      }
      await files.create(path, withLine("", line));
      return true;
    }),
    createNote: (given, frontmatter, body) => queued(given, async (path) => {
      if (files.exists(path)) return false;
      const text = noteText(Object.keys(frontmatter).length ? yaml(frontmatter) : "", body);
      try {
        await files.create(path, text);
      } catch (e) {
        // Made in the meantime (a double click, another device): it already exists, as above.
        if (files.exists(path)) return false;
        throw e;
      }
      return text;
    }),
    setTaskDone: (given, line, text, done) => queued(given, async (path) => {
      if (!files.exists(path)) return false;
      let ticked = false;
      const written = await unlessVanished(path, () => process(path, (data) => {
        const next = tickLine(data, line, text, done);
        ticked = next !== undefined;
        return next ?? data;
      }));
      return written && ticked;
    }),
    processText: (given, fn) => queued(given, async (path) => {
      if (!files.exists(path)) return false;
      await process(path, fn);
      return true;
    }),
    trashIf: (given, unchanged) => queued(given, async (path) => {
      if (!files.exists(path) || !files.trash) return "gone" as const;
      if (!unchanged(await files.read(path))) return "changed" as const;
      await files.trash(path);
      return "trashed" as const;
    }),
    appendFile: (given, text) => queued(given, (path) => (files.exists(path) ? files.append(path, text) : files.create(path, text))),
    writeFile: (given, text) => queued(given, (path) => (files.exists(path) ? files.write(path, text) : files.create(path, text))),
  };
}
