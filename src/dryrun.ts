import type { Change } from "./activity.ts";
import { noteText, withLine, type ActionDeps } from "./actions.ts";
import { tickLine } from "./sources/tasks.ts";

/** Where an overlay reads a note the first time it is touched; nothing is ever written back. */
export interface OverlaySource {
  frontmatter(path: string): Record<string, unknown> | undefined;
  /** The note's whole text, or undefined when there is no such note. */
  text(path: string): Promise<string | undefined>;
  exists(path: string): boolean;
}

/**
 * Copies of the notes a run changes, each made the first time it is touched, so the run's own
 * writes (the same functions a real run uses) change the copies and the vault is never written.
 */
export class Overlay {
  private source: OverlaySource;
  /** Frontmatter by path; null for a note that isn't there (yet). */
  private fms = new Map<string, Record<string, unknown> | null>();
  /** Whole texts by path, for appended lines and ticked tasks; null for a note that isn't there. */
  private texts = new Map<string, string | null>();
  /** Notes the run changed, in the order it changed them. */
  readonly touched: string[] = [];
  private listeners = new Set<(path: string) => void>();

  constructor(source: OverlaySource) {
    this.source = source;
  }

  /** The note's frontmatter as the run left it; undefined when there is no such note. */
  frontmatter(path: string): Record<string, unknown> | undefined {
    if (!this.fms.has(path)) {
      const fm = this.source.frontmatter(path);
      this.fms.set(path, fm ? structuredClone(fm) : this.source.exists(path) ? {} : null);
    }
    return this.fms.get(path) ?? undefined;
  }

  async text(path: string): Promise<string | undefined> {
    if (!this.texts.has(path)) this.texts.set(path, (await this.source.text(path)) ?? null);
    return this.texts.get(path) ?? undefined;
  }

  exists(path: string): boolean {
    if (this.fms.has(path)) return this.fms.get(path) !== null;
    if (this.texts.has(path)) return this.texts.get(path) !== null;
    return this.source.exists(path);
  }

  /** Calls `cb` with the note after each change; returns how to stop. */
  onChange(cb: (path: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(path: string): void {
    if (!this.touched.includes(path)) this.touched.push(path);
    for (const cb of [...this.listeners]) cb(path);
  }

  /** As Obsidian's processFrontMatter: the note is made when it isn't there. */
  writeFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): void {
    const had = this.frontmatter(path);
    const fm = had ?? {};
    fn(fm);
    this.fms.set(path, fm);
    if (!had) this.texts.set(path, "");
    this.changed(path);
  }

  /** Changes an existing note's frontmatter; false when there is no such note. */
  updateFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): boolean {
    const fm = this.frontmatter(path);
    if (!fm) return false;
    fn(fm);
    this.changed(path);
    return true;
  }

  /** Adds a line at the end of a note, making it when there's none; true when it made it. */
  async appendLine(path: string, line: string): Promise<boolean> {
    const before = await this.text(path);
    this.texts.set(path, withLine(before ?? "", line));
    if (before === undefined && !this.fms.get(path)) this.fms.set(path, {});
    this.changed(path);
    return before === undefined;
  }

  /** Makes a note; its text, or false when one is already at that path. */
  createNote(path: string, frontmatter: Record<string, unknown>, body: string): string | false {
    if (this.exists(path)) return false;
    // Only its frontmatter is read back; the text stands in for the one Obsidian would write.
    const text = noteText(Object.keys(frontmatter).length ? JSON.stringify(frontmatter) : "", body);
    this.fms.set(path, structuredClone(frontmatter));
    this.texts.set(path, text);
    this.changed(path);
    return text;
  }

  async setTaskDone(path: string, line: number, text: string, done: boolean): Promise<boolean> {
    const before = await this.text(path);
    const next = before === undefined ? undefined : tickLine(before, line, text, done);
    if (next === undefined) return false;
    this.texts.set(path, next);
    this.changed(path);
    return true;
  }
}

/** What one app would do in a dry run: what it would change and tell. */
export interface DryStep {
  app: string;
  what: string;
  changes: Change[];
  notices: string[];
}

/**
 * Action deps that write to an overlay and keep what they would have changed and told, for a run
 * that only shows what it would do. `base` gives the time and reads templates; it is never written with.
 */
export function recordingDeps(overlay: Overlay, base: Pick<ActionDeps, "now" | "readBody" | "appPath" | "dataPath">, step: DryStep): ActionDeps {
  return {
    now: () => base.now(),
    appPath: base.appPath,
    dataPath: base.dataPath,
    readBody: (path) => base.readBody(path),
    writeFrontmatter: async (path, fn) => overlay.writeFrontmatter(path, fn),
    appendLine: (path, line) => overlay.appendLine(path, line),
    createNote: async (path, fm, body) => overlay.createNote(path, fm, body),
    notify: (message) => { step.notices.push(message); },
    openNote: (path) => { step.notices.push(`It would open ${path}`); },
    log: (what, changes) => {
      step.what = what;
      step.changes.push(...changes);
    },
  };
}
