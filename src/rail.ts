/**
 * The time rail under an app's title: every change the app made in the last 30 days as a tick, and
 * a handle at the time the app shows. Dragging the handle, or stepping with `[` and `]`, shows the
 * app as it was at a change; "Back to now" shows it as it is.
 */
import { describeChange, doneAt, type Entry } from "./activity.ts";
import { DAY } from "./time.ts";

/** How many days the rail spans, today included. */
export const RAIL_DAYS = 30;
/** Past this share of the track, a drag means now. */
const NOW_FROM = 0.985;
/** How long the keys rest before the app is shown at the time they stepped to. */
export const STEP_MS = 250;

/** One change on the rail: when all of it was made, and the entry it is. */
export interface Tick {
  at: number;
  entry: Entry;
}

/** The rail's window, from midnight 29 days ago to now, and its changes in it, oldest first. */
export interface RailModel {
  start: number;
  now: number;
  ticks: Tick[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const midnight = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** Whole days from a's day to b's, right across a change of clocks. */
const daysBetween = (a: number, b: number) => Math.round((midnight(b) - midnight(a)) / DAY);
const addDays = (t: number, n: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};

/** `Nov 11` */
export function shortDate(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** `Wed Nov 11` */
export function dayDate(t: number): string {
  return `${DAYS[new Date(t).getDay()]} ${shortDate(t)}`;
}

/** `8:51 AM`, or however the person's locale writes the time of day. */
export function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Today, Yesterday, a weekday within the last six days, else `Wed Nov 11`. */
export function relativeDay(t: number, now: number): string {
  const k = daysBetween(t, now);
  if (k === 0) return "Today";
  if (k === 1) return "Yesterday";
  if (k > 1 && k < 7) return WEEKDAYS[new Date(t).getDay()];
  return dayDate(t);
}

/**
 * The rail for an app's entries (in any order) at `now`: the ones in the window, oldest first,
 * leaving out those whose every change was undone and those that only sent something out.
 */
export function railModel(entries: Entry[], now: number): RailModel {
  const start = addDays(midnight(now), -(RAIL_DAYS - 1));
  const ticks = entries
    .filter((e) => e.changes.length > 0 && e.undone < e.changes.length)
    .map((entry) => ({ at: doneAt(entry), entry }))
    .filter((t) => t.at >= start && t.at <= now)
    .sort((a, b) => a.at - b.at);
  return { start, now, ticks };
}

/** Where a time sits along the track, 0 to 100. */
export function pct(m: RailModel, t: number): number {
  const span = m.now - m.start;
  const p = span > 0 ? ((t - m.start) / span) * 100 : 100;
  return Math.round(Math.max(0, Math.min(100, p)) * 1000) / 1000;
}

/** The time a drag to `t` shows: the last change at or before it, the window's start before any, or now (undefined) at the track's end. */
export function snap(m: RailModel, t: number): number | undefined {
  if (pct(m, t) >= NOW_FROM * 100) return undefined;
  let best = m.start;
  for (const tick of m.ticks) {
    if (tick.at > t) break;
    best = tick.at;
  }
  return best;
}

/**
 * One change back (-1) or forward (1) from the time shown, undefined being now. Now already shows
 * the latest change, so back from now hides it, and forward from the change before it is now again.
 * Back from the first change is the window's start, before any of them.
 */
export function step(m: RailModel, asOf: number | undefined, dir: -1 | 1): number | undefined {
  const times = [...new Set(m.ticks.map((t) => t.at))];
  if (!times.length) return asOf;
  const cur = asOf ?? Infinity;
  let k = -1;
  times.forEach((t, i) => { if (t <= cur) k = i; });
  if (dir < 0) {
    if (k > 0) return times[k - 1];
    return asOf !== undefined && asOf < m.start ? asOf : m.start;
  }
  if (asOf === undefined) return undefined;
  return k + 1 >= times.length - 1 ? undefined : times[k + 1];
}

/** `Now`, or `As of Yesterday, 8:51 AM`. */
export function railLabel(asOf: number | undefined, now: number): string {
  return asOf === undefined ? "Now" : `As of ${relativeDay(asOf, now)}, ${clock(asOf)}`;
}

/** `Wed Nov 18, 4:45 PM · Log: Saved n 7 to steps in Steps data`: one change, as hovering its tick says it. */
export function tickLabel(t: Tick): string {
  const first = t.entry.changes[0];
  return `${dayDate(t.at)}, ${clock(t.at)} · ${t.entry.what}${first ? `: ${describeChange(first)}` : ""}`;
}

/** `66 changes in 30 days`, or in the past how many of them it hides. */
export function railCount(m: RailModel, asOf: number | undefined): string {
  if (asOf === undefined) {
    const n = m.ticks.length;
    return n ? `${n} ${n === 1 ? "change" : "changes"} in ${RAIL_DAYS} days` : `No changes in ${RAIL_DAYS} days`;
  }
  const later = m.ticks.filter((t) => t.at > asOf).length;
  return later ? `${later} later ${later === 1 ? "change" : "changes"} hidden` : "No later changes";
}

/** The scale under the track: the window's first day, 10 and 20 days on, and today. */
export function railScale(m: RailModel): { text: string; at: number }[] {
  return [
    ...[0, 10, 20].map((n) => ({ text: shortDate(addDays(m.start, n)), at: addDays(m.start, n) })),
    { text: "Today", at: m.now },
  ];
}

/** Whether a key went to something being typed in. */
export function typing(evt: KeyboardEvent): boolean {
  const el = evt.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/**
 * The rail's element and what it does. `show` shows the app at a time (undefined for now); the
 * owner calls `sync` once the app shows it, and `update` when the app's changes do.
 */
export class TimeRail {
  readonly el: HTMLElement;
  private label: HTMLElement;
  private meta: HTMLElement;
  private track: HTMLElement;
  private handle: HTMLElement;
  private scale: HTMLElement;
  private ticks: { tick: Tick; el: HTMLElement }[] = [];
  private model: RailModel;
  /** No count shows until the app's changes are first read, so it never says there are none when there are. */
  private loaded = false;
  /** The time the app shows, and the time the rail shows, which runs ahead of it while dragging or stepping. */
  private shown: number | undefined;
  private at: number | undefined;
  private hover: Tick | undefined;
  private dragging = false;
  private timer: number | undefined;
  private metaFor = "";
  private show: (at: number | undefined) => void;

  constructor(show: (at: number | undefined) => void, now = Date.now()) {
    this.show = show;
    this.model = railModel([], now);
    this.el = createDiv({ cls: "gz-rail" });
    const top = this.el.createDiv({ cls: "gz-rail-top" });
    this.label = top.createSpan({ cls: "gz-rail-label" });
    this.meta = top.createSpan({ cls: "gz-rail-meta" });
    this.track = this.el.createDiv({
      cls: "gz-rail-track",
      attr: { role: "slider", tabindex: 0, "aria-label": "Show the app as of a past time", "aria-valuemin": 0, "aria-valuemax": 100 },
    });
    this.handle = this.track.createSpan({ cls: "gz-rail-handle" });
    this.scale = this.el.createDiv({ cls: "gz-rail-scale" });
    this.listen();
    this.drawTicks();
    this.paint();
  }

  /** The app's activity entries, and the time now. */
  update(entries: Entry[], now = Date.now()): void {
    this.loaded = true;
    this.model = railModel(entries, now);
    const hovered = this.hover?.entry.id;
    this.hover = this.model.ticks.find((t) => t.entry.id === hovered);
    this.drawTicks();
    this.paint();
  }

  /** The app now shows this time, undefined being now. */
  sync(shown: number | undefined): void {
    this.cancel();
    this.shown = shown;
    this.at = shown;
    this.paint();
  }

  /** One change back or forward: at once on the rail, and in the app once the steps stop. */
  step(dir: -1 | 1): void {
    this.at = step(this.model, this.at, dir);
    this.paint();
    this.cancel();
    this.timer = window.setTimeout(() => this.commit(), STEP_MS);
  }

  /** Shows the app as it is now. */
  back(): void {
    this.at = undefined;
    this.commit();
  }

  /** Whether the rail shows the past, or is about to. */
  get past(): boolean {
    return this.at !== undefined || this.shown !== undefined;
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Shows the app at the rail's time, if that isn't what it shows already. */
  private commit(): void {
    this.cancel();
    this.paint();
    if (this.at === this.shown) return;
    // Showing another time draws the app again, the rail moving with it: the track keeps its focus.
    const focused = this.track.ownerDocument.activeElement === this.track;
    this.show(this.at);
    if (focused) this.track.focus({ preventScroll: true });
  }

  private timeAt(x: number): number {
    const r = this.track.getBoundingClientRect();
    const k = r.width ? (x - r.left) / r.width : 1;
    return this.model.start + k * (this.model.now - this.model.start);
  }

  private listen(): void {
    const track = this.track;
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      track.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.hover = undefined;
      this.cancel();
      this.at = snap(this.model, this.timeAt(e.clientX));
      this.paint();
    });
    track.addEventListener("pointermove", (e) => {
      if (this.dragging) {
        // The handle follows the pointer without easing once it moves; a click alone eases there.
        this.el.classList.add("is-dragging");
        this.at = snap(this.model, this.timeAt(e.clientX));
        this.paint();
        return;
      }
      const t = this.timeAt(e.clientX);
      let near: Tick | undefined;
      let best = Infinity;
      for (const tick of this.model.ticks) {
        const d = Math.abs(tick.at - t);
        if (d <= best) {
          best = d;
          near = tick;
        }
      }
      const hover = best < (this.model.now - this.model.start) * 0.012 ? near : undefined;
      if (hover === this.hover) return;
      this.hover = hover;
      this.paint();
    });
    const end = (cancelled: boolean) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.classList.remove("is-dragging");
      if (cancelled) this.at = this.shown;
      this.commit();
    };
    track.addEventListener("pointerup", () => end(false));
    track.addEventListener("pointercancel", () => end(true));
    track.addEventListener("pointerleave", () => {
      if (this.dragging || !this.hover) return;
      this.hover = undefined;
      this.paint();
    });
    track.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      this.step(e.key === "ArrowLeft" ? -1 : 1);
    });
  }

  private drawTicks(): void {
    for (const t of this.ticks) t.el.remove();
    this.ticks = this.model.ticks.map((tick) => {
      const el = this.track.createEl("i", { cls: "gz-rail-tick" });
      this.track.insertBefore(el, this.handle);
      el.style.left = `${pct(this.model, tick.at)}%`;
      return { tick, el };
    });
    this.scale.empty();
    for (const s of railScale(this.model)) this.scale.createSpan({ text: s.text }).style.left = `${pct(this.model, s.at)}%`;
  }

  /** Draws what changes as the time shown moves: the label, the count, the later ticks and the handle. */
  private paint(): void {
    const m = this.model;
    const at = this.at;
    this.el.classList.toggle("is-past", at !== undefined);
    const label = railLabel(at, m.now);
    this.label.setText(this.hover ? tickLabel(this.hover) : label);
    const cur = at ?? m.now;
    for (const { tick, el } of this.ticks) {
      el.classList.toggle("is-later", tick.at > cur);
      el.classList.toggle("is-hover", tick === this.hover);
    }
    this.handle.style.left = `${pct(m, cur)}%`;
    this.track.setAttr("aria-valuenow", Math.round(pct(m, cur)));
    this.track.setAttr("aria-valuetext", label);
    const count = this.loaded ? railCount(m, at) : "";
    const metaFor = `${at === undefined}|${count}|${m.ticks.length > 0}`;
    if (metaFor === this.metaFor) return;
    this.metaFor = metaFor;
    this.meta.empty();
    if (!this.loaded) return;
    this.meta.createSpan({ cls: "gz-rail-count", text: count });
    if (at !== undefined) {
      this.meta.createEl("button", { cls: "gz-rail-now", text: "Back to now", attr: { type: "button" } }).addEventListener("click", () => this.back());
    } else if (m.ticks.length) {
      this.meta.createEl("kbd", { text: "[" });
      this.meta.createEl("kbd", { text: "]" });
    }
  }
}
