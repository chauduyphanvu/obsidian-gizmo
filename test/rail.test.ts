import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Change, Entry } from "../src/activity.ts";
import { STEP_MS, TimeRail, clock, railCount, railLabel, railModel, snap, step, tickLabel } from "../src/rail.ts";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
/** Friday 20 November 2026, 3 PM: the rail runs from midnight on Thursday 22 October. */
const NOW = local(2026, 11, 20, 15, 0);
const START = local(2026, 10, 22);
const DAY_MS = 86_400_000;
const spaces = (s: string) => s.replace(/\s/g, " ");

const saved = (n: number, event?: string): Change => ({ kind: "row-added", path: "Apps/Steps data.md", list: "steps", row: { n }, ...(event && { event }) });
let ids = 0;
function entry(at: number, more: Partial<Entry> = {}): Entry {
  return { id: `e${ids++}`, at, app: "Apps/Steps.md", actor: "you", what: "Log", changes: [saved(at % 100)], undone: 0, ...more };
}

test("the rail spans midnight 29 days ago to now and holds the changes in it, oldest first", () => {
  const inside = [entry(START), entry(local(2026, 11, 18, 16, 45)), entry(NOW - 60_000)];
  const m = railModel([entry(START - 1), inside[2], inside[0], entry(NOW + 60_000), inside[1]], NOW);
  assert.equal(m.start, START);
  assert.equal(m.now, NOW);
  assert.deepEqual(m.ticks.map((t) => t.entry.id), inside.map((e) => e.id));
});

test("a change wholly undone, and one that only sent something out, are not on the rail; one partly undone is", () => {
  const two = [saved(1), saved(2)];
  const kept = [entry(NOW - 5000, { changes: two, undone: 1 }), entry(NOW - 4000)];
  const m = railModel([
    entry(NOW - 9000, { undone: 1 }),
    entry(NOW - 8000, { changes: two, undone: 2 }),
    entry(NOW - 7000, { changes: [], sent: { to: "Shortcuts", shown: "7" } }),
    ...kept,
  ], NOW);
  assert.deepEqual(m.ticks.map((t) => t.entry.id), kept.map((e) => e.id));
});

test("a change stands on the rail when its last event was written, if that came after its entry", () => {
  const wall = NOW - 1000;
  const e = entry(NOW - 3000, { changes: [saved(1, `dev1@${new Date(wall).toISOString()}/0`)] });
  assert.equal(railModel([e], NOW).ticks[0].at, wall);
});

test("a drag shows the last change at or before the pointer, the window's start before any, and now at the end of the track", () => {
  const a = local(2026, 11, 1, 9), b = local(2026, 11, 10, 9);
  const m = railModel([entry(a), entry(b)], NOW);
  assert.equal(snap(m, START + 1000), START);
  assert.equal(snap(m, a - 1), START);
  assert.equal(snap(m, a), a);
  assert.equal(snap(m, local(2026, 11, 5)), a);
  assert.equal(snap(m, local(2026, 11, 19)), b);
  const end = START + (NOW - START) * 0.985;
  assert.equal(snap(m, end - 60_000), b);
  assert.equal(snap(m, end), undefined);
  assert.equal(snap(m, NOW + DAY_MS), undefined);
});

test("stepping back from now hides the latest change; forward from the one before it is now again", () => {
  const [a, b, c] = [local(2026, 11, 1, 9), local(2026, 11, 10, 9), local(2026, 11, 19, 9)];
  const m = railModel([entry(c), entry(a), entry(b)], NOW);
  assert.equal(step(m, undefined, -1), b);
  assert.equal(step(m, b, -1), a);
  assert.equal(step(m, a, -1), START, "back from the first change is before any of them");
  assert.equal(step(m, START, -1), START);
  assert.equal(step(m, START, 1), a);
  assert.equal(step(m, a, 1), b);
  assert.equal(step(m, b, 1), undefined, "forward from the second-to-last change is now");
  assert.equal(step(m, c, 1), undefined);
  assert.equal(step(m, undefined, 1), undefined);
  // From a time between changes (As of…), a step goes to the change before or after the one shown.
  assert.equal(step(m, local(2026, 11, 5), -1), START);
  assert.equal(step(m, local(2026, 11, 5), 1), b);
  // From before the window, back stays put rather than jumping forward to its start.
  assert.equal(step(m, START - DAY_MS, -1), START - DAY_MS);
});

test("with one change, back from now is before it and forward is now; with none, a step stays put; changes at one moment are one step", () => {
  const a = local(2026, 11, 10, 9);
  const one = railModel([entry(a)], NOW);
  assert.equal(step(one, undefined, -1), START);
  assert.equal(step(one, START, 1), undefined);
  const none = railModel([], NOW);
  assert.equal(step(none, undefined, -1), undefined);
  assert.equal(step(none, a, 1), a);
  const b = local(2026, 11, 12, 9);
  const twins = railModel([entry(a), entry(b), entry(b), entry(NOW - 1000)], NOW);
  assert.equal(step(twins, undefined, -1), b);
  assert.equal(step(twins, b, -1), a);
});

test("the label says Now, or As of a day and a time: Today, Yesterday, a weekday within six days, else the date", () => {
  assert.equal(railLabel(undefined, NOW), "Now");
  const at = (t: number, day: string) => assert.equal(railLabel(t, NOW), `As of ${day}, ${clock(t)}`);
  at(local(2026, 11, 20, 8, 51), "Today");
  at(local(2026, 11, 19, 8, 51), "Yesterday");
  at(local(2026, 11, 18, 23, 59), "Wednesday");
  at(local(2026, 11, 14, 9), "Saturday");
  at(local(2026, 11, 13, 9), "Fri Nov 13");
  at(local(2026, 11, 11, 9), "Wed Nov 11");
  if (Intl.DateTimeFormat().resolvedOptions().locale === "en-US") {
    assert.equal(spaces(railLabel(local(2026, 11, 19, 8, 51), NOW)), "As of Yesterday, 8:51 AM");
  }
});

test("hovering a tick says when it was and what it did", () => {
  const t = local(2026, 11, 18, 16, 45);
  const [tick] = railModel([entry(t, { changes: [saved(7), saved(8)] })], NOW).ticks;
  assert.equal(tickLabel(tick), `Wed Nov 18, ${clock(t)} · Log: Saved n 7 to steps in Steps data`);
});

test("the count says how many changes are in the window, or in the past how many later ones are hidden", () => {
  const m = railModel([entry(local(2026, 11, 1, 9)), entry(local(2026, 11, 10, 9)), entry(local(2026, 11, 19, 9))], NOW);
  assert.equal(railCount(m, undefined), "3 changes in 30 days");
  assert.equal(railCount(m, local(2026, 11, 1, 9)), "2 later changes hidden");
  assert.equal(railCount(m, local(2026, 11, 10, 9)), "1 later change hidden");
  assert.equal(railCount(m, local(2026, 11, 19, 9)), "No later changes");
  assert.equal(railCount(railModel([entry(NOW - 1000)], NOW), undefined), "1 change in 30 days");
  assert.equal(railCount(railModel([], NOW), undefined), "No changes in 30 days");
});

// ---- The element ------------------------------------------------------------------------------

function rail(entries: Entry[]) {
  const shown: (number | undefined)[] = [];
  const r = new TimeRail((at) => shown.push(at), NOW);
  document.body.appendChild(r.el);
  r.update(entries, NOW);
  const q = (sel: string) => r.el.querySelector(sel) as HTMLElement | null;
  const all = (sel: string) => [...r.el.querySelectorAll(sel)] as HTMLElement[];
  return { r, shown, q, all };
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

test("the rail draws a tick per change where it falls, the handle at now, and a scale ending at Today", () => {
  const mid = START + (NOW - START) / 2;
  const { r, q, all } = rail([entry(START), entry(mid), entry(NOW - 1000)]);
  assert.equal(q(".gz-rail-label")?.textContent, "Now");
  assert.equal(q(".gz-rail-meta .gz-rail-count")?.textContent, "3 changes in 30 days");
  assert.deepEqual(all(".gz-rail-meta kbd").map((k) => k.textContent), ["[", "]"]);
  const ticks = all(".gz-rail-track i.gz-rail-tick");
  assert.equal(ticks.length, 3);
  assert.equal(ticks[0].style.left, "0%");
  assert.equal(ticks[1].style.left, "50%");
  assert.equal(all(".gz-rail-tick.is-later").length, 0);
  assert.equal(q(".gz-rail-handle")?.style.left, "100%");
  const track = q(".gz-rail-track")!;
  assert.equal(track.getAttribute("role"), "slider");
  assert.equal(track.getAttribute("tabindex"), "0");
  assert.equal(track.getAttribute("aria-label"), "Show the app as of a past time");
  assert.equal(track.getAttribute("aria-valuetext"), "Now");
  const scale = all(".gz-rail-scale span");
  assert.deepEqual(scale.map((s) => s.textContent), ["Oct 22", "Nov 1", "Nov 11", "Today"]);
  assert.equal(scale[0].style.left, "0%");
  assert.equal(scale[3].style.left, "100%");
  assert.ok(!r.el.classList.contains("is-past"));
  r.el.remove();
});

test("in the past the later ticks fade, the count says how many are hidden, and Back to now shows now", () => {
  const [a, b, c] = [local(2026, 11, 1, 9), local(2026, 11, 10, 9), local(2026, 11, 19, 9)];
  const { r, shown, q, all } = rail([entry(a), entry(b), entry(c)]);
  r.sync(a);
  assert.ok(r.el.classList.contains("is-past"));
  assert.equal(q(".gz-rail-label")?.textContent, railLabel(a, NOW));
  assert.equal(q(".gz-rail-track")?.getAttribute("aria-valuetext"), railLabel(a, NOW));
  assert.equal(all(".gz-rail-tick.is-later").length, 2);
  assert.equal(q(".gz-rail-meta .gz-rail-count")?.textContent, "2 later changes hidden");
  assert.equal(all(".gz-rail-meta kbd").length, 0);
  const back = q("button.gz-rail-now")!;
  assert.equal(back.textContent, "Back to now");
  back.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(shown, [undefined]);
  r.el.remove();
});

test("with no changes in 30 days the rail still shows, with no ticks and no keys", () => {
  const { r, q, all } = rail([entry(START - 1)]);
  assert.equal(q(".gz-rail-meta")?.textContent, "No changes in 30 days");
  assert.equal(all(".gz-rail-tick").length, 0);
  assert.equal(all(".gz-rail-scale span").length, 4);
  assert.equal(q(".gz-rail-label")?.textContent, "Now");
  r.el.remove();
});

test("no count shows until the app's changes are read", () => {
  const r = new TimeRail(() => {}, NOW);
  assert.equal(r.el.querySelector(".gz-rail-meta")?.textContent, "");
  assert.equal(r.el.querySelector(".gz-rail-label")?.textContent, "Now");
});

test("steps move the rail at once and show the app once they stop", async () => {
  const [a, b, c] = [local(2026, 11, 1, 9), local(2026, 11, 10, 9), local(2026, 11, 19, 9)];
  const { r, shown, q, all } = rail([entry(a), entry(b), entry(c)]);
  r.step(-1);
  r.step(-1);
  assert.equal(q(".gz-rail-label")?.textContent, railLabel(a, NOW));
  assert.equal(all(".gz-rail-tick.is-later").length, 2);
  assert.deepEqual(shown, []);
  await sleep(STEP_MS + 50);
  assert.deepEqual(shown, [a]);
  r.sync(a);
  // Stepping back to the time already shown asks for nothing.
  r.step(1);
  r.step(-1);
  await sleep(STEP_MS + 50);
  assert.deepEqual(shown, [a]);
  assert.ok(r.past);
  r.back();
  assert.deepEqual(shown, [a, undefined]);
  r.dispose();
  r.el.remove();
});

test("Arrow keys on the track step too", async () => {
  const [a, b] = [local(2026, 11, 1, 9), local(2026, 11, 10, 9)];
  const { r, shown, q } = rail([entry(a), entry(b)]);
  const key = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowLeft" });
  q(".gz-rail-track")!.dispatchEvent(key);
  assert.ok(key.defaultPrevented);
  assert.equal(q(".gz-rail-label")?.textContent, railLabel(a, NOW));
  await sleep(STEP_MS + 50);
  assert.deepEqual(shown, [a]);
  r.el.remove();
});
