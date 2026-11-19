import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPanel, type Panel } from "../src/spec.ts";
import { bar, line } from "../src/views/chart.ts";
import { pie, slicesOf } from "../src/views/pie.ts";
import type { PanelCtx, ViewDef } from "../src/views/registry.ts";

const ctx = { now: new Date(2026, 10, 18), chartWidth: 600 } as PanelCtx;

function draw(def: ViewDef, keys: Record<string, unknown>, data: unknown): HTMLElement {
  const { panel, errors } = checkPanel(keys, true);
  assert.deepEqual(errors, []);
  const el = document.createElement("div");
  def.mount(el, panel as Panel, ctx, "k").update(data);
  return el;
}

const hourly = { time: ["2026-11-18T00:00", "2026-11-18T01:00", "2026-11-18T02:00"], t: [4, 5, 6], feels: [2, 3, 3] };

test("one series wears the accent, fills its area and needs no legend", () => {
  const el = draw(line, { view: "line", source: "s", x: "time", y: "t" }, hourly);
  assert.equal(el.querySelectorAll("path.na-line").length, 1);
  assert.ok(el.querySelector("path.na-line")!.classList.contains("na-accent"));
  assert.equal(el.querySelectorAll(".na-area").length, 1);
  assert.equal(el.querySelector(".na-legend"), null);
});

test("several series each get a palette colour, a legend entry and a readout value", () => {
  const el = draw(line, { view: "line", source: "s", x: "time", y: ["t", "feels"] }, hourly);
  const lines = [...el.querySelectorAll("path.na-line")];
  assert.deepEqual(lines.map((l) => l.getAttribute("class")), ["na-line na-s1", "na-line na-s2"]);
  assert.equal(el.querySelectorAll(".na-area").length, 0);
  assert.equal(el.querySelector(".na-legend")!.textContent, "tfeels");
  assert.match(el.querySelector(".na-readout")!.textContent!, /t 6 · *feels 3|t 6feels 3/);
});

test("bars for several series sit side by side; zero draws nothing", () => {
  const rows = [{ g: "a", x: 1, y: 2 }, { g: "b", x: 0, y: 3 }];
  const el = draw(bar, { view: "bar", source: "s", x: "g", y: ["x", "y"] }, rows);
  assert.equal(el.querySelectorAll("path.na-bar").length, 3);
  const [a, b] = [...el.querySelectorAll("path.na-bar.na-s1, path.na-bar.na-s2")].slice(0, 2).map((p) => p.getAttribute("d")!);
  assert.notEqual(a.split("V")[0], b.split("V")[0]);
});

test("a pie shows six slices at most, folding the smallest into Other", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g", "h"].map((genre, i) => ({ genre, count: 10 - i }));
  const slices = slicesOf(rows, "genre", "count");
  assert.deepEqual(slices.map((s) => [s.name, s.value]), [["a", 10], ["b", 9], ["c", 8], ["d", 7], ["e", 6], ["Other", 12]]);
  assert.equal(slices.at(-1)!.colour, "na-other");
  const el = draw(pie, { view: "pie", source: "s", group: "genre" }, rows);
  assert.equal(el.querySelectorAll("path.na-slice").length, 6);
  assert.match(el.querySelector(".na-pie-legend")!.textContent!, /Other12 · 23%/);
  assert.equal(el.querySelector(".na-readout")!.textContent, "Total · 52");
});

test("pie colours follow names, not sizes; one slice is a full ring; nothing positive shows an empty note", () => {
  const before = slicesOf([{ n: "x", v: 1 }, { n: "y", v: 5 }], "n", "v");
  const after = slicesOf([{ n: "x", v: 9 }, { n: "y", v: 5 }], "n", "v");
  assert.deepEqual(before.map((s) => [s.name, s.colour]), [["y", "na-s2"], ["x", "na-s1"]]);
  assert.deepEqual(after.map((s) => [s.name, s.colour]), [["x", "na-s1"], ["y", "na-s2"]]);
  const one = draw(pie, { view: "pie", source: "s", x: "n", y: "v" }, [{ n: "only", v: 3 }, { n: "none", v: 0 }]);
  assert.equal(one.querySelectorAll("circle.na-ring").length, 1);
  const empty = draw(pie, { view: "pie", source: "s", x: "n", y: "v" }, [{ n: "neg", v: -2 }]);
  assert.equal(empty.querySelector(".na-empty")!.textContent, "Nothing to show yet.");
});
