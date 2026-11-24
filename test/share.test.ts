import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { aggregate, valueOf } from "../src/data.ts";
import { checkPanel, type Panel } from "../src/spec.ts";
import { panelValue } from "../src/panel-value.ts";
import { fakeEnv } from "./support/fakes.ts";

// `agg: share` with `of`: the fraction of the panel's rows (after where) that match `of`, or of
// each group's rows; shown as a percent unless the panel gives a format.

const NOW = new Date(2026, 10, 18, 12);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const started: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.dispose();
});

const SCORED = [
  { confidence: 80, outcome: "right", review: "2026-09-10" },
  { confidence: 90, outcome: "wrong", review: "2026-06-01" },
  { confidence: 80, outcome: "wrong", review: "2026-08-15" },
  { confidence: 90, outcome: "right", review: "2026-10-01" },
  { confidence: 60, outcome: "wrong", review: "2026-06-15" },
  { confidence: 70, outcome: "right", review: "2026-10-01" },
];

const check = (keys: Record<string, unknown>) => {
  const r = checkPanel({ source: "decisions", ...keys }, true);
  assert.deepEqual(r.errors, []);
  return r.panel as Panel;
};

test("a share is the fraction of the rows that match of, shown as a percent unless the panel says how", () => {
  const p = check({ view: "number", agg: "share", of: { outcome: "right" } });
  assert.equal(valueOf(p, SCORED, NOW), 0.5);
  assert.equal(panelValue(p, SCORED, NOW).text, "50%");
  assert.equal(panelValue(check({ view: "number", agg: "share", of: { outcome: "right" }, format: "0.0%" }), SCORED.slice(0, 3), NOW).text, "33.3%");
  assert.equal(panelValue(p, [], NOW).text, "—");
  // of reads as where does: comparisons, lists of conditions, date windows.
  assert.equal(valueOf(check({ view: "number", agg: "share", of: { confidence: ">= 80", outcome: "right" } }), SCORED, NOW), 2 / 6);
  assert.equal(valueOf(check({ view: "number", agg: "share", of: { review: "this year" } }), [...SCORED, { review: "2025-01-01" }], NOW), 6 / 7);
  assert.equal(aggregate(SCORED, undefined, "share"), 0);
});

test("of without agg: share, or agg: share without of, is an error", () => {
  assert.deepEqual(checkPanel({ view: "number", source: "d", agg: "avg", field: "x", of: { a: 1 } }, true).errors, ['"of" needs agg: share']);
  assert.deepEqual(checkPanel({ view: "bar", source: "d", group: "g", agg: "share" }, true).errors, ["agg: share needs of, e.g. of: {outcome: right}"]);
  assert.deepEqual(checkPanel({ view: "table", source: "d", group: "g", columns: ["g", "x"], agg: "share", of: { a: 1 } }, true).errors, [
    'agg: share gives each group its share; use share in columns, not "x"',
  ]);
  assert.deepEqual(checkPanel({ view: "list", source: "d", agg: "share", of: { a: 1 } }, true).errors, ['"agg" doesn\'t apply to list', '"of" doesn\'t apply to list']);
});

test("grouped, each group's share is its share column, which a chart, a pie and a table show by default, as percents", async () => {
  const fm = {
    app: "x",
    panels: [
      { view: "bar", title: "Right by confidence", source: "scored", group: "confidence", agg: "share", of: { outcome: "right" } },
      { view: "table", title: "Table", source: "scored", group: "confidence", agg: "share", of: { outcome: "right" } },
      { view: "pie", title: "Pie", source: "scored", group: "outcome", agg: "share", of: { confidence: ">= 80" } },
      { view: "number", title: "Right so far", source: "scored", where: { confidence: "> 60" }, agg: "share", of: { outcome: "right" }, label: "of the ones I scored" },
    ],
  };
  const t = fakeEnv({ "Apps/S.md": { fm }, "Apps/S data.md": { fm: { scored: SCORED } } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, "Apps/S.md", t.env);
  started.push(app);
  app.load();
  await settle();
  // Composed, the number leads; the rest follow as written.
  const [number, bar, table, pie] = [...root.querySelectorAll(".gz-panel")];
  assert.equal(bar.querySelectorAll("path.gz-bar").length, 3, "60% is a share of 0, which draws no bar");
  assert.match(text(bar.querySelector(".gz-readout")), /^90 · 50%$/);
  assert.deepEqual([...table.querySelectorAll("th")].map(text), ["confidence", "share"]);
  assert.deepEqual([...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map(text)), [
    ["60", "0%"], ["70", "100%"], ["80", "50%"], ["90", "50%"],
  ]);
  assert.ok(text(pie).includes("67%") || text(pie).includes("50%"), text(pie));
  assert.equal(text(number.querySelector(".gz-big")), "60%");
});
