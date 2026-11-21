import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPanel, type Panel } from "../src/spec.ts";
import { bar, line, renderChart } from "../src/views/chart.ts";
import { pie, slicesOf } from "../src/views/pie.ts";
import type { PanelCtx, ViewDef } from "../src/views/registry.ts";

const ctx = { now: new Date(2026, 10, 18), width: () => 600 } as unknown as PanelCtx;

function draw(def: ViewDef, keys: Record<string, unknown>, data: unknown): HTMLElement {
  const { panel, errors } = checkPanel(keys, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  def.mount(el, panel as Panel, ctx, "k").update(data);
  return el;
}

const text = (el: Element | null) => el?.textContent ?? "";

const hourly = { time: ["2026-11-18T00:00", "2026-11-18T01:00", "2026-11-18T02:00"], t: [4, 5, 6], feels: [2, 3, 3] };

test("one series is drawn in ink: its area, an end dot with its value beside it, and no legend", () => {
  const el = draw(line, { view: "line", source: "s", x: "time", y: "t" }, hourly);
  assert.equal(el.querySelectorAll("path.gz-line").length, 1);
  assert.equal(el.querySelector("path.gz-line")!.getAttribute("class"), "gz-line", "no palette class");
  assert.equal(el.querySelectorAll(".gz-area").length, 1);
  assert.equal(el.querySelector(".gz-legend"), null);
  // The last point is a dot with its value as a label to its right.
  const dot = el.querySelector("circle.gz-dot")!;
  const end = el.querySelector("text.gz-end-label")!;
  assert.equal(dot.getAttribute("r"), "4.5");
  assert.equal(end.textContent, "6");
  assert.ok(Number(end.getAttribute("x")) > Number(dot.getAttribute("cx")));
});

test("several series each get a palette colour and a legend entry holding its value at the point shown", () => {
  const el = draw(line, { view: "line", source: "s", x: "time", y: ["t", "feels"] }, hourly);
  const lines = [...el.querySelectorAll("path.gz-line")];
  assert.deepEqual(lines.map((l) => l.getAttribute("class")), ["gz-line gz-s1", "gz-line gz-s2"]);
  assert.equal(el.querySelectorAll(".gz-area").length, 0);
  assert.deepEqual([...el.querySelectorAll(".gz-legend-name")].map((e) => e.textContent), ["t", "feels"]);
  assert.deepEqual([...el.querySelectorAll(".gz-legend-value")].map((e) => e.textContent), ["6", "3"]);
  assert.equal(el.querySelector(".gz-readout"), null);
  // Both lines end in a dot of their colour; only the first series is written out at its end.
  assert.deepEqual([...el.querySelectorAll("circle.gz-dot")].map((c) => c.getAttribute("class")), ["gz-dot gz-s1", "gz-dot gz-s2"]);
  assert.deepEqual([...el.querySelectorAll("text.gz-end-label")].map((t) => t.textContent), ["6"]);
});

test("hovering a line puts a dot on each series at that x, with a crosshair; leaving takes them away", () => {
  const el = draw(line, { view: "line", source: "s", x: "time", y: ["t", "feels"] }, hourly);
  const svgEl = el.querySelector("svg")!;
  Object.assign(svgEl, { getBoundingClientRect: () => ({ left: 0, width: 600 }) });
  const shown = () => [...el.querySelectorAll(".gz-hover-dot, .gz-cursor")].map((e) => e.getAttribute("visibility"));
  assert.deepEqual(shown(), ["hidden", "hidden", "hidden"]);
  svgEl.dispatchEvent(Object.assign(new window.Event("pointermove", { bubbles: true }), { clientX: 52 }));
  assert.deepEqual([...el.querySelectorAll(".gz-legend-value")].map((e) => e.textContent), ["4", "2"]);
  assert.deepEqual(shown(), ["visible", "visible", "visible"]);
  const [dot] = el.querySelectorAll(".gz-hover-dot");
  assert.equal(Number(dot.getAttribute("cx")), Number(el.querySelector(".gz-cursor")!.getAttribute("x1")));
  svgEl.dispatchEvent(new window.Event("pointerleave"));
  assert.deepEqual(shown(), ["hidden", "hidden", "hidden"]);
  assert.deepEqual([...el.querySelectorAll(".gz-legend-value")].map((e) => e.textContent), ["6", "3"]);
});

test("a goal's label sits in a gutter right of the plot, clear of the line's own end label", () => {
  const goal = (def: ViewDef, y: string, target: number) => draw(def, { view: def.id, source: "s", x: "time", y, goal: target }, hourly);
  for (const [el, label] of [[goal(line, "t", 100), "Goal 100"], [goal(bar, "t", 100), "100 goal"]] as const) {
    const goalLabel = el.querySelector("text.gz-goal-label")!;
    assert.equal(goalLabel.textContent, label);
    // The goal line stops at the plot's edge and the label starts beyond it, right of every tick label.
    const edge = Number(el.querySelector("line.gz-goal")!.getAttribute("x2"));
    const ticks = [...el.querySelectorAll("text.gz-axis")].map((t) => Number(t.getAttribute("x")));
    assert.ok(Number(goalLabel.getAttribute("x")) > edge);
    assert.ok(Number(goalLabel.getAttribute("x")) > Math.max(...ticks));
    assert.ok(Number(el.querySelector("svg")!.getAttribute("viewBox")!.split(" ")[2]) - edge >= 64, "a gutter of 64 px at least");
  }
  // A line that ends on its goal writes both labels, one above the other.
  const flat = goal(line, "t", 6);
  const [end, target] = ["gz-end-label", "gz-goal-label"].map((c) => Number(flat.querySelector(`text.${c}`)!.getAttribute("y")));
  assert.ok(Math.abs(end - target) >= 14, `${end} ${target}`);
});

test("a bar chart of one series draws pencil bars; the current one is marked, and one past the goal", () => {
  const week = (x: string, y: number) => ({ x, y });
  const draws = (now: Date, goal?: number) => {
    const el = document.createElement("div");
    renderChart(el, [{ name: "spent", points: [week("2026-11-02", 120), week("2026-11-09", 80), week("2026-11-16", 60)] }], { kind: "bar", width: 600, per: "week", now, goal });
    return [...el.querySelectorAll("path.gz-bar")].map((b) => b.getAttribute("class"));
  };
  // Wednesday 18 November is in the week of Monday the 16th: the last bar is now; 120 is over a goal of 100.
  assert.deepEqual(draws(new Date(2026, 10, 18), 100), ["gz-bar is-over", "gz-bar", "gz-bar is-now"]);
  assert.deepEqual(draws(new Date(2026, 10, 18)), ["gz-bar", "gz-bar", "gz-bar is-now"]);
  // A week on, no bar holds the present; the last bar is just the last.
  assert.deepEqual(draws(new Date(2026, 10, 23, 12)), ["gz-bar", "gz-bar", "gz-bar"]);
  // The current bar can be over too: it carries both marks, and the stylesheet lets amber win.
  assert.deepEqual(draws(new Date(2026, 10, 18), 50), ["gz-bar is-over", "gz-bar is-over", "gz-bar is-now is-over"]);
  // Not a time axis: nothing is current.
  const cats = document.createElement("div");
  renderChart(cats, [{ name: "n", points: [{ x: "a", y: 1 }, { x: "b", y: 2 }] }], { kind: "bar", width: 600, now: new Date(2026, 10, 18) });
  assert.deepEqual([...cats.querySelectorAll("path.gz-bar")].map((b) => b.getAttribute("class")), ["gz-bar", "gz-bar"]);
});

test("a stack tells the composition of the bar shown, the last until a bar is hovered", () => {
  const weeks = [{ x: "2026-11-09", f: 30, r: 100 }, { x: "2026-11-16", f: 60, r: 150 }];
  const host = document.createElement("div");
  renderChart(host, [
    { name: "food", label: "Food", points: weeks.map((w) => ({ x: w.x, y: w.f })) },
    { name: "rent", label: "Rent", points: weeks.map((w) => ({ x: w.x, y: w.r })) },
  ], { kind: "bar", width: 600, per: "week", now: new Date(2026, 10, 18), stack: true, goal: 200 });
  const head = () => text(host.querySelector(".gz-stack-head"));
  const strip = () => [...host.querySelectorAll(".gz-strip span")].map((s) => [s.getAttribute("class"), (s as HTMLElement).style.flexGrow]);
  const values = () => [...host.querySelectorAll(".gz-legend-value")].map(text);
  const bars = [...host.querySelectorAll("path.gz-bar")];
  assert.equal(bars.length, 2, "one bar per week, not one per series");
  assert.deepEqual(bars.map((b) => b.getAttribute("class")), ["gz-bar", "gz-bar is-now is-over"]);
  assert.equal(head(), "Week of Nov 16210 of 200 · 10 over");
  assert.equal(text(host.querySelector(".gz-stack-over")), " · 10 over");
  assert.deepEqual(strip(), [["gz-s1", "60"], ["gz-s2", "150"]]);
  assert.deepEqual([...host.querySelectorAll(".gz-legend-name")].map(text), ["Food", "Rent"]);
  assert.deepEqual(values(), ["60", "150"]);

  bars[0].dispatchEvent(new window.Event("pointerover", { bubbles: true }));
  assert.equal(head(), "Week of Nov 9130 of 200", "under the goal: no over");
  assert.deepEqual(strip(), [["gz-s1", "30"], ["gz-s2", "100"]]);
  assert.deepEqual(values(), ["30", "100"]);
  assert.ok(bars[0].classList.contains("is-hover"));

  host.querySelector("svg")!.dispatchEvent(new window.Event("pointerleave"));
  assert.equal(head(), "Week of Nov 16210 of 200 · 10 over");
  assert.deepEqual(values(), ["60", "150"]);
  assert.ok(!bars[0].classList.contains("is-hover"));
});

test("bars for several series sit side by side; zero draws nothing", () => {
  const rows = [{ g: "a", x: 1, y: 2 }, { g: "b", x: 0, y: 3 }];
  const el = draw(bar, { view: "bar", source: "s", x: "g", y: ["x", "y"] }, rows);
  assert.equal(el.querySelectorAll("path.gz-bar").length, 3);
  const [a, b] = [...el.querySelectorAll("path.gz-bar.gz-s1, path.gz-bar.gz-s2")].slice(0, 2).map((p) => p.getAttribute("d")!);
  assert.notEqual(a.split("V")[0], b.split("V")[0]);
});

test("a pie shows six slices at most, folding the smallest into Other", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g", "h"].map((genre, i) => ({ genre, count: 10 - i }));
  const slices = slicesOf(rows, "genre", "count");
  assert.deepEqual(slices.map((s) => [s.name, s.value]), [["a", 10], ["b", 9], ["c", 8], ["d", 7], ["e", 6], ["Other", 12]]);
  assert.equal(slices.at(-1)!.colour, "gz-other");
  const el = draw(pie, { view: "pie", source: "s", group: "genre" }, rows);
  assert.equal(el.querySelectorAll("path.gz-slice").length, 6);
  assert.match(el.querySelector(".gz-pie-legend")!.textContent!, /Other12 · 23%/);
  assert.equal(el.querySelector(".gz-readout")!.textContent, "Total · 52");
});

test("pie colours follow names, not sizes; one slice is a full ring; nothing positive shows an empty note", () => {
  const before = slicesOf([{ n: "x", v: 1 }, { n: "y", v: 5 }], "n", "v");
  const after = slicesOf([{ n: "x", v: 9 }, { n: "y", v: 5 }], "n", "v");
  assert.deepEqual(before.map((s) => [s.name, s.colour]), [["y", "gz-s2"], ["x", "gz-s1"]]);
  assert.deepEqual(after.map((s) => [s.name, s.colour]), [["x", "gz-s1"], ["y", "gz-s2"]]);
  const one = draw(pie, { view: "pie", source: "s", x: "n", y: "v" }, [{ n: "only", v: 3 }, { n: "none", v: 0 }]);
  assert.equal(one.querySelectorAll("circle.gz-ring").length, 1);
  const empty = draw(pie, { view: "pie", source: "s", x: "n", y: "v" }, [{ n: "neg", v: -2 }]);
  assert.equal(empty.querySelector(".gz-empty")!.textContent, "Nothing to show yet.");
});
