import type { Row } from "./data.ts";
import type { Panel } from "./spec.ts";
import type { TimerState } from "./views/registry.ts";
import { formatClock } from "./time.ts";

/** What an app's timers need of it. */
export interface TimerSite {
  /** The drawn panel a timer belongs to, by the panel's key. */
  panel(key: string): { el: HTMLElement; p: Panel } | undefined;
  notify(message: string): void;
  runActions(p: Panel, row: Row): Promise<unknown>;
  redraw(key: string): void;
}

/**
 * An app's countdown timers, by panel key. Their states are kept in the app's memory; one tick a
 * second serves them all, running only while one counts down.
 */
export class Timers {
  private states: Map<string, TimerState>;
  private site: TimerSite;
  private tickHandle: number | undefined;

  constructor(states: Map<string, TimerState>, site: TimerSite) {
    this.states = states;
    this.site = site;
  }

  state(key: string, p: Panel): TimerState {
    let s = this.states.get(key);
    if (!s) this.states.set(key, (s = { remainingMs: p.minutes! * 60_000 }));
    return s;
  }

  start(key: string, p: Panel): void {
    const s = this.state(key, p);
    s.endsAt = Date.now() + s.remainingMs;
    this.startTicking();
  }

  pause(key: string): void {
    const s = this.states.get(key);
    if (s?.endsAt) { s.remainingMs = s.endsAt - Date.now(); s.endsAt = undefined; }
  }

  reset(key: string, p: Panel): void {
    this.states.set(key, { remainingMs: p.minutes! * 60_000 });
  }

  /** Timers kept in memory from an earlier drawing of this app go on counting. */
  resume(): void {
    if ([...this.states.values()].some((s) => s.endsAt)) this.startTicking();
  }

  /** A panel that is gone takes its timer with it. */
  forget(key: string): void {
    this.states.delete(key);
  }

  stop(): void {
    if (this.tickHandle) window.clearInterval(this.tickHandle);
    this.tickHandle = undefined;
  }

  private startTicking(): void {
    this.tickHandle ??= window.setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    let running = false;
    for (const [key, s] of this.states) {
      if (!s.endsAt) continue;
      const left = s.endsAt - Date.now();
      const m = this.site.panel(key);
      const clock = m?.el.querySelector(`[data-gz-timer="${key}"]`);
      if (clock) clock.textContent = formatClock(left);
      if (left > 0) { running = true; continue; }
      this.states.set(key, { remainingMs: (m?.p.minutes ?? 0) * 60_000 });
      this.site.notify(`${m?.p.title ?? "Timer"} finished`);
      if (m) void this.site.runActions(m.p, { minutes: m.p.minutes }).then(() => this.site.redraw(key));
    }
    if (!running) this.stop();
  }
}
