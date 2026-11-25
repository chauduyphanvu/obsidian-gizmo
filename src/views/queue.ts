import { handler } from "../handler.ts";
import { rove, roving, UP_DOWN } from "./common.ts";

/**
 * A list of things that wait for the person (rows from a file to check, asks), worked from the
 * keyboard with Next's keys: ↑ ↓ move, Enter does the first thing, x the second, s skips; where one
 * action can take several at once, Space selects and ⇧Enter takes the selection, else all of them.
 * After a key does something the list is drawn again, and the focus comes back to the same place.
 */

export interface QueueItem {
  /** Tells the item apart across redraws: a row's id. */
  key: string;
  el: HTMLElement;
  /** Enter. */
  primary?: () => Promise<unknown>;
  /** x. */
  secondary?: () => Promise<unknown>;
  /** s. */
  skip?: () => Promise<unknown>;
}

export interface QueueOpts {
  /** What stays put while the list is drawn again (the panel, the header): its focus and selection are kept by it. */
  home: object;
  /** ⇧Enter: the selected items' keys, or undefined to take them all. */
  all?: (keys: string[] | undefined) => Promise<unknown>;
  /** Space selects, and this bar (empty until something is) says how many with what takes them. */
  select?: { bar: HTMLElement; actions: [label: string, run: (keys: string[]) => Promise<unknown>][] };
  /** Runs one action with every control of the list off until it is done. */
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

interface Kept {
  /** Where a key last acted: drawn again soon after with the focus lost, it goes back there. */
  focus?: { key: string; index: number; until: number };
  selected: Set<string>;
}

const KEPT = new WeakMap<object, Kept>();

/** Whether nothing has the focus in the document `el` is drawn in. */
function lost(el: HTMLElement): boolean {
  const active = el.ownerDocument.activeElement;
  return !active || active === el.ownerDocument.body;
}
/** How long after a key acts the redrawn list takes the focus back. */
const REFOCUS_MS = 4000;

export function queue(list: HTMLElement, items: QueueItem[], opts: QueueOpts): void {
  const kept = KEPT.get(opts.home) ?? { selected: new Set<string>() };
  KEPT.set(opts.home, kept);
  const present = new Set(items.map((i) => i.key));
  for (const k of kept.selected) if (!present.has(k)) kept.selected.delete(k);

  roving(list, UP_DOWN);
  list.classList.add("gz-queue");
  const keys = ["↑↓ move", items.some((i) => i.primary) && "Enter", items.some((i) => i.secondary) && "x", items.some((i) => i.skip) && "s", opts.select && "Space", opts.all && "Shift+Enter"].filter(Boolean);
  for (const item of items) {
    item.el.classList.add("gz-queue-row");
    item.el.setAttribute("aria-keyshortcuts", keys.slice(1).join(" "));
    rove(item.el);
    mark(item);
  }

  const drawBar = () => {
    const bar = opts.select?.bar;
    if (!bar) return;
    bar.empty();
    bar.classList.toggle("is-shown", kept.selected.size > 0);
    if (!kept.selected.size) return;
    bar.createSpan({ cls: "gz-queue-count", text: `${kept.selected.size} selected` });
    for (const [label, run] of opts.select!.actions) {
      bar.createEl("button", { cls: "gz-small", text: label }).addEventListener("click", handler(() => opts.run(() => run([...kept.selected]))));
    }
    bar.createEl("button", { cls: "gz-small gz-quiet", text: "Clear" }).addEventListener("click", () => {
      kept.selected.clear();
      for (const i of items) mark(i);
      drawBar();
    });
  };
  function mark(item: QueueItem): void {
    if (!opts.select) return;
    const on = kept.selected.has(item.key);
    item.el.classList.toggle("is-selected", on);
    item.el.setAttribute("aria-selected", String(on));
  }
  drawBar();

  list.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const index = items.findIndex((i) => i.el === e.target);
    if (index < 0) return;
    const item = items[index];
    const act = (fn: (() => Promise<unknown>) | undefined) => {
      if (!fn) return;
      e.preventDefault();
      kept.focus = { key: item.key, index, until: Date.now() + REFOCUS_MS };
      void opts.run(fn);
    };
    if (e.key === "Enter" && e.shiftKey) {
      const chosen = kept.selected.size ? [...kept.selected] : undefined;
      act(opts.all && (() => opts.all!(chosen)));
    } else if (e.key === "Enter") act(item.primary);
    else if (e.key === "x" && !e.shiftKey) act(item.secondary);
    else if (e.key === "s" && !e.shiftKey) act(item.skip);
    else if (e.key === " " && opts.select) {
      e.preventDefault();
      if (kept.selected.has(item.key)) kept.selected.delete(item.key);
      else kept.selected.add(item.key);
      mark(item);
      drawBar();
    }
  });

  // Drawn again soon after a key acted here, and the focus went with the old list: back to the same
  // item if it is still there, else the one now in its place. A list may be drawn more than once
  // for one write, so this holds for a while rather than once; focus moved elsewhere is left alone.
  const f = kept.focus;
  if (!f || Date.now() > f.until) kept.focus = undefined;
  else if (items.length && lost(list)) (items.find((i) => i.key === f.key) ?? items[Math.min(f.index, items.length - 1)]).el.focus();
}
