/** How long a figure takes to count up to a new value; the meter's fill moves in the same time (styles.css). */
export const COUNT_MS = 240;

/** The window `el` is drawn in, when it can animate: it draws frames, and its reader hasn't asked for less motion. */
function animates(el: Element): Window | undefined {
  const win = el.ownerDocument.defaultView;
  if (!win || typeof win.requestAnimationFrame !== "function") return undefined;
  return typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches ? undefined : win;
}

/**
 * Count-up for one mounted figure: when its value changes while shown, it runs from the value shown
 * to the new one over COUNT_MS, easing out. The first value, one that isn't a number, and any value
 * where the window can't animate (or the reader asked for less motion) are shown as drawn. While it
 * counts, its element has the class `gz-counting`.
 */
export class CountUp {
  /** The value on show, mid-count included; undefined before the first, or after one that isn't a number. */
  shown: number | undefined;
  private frame = 0;
  private win: Window | undefined;
  private el: Element | undefined;

  /**
   * Shows `to`, already drawn as the final value: when it counts, `draw` gets each value on the way
   * and `to` last. With `whole`, a count between whole numbers stays in whole numbers, for a figure
   * that would otherwise show the fractions on the way. Returns whether it counts.
   */
  to(el: Element, to: number | undefined, draw: (n: number) => void, whole = false): boolean {
    this.stop();
    const from = this.shown;
    this.shown = to;
    const win = from !== undefined && to !== undefined && from !== to ? animates(el) : undefined;
    if (!win) return false;
    const steps = whole && Number.isInteger(from) && Number.isInteger(to);
    let start: number | undefined;
    const step = (t: number) => {
      start ??= t;
      const k = Math.min(1, (t - start) / COUNT_MS);
      const n = k === 1 ? to! : from! + (to! - from!) * (1 - (1 - k) ** 3);
      this.shown = steps ? Math.round(n) : n;
      draw(this.shown);
      if (k === 1) this.stop();
      else this.frame = win.requestAnimationFrame(step);
    };
    this.win = win;
    this.el = el;
    el.classList.add("gz-counting");
    this.shown = from;
    draw(from!);
    this.frame = win.requestAnimationFrame(step);
    return true;
  }

  /** Stops a count in flight; `shown` keeps the value it reached. */
  stop(): void {
    if (this.frame) this.win?.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.el?.classList.remove("gz-counting");
    this.el = undefined;
  }
}
