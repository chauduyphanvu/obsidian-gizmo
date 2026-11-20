import { violationText, type Verdict } from "./flows.ts";
import { pausedKey, type FiredStore } from "./background-fired.ts";
import type { AppEntry, BackgroundEnv, PausedApp } from "./background.ts";
import { PENDING_MS } from "./identity.ts";
import { describePermission } from "./permissions.ts";

/**
 * How long an app is paused before it is told: two beats, so a component edit that syncs here before
 * the data.json allowing it doesn't tell of a pause that ends a minute later.
 */
export const PAUSE_TELL_MS = 10 * 60_000;

/** What pausing apps needs of the Background. */
export interface PausesHost {
  fired: FiredStore;
  verdictNow(entry: AppEntry): Verdict | undefined;
  /** Takes an app's status items and alerts off the screen, keeping what it was doing. */
  hide(path: string): void;
  /** Drops what was kept for an app, which starts over when allowed. */
  forget(path: string): void;
  say(message: string): void;
}

/** Apps that were allowed and stopped matching their grant: paused, told of once, and resumed when allowed again. */
export class Pauses {
  private env: BackgroundEnv;
  private fired: FiredStore;
  private verdictNow: PausesHost["verdictNow"];
  private hide: PausesHost["hide"];
  private forget: PausesHost["forget"];
  private say: PausesHost["say"];
  /** Apps paused here, by path; the list last published. */
  private pausedNow = new Map<string, PausedApp>();
  private pausedShown = "[]";

  constructor(env: BackgroundEnv, host: PausesHost) {
    this.env = env;
    this.fired = host.fired;
    this.verdictNow = host.verdictNow;
    this.hide = host.hide;
    this.forget = host.forget;
    this.say = host.say;
  }

  /**
   * An app that isn't allowed now. Paused when it was allowed and now asks for more, or the policy
   * refuses it: it keeps where its rhythms and alerts got to, and the device running background work
   * tells of it once it has lasted PAUSE_TELL_MS. Otherwise (revoked, never allowed) it is forgotten,
   * and starts over when allowed.
   */
  async pauseOrForget(entry: AppEntry): Promise<void> {
    const why = this.pauseReason(entry);
    if (!why) {
      // Renamed elsewhere, its grant still on its way here by sync: what it carried waits for it.
      if (entry.carried !== undefined && this.env.now().getTime() - entry.carried < PENDING_MS && this.env.granted(entry.path) === undefined) return this.hide(entry.path);
      return this.forget(entry.path);
    }
    this.hide(entry.path);
    const fired = await this.fired.state();
    const key = pausedKey(entry.path);
    const was = fired[key];
    const now = this.env.now().getTime();
    const since = was && "paused" in was ? was.paused : now;
    this.pausedNow.set(entry.path, { path: entry.path, name: entry.name, reason: why.reason, since });
    this.publish();
    if (!was || !("paused" in was) || was.reason !== why.reason) {
      fired[key] = { paused: since, reason: why.reason };
      this.fired.save();
      if (now - since < PAUSE_TELL_MS) return;
    } else if (was.told || now - since < PAUSE_TELL_MS) return;
    if (!this.env.runsBackground()) return;
    fired[key] = { paused: since, reason: why.reason, told: true };
    this.fired.save();
    const text = `${entry.name} is paused in the background: it ${why.reason}. ${why.next}`;
    if (!this.env.quietAlerts?.()) this.say(text);
    this.env.sink.alert?.({ app: entry.name, panel: "paused in the background", text });
  }

  /** Why an app that was allowed doesn't run now, and what to do; undefined when it was never allowed or was revoked. */
  private pauseReason(entry: AppEntry): { reason: string; next: string } | undefined {
    const before = this.env.granted(entry.path);
    if (before === undefined) return undefined;
    const verdict = this.verdictNow(entry);
    if (verdict?.violations.length) return { reason: `breaks your data policy (${violationText(verdict.violations[0])})`, next: "Open it to see why." };
    const missing = (verdict?.asked ?? entry.wanted).filter((p) => !before.includes(p));
    if (!missing.length) return undefined;
    const asks = missing.map((p) => describePermission(p)).map((d) => d.charAt(0).toLowerCase() + d.slice(1));
    return { reason: `now asks to ${asks.join("; ")}`, next: "Open it to allow it." };
  }

  /** An app allowed again after a pause: its rhythms decide what they missed meanwhile, on this tick. */
  async resume(entry: AppEntry): Promise<void> {
    if (this.pausedNow.delete(entry.path)) this.publish();
    const fired = await this.fired.state();
    const was = fired[pausedKey(entry.path)];
    if (!was || !("paused" in was)) return;
    delete fired[pausedKey(entry.path)];
    this.fired.save();
    entry.pausedSince = was.paused;
  }

  /** An app that is gone or forgotten is no longer listed as paused. */
  drop(path: string): void {
    if (this.pausedNow.delete(path)) this.publish();
  }

  /** Apps paused here, by name. */
  paused(): PausedApp[] {
    return [...this.pausedNow.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private publish(): void {
    const list = this.paused();
    const json = JSON.stringify(list.map((p) => [p.path, p.reason]));
    if (json === this.pausedShown) return;
    this.pausedShown = json;
    this.env.sink.setPaused?.(list);
  }
}
