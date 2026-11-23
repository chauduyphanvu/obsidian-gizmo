/**
 * What each app's panels said, each time an app was opened with different keys: so a figure that
 * moved can say that its own keys changed, and when, beside the rows that moved it. Kept by this
 * device, for the apps opened on it, in a file of its own in the plugin's folder.
 */
import type { LogStore } from "./activity.ts";
import { stableJson } from "./hash.ts";
import type { PanelSpec } from "./spec.ts";

/** An app's panels at one time: each panel's keys as typed, as JSON, by the panel's name. */
interface Version {
  at: number;
  panels: Record<string, string>;
}

/** A change to one panel's keys: when it was first seen, and which keys differ from before. */
export interface KeysChange {
  at: number;
  keys: string[];
}

/** Versions kept for one app; the oldest go first. */
const MAX_VERSIONS = 40;

/** What a panel is called across edits of its keys: its title, else its label, else its place. */
export function panelName(ps: PanelSpec, index: number): string {
  const t = ps.template;
  return typeof t.title === "string" ? t.title : typeof t.label === "string" ? t.label : `panel ${index + 1}`;
}

/** An app's panels as kept: the keys as typed, without what expansion added. */
export function panelsOf(panels: readonly PanelSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  panels.forEach((ps, i) => { out[panelName(ps, i)] = stableJson(typedKeys(ps.template)); });
  return out;
}

const INTERNAL = ["upstream", "schema", "vars", "rowVars", "target", "targetFields", "secrets", "kept", "fieldInfo", "kind"];

function typedKeys(template: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(template).filter(([k]) => !INTERNAL.includes(k)));
}

/** The keys whose values differ between two panels' keys, kept as JSON. */
function differing(before: string | undefined, after: string | undefined): string[] {
  const read = (text: string | undefined) => (text === undefined ? {} : JSON.parse(text) as Record<string, unknown>);
  const [a, b] = [read(before), read(after)];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stableJson(a[k] ?? null) !== stableJson(b[k] ?? null));
}

export class DefinitionLog {
  private store: LogStore;
  private now: () => number;
  private kept: Record<string, Version[]> | undefined;
  /** Writes wait for each other, so two apps opened together don't write over one another. */
  private writing: Promise<void> = Promise.resolve();

  constructor(store: LogStore, now: () => number) {
    this.store = store;
    this.now = now;
  }

  private async all(): Promise<Record<string, Version[]>> {
    if (this.kept) return this.kept;
    let read: unknown;
    try {
      read = JSON.parse((await this.store.read()) ?? "{}");
    } catch {
      // A file cut short by a sync starts again; only what changed keys from here on is lost.
      read = {};
    }
    this.kept ??= read !== null && typeof read === "object" && !Array.isArray(read) ? read as Record<string, Version[]> : {};
    return this.kept;
  }

  /** An app was read with these panels: kept when they differ from the last ones kept for it. */
  seen(path: string, panels: Record<string, string>): Promise<void> {
    this.writing = this.writing.then(async () => {
      const all = await this.all();
      const versions = all[path] ?? [];
      const last = versions[versions.length - 1];
      if (last && stableJson(last.panels) === stableJson(panels)) return;
      all[path] = [...versions, { at: this.now(), panels }].slice(-MAX_VERSIONS);
      await this.store.write(JSON.stringify(all));
    }).catch(() => {});
    return this.writing;
  }

  /** Each change to one panel's keys seen after a time (ms), the oldest first; none when it never changed, or wasn't opened here before then. */
  async since(path: string, panel: string, t: number): Promise<KeysChange[]> {
    const versions = (await this.all())[path] ?? [];
    const out: KeysChange[] = [];
    for (let i = 1; i < versions.length; i++) {
      if (versions[i].at <= t) continue;
      const keys = differing(versions[i - 1].panels[panel], versions[i].panels[panel]);
      if (keys.length) out.push({ at: versions[i].at, keys });
    }
    return out;
  }

  /** A note was moved: what was kept for it goes with it. */
  renamed(from: string, to: string): Promise<void> {
    this.writing = this.writing.then(async () => {
      const all = await this.all();
      if (!all[from]) return;
      all[to] = all[from];
      delete all[from];
      await this.store.write(JSON.stringify(all));
    }).catch(() => {});
    return this.writing;
  }
}
