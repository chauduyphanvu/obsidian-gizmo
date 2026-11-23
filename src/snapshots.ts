import type { Host } from "./datalayer.ts";
import type { Ledger } from "./ledger-store.ts";
import { heldInNote } from "./kind.ts";
import { isKind } from "./store.ts";

/** How long after a change a data note's snapshot is written, in Obsidian and gizmod. */
export const SNAPSHOT_DELAY_MS = 5000;
/** The least time between two snapshots of a note with recorded lists, in Obsidian and gizmod. */
export const SNAPSHOT_GAP_MS = 5 * 60_000;

/** Who writes the ledger's snapshots into data notes: only the device that runs background work. */
export interface Snapshots {
  isRunner(): boolean;
  /** How long after a change the snapshot is written, so a burst of changes makes one write. */
  delayMs: number;
  /** The least time between two snapshots of a note with recorded lists, so a list sampled every minute isn't rewritten every minute. */
  gapMs: number;
  /** Runs `fn` after `ms` on this runtime's timers, and returns what cancels it. */
  later(fn: () => void, ms: number): () => void;
  writeNote(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
}

/** Writes each data note's snapshot of its ledger: a little after a change, now when asked, and what's waiting on quit. */
export class SnapshotWriter {
  private host: Pick<Host, "now" | "frontmatter">;
  private ledger: Ledger | undefined;
  private deviceNotes: (folder: string) => Record<string, unknown>[];
  private snapshots: Snapshots | undefined;
  /** Each data note's app note, and its folder of old device notes, as the panels reading it said. */
  private appOf = new Map<string, { appPath: string; devices?: string }>();
  private snapshotTimers = new Map<string, { cancel: () => void; due: number }>();
  /** When each data note's snapshot was last written. */
  private snapshotted = new Map<string, number>();

  constructor(host: Pick<Host, "now" | "frontmatter">, ledger: Ledger | undefined, deviceNotes: (folder: string) => Record<string, unknown>[]) {
    this.host = host;
    this.ledger = ledger;
    this.deviceNotes = deviceNotes;
  }

  /** Who writes snapshots, and how; until set, none are written. */
  set(s: Snapshots | undefined): void {
    this.snapshots = s;
  }

  /** The app note whose lists a data note keeps (for the lists typed in it), and its old device notes' folder. */
  noteApp(dataPath: string, appPath: string, devices?: string): void {
    this.appOf.set(dataPath, { appPath, devices });
  }

  /**
   * The note whose lists a data note keeps, as the panels reading it said; before any did, a kind's
   * own note for its data note, whose rows it holds only some of.
   */
  private ownerOf(dataPath: string): { appPath: string; devices?: string } | undefined {
    const known = this.appOf.get(dataPath);
    if (known) return known;
    const kind = / data\.md$/i.test(dataPath) ? dataPath.replace(/ data\.md$/i, ".md") : undefined;
    return kind !== undefined && isKind(this.host.frontmatter(kind)) ? { appPath: kind } : undefined;
  }

  private writeSnapshot(dataPath: string, s: Snapshots, ledger: Ledger): Promise<void> {
    this.snapshotted.set(dataPath, this.host.now());
    const app = this.ownerOf(dataPath);
    const appFm = (app && this.host.frontmatter(app.appPath)) || {};
    return ledger.snapshot(dataPath, appFm, (fn) => s.writeNote(dataPath, fn), false, app?.devices ? this.deviceNotes(app.devices) : [], heldInNote(appFm)).catch(() => {});
  }

  /**
   * Writes a data note's snapshot a little after its ledger last changed, when this device is the one
   * that does. A note with recorded lists is written at most once a gap, so samples coming in wait for
   * the gap's end; any other note, a few seconds after what a person saved.
   */
  soon(dataPath: string): void {
    const s = this.snapshots;
    const ledger = this.ledger;
    if (!s || !ledger || !s.isRunner()) return;
    const now = this.host.now();
    const gap = ledger.recorded(dataPath) ? s.gapMs : 0;
    const due = Math.max(now + s.delayMs, (this.snapshotted.get(dataPath) ?? -Infinity) + gap);
    const waiting = this.snapshotTimers.get(dataPath);
    // One waiting for the gap to end keeps its time; one waiting for changes to stop waits again.
    if (waiting && waiting.due > now + s.delayMs) return;
    waiting?.cancel();
    const cancel = s.later(() => {
      this.snapshotTimers.delete(dataPath);
      void this.writeSnapshot(dataPath, s, ledger);
    }, due - now);
    this.snapshotTimers.set(dataPath, { cancel, due });
  }

  /**
   * Writes a data note's snapshot now, from any device: after Import or Discard, `force` writes it
   * over a hand edit.
   */
  async now(dataPath: string, force: boolean): Promise<void> {
    const s = this.snapshots;
    const ledger = this.ledger;
    if (!s || !ledger) return;
    const app = this.ownerOf(dataPath);
    const appFm = (app && this.host.frontmatter(app.appPath)) || {};
    await ledger.snapshot(dataPath, appFm, (fn) => s.writeNote(dataPath, fn), force, app?.devices ? this.deviceNotes(app.devices) : [], heldInNote(appFm));
  }

  /** Stops waiting snapshots: the plugin is going, and the runner writes them next time. */
  dispose(): void {
    for (const t of this.snapshotTimers.values()) t.cancel();
    this.snapshotTimers.clear();
  }

  /** Writes now the snapshots waiting to be written. */
  async flush(): Promise<void> {
    const s = this.snapshots;
    const ledger = this.ledger;
    if (!s || !ledger) return;
    const waiting = [...this.snapshotTimers.keys()];
    for (const dataPath of waiting) {
      this.snapshotTimers.get(dataPath)!.cancel();
      this.snapshotTimers.delete(dataPath);
      await this.writeSnapshot(dataPath, s, ledger);
    }
  }
}
