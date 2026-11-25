import type { BackgroundEnv } from "./background.ts";

/**
 * What an alert with `then` ran for (whether its value condition held, or which rows matched), where
 * a rhythm got to, an app's pause, or until when an ask is skipped here.
 */
export type Fired = { on: boolean } | { rows: string[] } | { decided: number } | { paused: number; reason: string; told?: true } | { skipped: number };

/** The version of what alerts ran for, as kept on disk. */
const FIRED_VERSION = 2;

/** Where an app's pause is kept in `fired`: beside its rhythms' `expect:<rule>`, never a panel's key. */
export const pausedKey = (path: string) => `${path}\npaused:`;

/**
 * What this device's alerts ran for, where its rhythms got to and when its pauses began, by keys that
 * start with an app's path, and the asks skipped here: its `triggers` file, read once, and written
 * when it changes, one write after another.
 */
export class FiredStore {
  private env: Pick<BackgroundEnv, "triggers" | "otherTriggers">;
  private fired: Promise<Record<string, Fired>> | undefined;
  private firedSaved = "{}";
  private firedSaving: Promise<void> = Promise.resolve();

  constructor(env: Pick<BackgroundEnv, "triggers" | "otherTriggers">) {
    this.env = env;
  }

  /**
   * What alerts ran for, as kept. Kept in a version it knows, or not at all: rows were once told
   * apart by when they were saved and now by their id, and reading the old keys would run every
   * matching row's then again; an unknown version starts over, as a new runner does.
   */
  state(): Promise<Record<string, Fired>> {
    this.fired ??= (async () => {
      try {
        const text = await this.env.triggers?.read();
        const parsed = text ? JSON.parse(text) as { v?: unknown; fired?: unknown } : undefined;
        this.firedSaved = text ?? "";
        const fired = parsed?.v === FIRED_VERSION ? parsed.fired : undefined;
        return fired && typeof fired === "object" && !Array.isArray(fired) ? fired as Record<string, Fired> : {};
      } catch {
        return {};
      }
    })();
    return this.fired;
  }

  /** Writes what alerts ran for when it changed, one write after another. */
  save(): void {
    void this.fired?.then((fired) => {
      const text = JSON.stringify({ v: FIRED_VERSION, fired });
      if (text === this.firedSaved) return;
      this.firedSaved = text;
      this.firedSaving = this.firedSaving.then(() => this.env.triggers?.write(text)).catch(() => {});
    });
  }

  /**
   * Background work was just turned on here: alerts note what is true now and run their `then`
   * only for what turns true after, never for everything that changed while another device ran them.
   */
  startOver(): void {
    const before = this.state();
    this.fired = (async () => {
      const others = await this.otherFired();
      return carryOver(await before, others.map((o) => o.fired), others.filter((o) => o.lately).map((o) => o.fired));
    })();
    this.save();
  }

  /** What the other devices kept of their alerts and rhythms, in a version this one knows. */
  private async otherFired(): Promise<{ fired: Record<string, Fired>; lately: boolean }[]> {
    const files = await this.env.otherTriggers?.().catch(() => []) ?? [];
    return files.flatMap(({ text, lately }) => {
      try {
        const parsed = JSON.parse(text) as { v?: unknown; fired?: unknown };
        return parsed.v === FIRED_VERSION && parsed.fired && typeof parsed.fired === "object" && !Array.isArray(parsed.fired) ? [{ fired: parsed.fired as Record<string, Fired>, lately }] : [];
      } catch {
        return [];
      }
    });
  }

  /** Moves what was kept under one app path to another; what was kept there is replaced. */
  move(from: string, to: string): void {
    const prefix = `${from}\n`;
    void this.state().then((fired) => {
      let moved = false;
      for (const key of Object.keys(fired)) {
        if (!key.startsWith(prefix)) continue;
        fired[to + key.slice(from.length)] = fired[key];
        delete fired[key];
        moved = true;
      }
      if (moved) this.save();
    });
  }

  /** Drops what was kept for an app but its panels in `keep`; read already or not at all, so there is nothing to drop before. */
  drop(path: string, keep: ReadonlySet<string>): void {
    void this.fired?.then((fired) => {
      let gone = false;
      for (const key of Object.keys(fired)) {
        if (!key.startsWith(`${path}\n`) || keep.has(key.replace(/\ntold$/, ""))) continue;
        delete fired[key];
        gone = true;
      }
      if (gone) this.save();
    });
  }
}

/**
 * What a device taking over background work keeps: alerts start over (they note what is true now and
 * run their `then` only for what turns true after), while rhythms, pauses and its own skips carry on.
 * Each rhythm goes on from the latest point any device decided it to, so a window nobody decided
 * while devices changed over is still decided, and one already decided elsewhere isn't decided again.
 * An alert told here, or by a device heard from lately (`told`), isn't told again while it stays true;
 * what a device long gone told is old news, and doesn't keep one quiet.
 */
export function carryOver(mine: Record<string, Fired>, others: readonly Record<string, Fired>[], told: readonly Record<string, Fired>[] = []): Record<string, Fired> {
  const out: Record<string, Fired> = {};
  for (const [key, value] of Object.entries(mine)) if ("paused" in value || "decided" in value || "skipped" in value || key.endsWith("\ntold")) out[key] = value;
  for (const fired of told) for (const [key, value] of Object.entries(fired)) if (key.endsWith("\ntold") && !(key in out)) out[key] = value;
  for (const fired of others) {
    for (const [key, value] of Object.entries(fired)) {
      if (!("decided" in value) || typeof value.decided !== "number") continue;
      const had = out[key];
      if (!had || !("decided" in had) || had.decided < value.decided) out[key] = { decided: value.decided };
    }
  }
  return out;
}
