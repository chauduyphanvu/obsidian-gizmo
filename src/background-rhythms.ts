import { metIn, windowDay, windowsDue, type Rhythm, type Window } from "./expect.ts";
import { rowId as ledgerRowId } from "./ledger.ts";
import { storeOf } from "./actions.ts";
import type { FiredStore } from "./background-fired.ts";
import type { AppEntry, Background, BackgroundEnv } from "./background.ts";
import { rowsOf } from "./data.ts";
import { stampOf } from "./time.ts";

/** Where a rhythm's misses are kept, in the app's data note. */
export const EXPECT_MISSED = "expect_missed";

/** A rhythm missed while nothing ran (Obsidian closed, no gizmod): told for at most this many of its latest windows. */
const MAX_CATCH_UP = 3;

/** Decides apps' rhythms (`expect:` rules with a deadline) on the device that runs background work. */
export class Rhythms {
  private env: BackgroundEnv;
  private fired: FiredStore;
  private evaluate: Background["evaluate"];
  private runThen: Background["runThen"];
  private say: (message: string) => void;

  constructor(env: BackgroundEnv, fired: FiredStore, evaluate: Background["evaluate"], runThen: Background["runThen"], say: (message: string) => void) {
    this.env = env;
    this.fired = fired;
    this.evaluate = evaluate;
    this.runThen = runThen;
    this.say = say;
  }

  /**
   * Decides each rhythm's deadlines that passed since it last decided, once: a window with no row
   * by its deadline is a miss, kept in the data note's `expect_missed` under an id made from the
   * rule and window (so two runners keep it once and only the first tells it), told, and its then
   * run. A rule seen for the first time starts from now; one that can't be read now waits a tick.
   */
  async run(entry: AppEntry): Promise<void> {
    if (!this.env.runsBackground()) {
      entry.pausedSince = undefined;
      return;
    }
    const rules = entry.spec.expect.filter((r): r is Rhythm => r.kind === "rhythm");
    // A tick that comes while the last is still deciding leaves it to that one.
    if (!rules.length || entry.deciding) return;
    entry.deciding = true;
    try {
      await this.decide(entry, rules);
    } finally {
      entry.deciding = false;
    }
  }

  private async decide(entry: AppEntry, rules: Rhythm[]): Promise<void> {
    const fired = await this.fired.state();
    const now = this.env.now();
    const zone = this.env.zone?.();
    for (const rule of rules) {
      const key = `${entry.path}\nexpect:${rule.id}`;
      const before = fired[key];
      if (!before || !("decided" in before)) {
        fired[key] = { decided: now.getTime() };
        this.fired.save();
        continue;
      }
      const due = windowsDue(rule, before.decided, now.getTime(), zone);
      if (!due.length) continue;
      const ps = entry.spec.expected[rule.id];
      const r = ps && (await this.evaluate(entry.path, ps, true));
      if (!r || !("panel" in r)) continue;
      const rows = rowsOf(r.rows);
      // Every window missed is kept; only the newest few are told, the rest were long ago.
      const misses = due.filter((w) => !metIn(rows, rule, w, now));
      for (const [i, w] of misses.entries()) {
        const whilePaused = entry.pausedSince !== undefined && w.deadline >= entry.pausedSince;
        await this.missed(entry, rule, w, zone, i >= misses.length - MAX_CATCH_UP, whilePaused);
      }
      fired[key] = { decided: due.at(-1)!.deadline };
      this.fired.save();
    }
    entry.pausedSince = undefined;
  }

  private async missed(entry: AppEntry, rule: Rhythm, w: Window, zone: string | undefined, tell: boolean, whilePaused: boolean): Promise<void> {
    // Named by its date where the person is, so two devices, or one that moved zone, keep it once.
    const window = windowDay(w, zone);
    const seed = `miss\n${entry.path}\n${rule.id}\n${window}`;
    const deps = this.env.actionDeps(entry.path, entry.dataPath);
    const { already } = await storeOf(deps).add(EXPECT_MISSED, { rule: rule.id, window, at: stampOf(this.env.now()) }, { id: ledgerRowId(seed) });
    if (already || !tell) return;
    const text = `${entry.name}: ${rule.say ?? `${rule.id} wasn't done by ${rule.byText}`}${whilePaused ? ` (${window}, missed while paused)` : ""}`;
    this.say(text);
    this.env.sink.alert?.({ app: entry.name, panel: rule.say ?? rule.id, text });
    if (rule.then) await this.runThen(entry.path, rule.then, { rule: rule.id, window }, [], undefined, seed);
  }
}
