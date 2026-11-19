import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../src/data.ts";
import { checkPanel } from "../src/spec.ts";
import type { PanelCtx } from "../src/views/registry.ts";
import { viewDef } from "../src/views/registry.ts";

// A row's `path` is a link to a note only when the row is a note: the panel reads notes from the
// vault. From anywhere else (the web, a file, a saved list) it is just data, and drawn as text.

const NOW = new Date(2026, 10, 18, 12);

function draw(raw: Record<string, unknown>, rows: Row[]) {
  const r = checkPanel(raw, true);
  assert.deepEqual(r.errors, [], JSON.stringify(raw));
  const opened: string[] = [];
  const ctx = {
    now: NOW, width: () => 600, runActions: async () => {}, toggleChecked: async () => {}, clearChecked: async () => {},
    openNote: (path: string) => { opened.push(path); }, timer: () => ({ remainingMs: 0 }), startTimer() {}, pauseTimer() {}, resetTimer() {},
    select() {}, selected: () => undefined, editRow: async () => {},
  } as unknown as PanelCtx;
  const el = document.createElement("div");
  document.body.appendChild(el);
  viewDef(r.panel!.view)!.mount(el, r.panel!, ctx, "k").update(rows);
  const links = [...el.querySelectorAll("a.internal-link")];
  for (const a of links) (a as HTMLElement).click();
  return { links: links.map((a) => a.textContent), opened };
}

const WEB = "https://api.example.com/items";
const ROWS: Row[] = [{ name: "Dune", title: "Dune", path: "Apps/Meds.md", status: "doing", start: "2026-11-01", end: "2026-11-20" }];

test("rows from the web, a file or a saved list don't link to the note their path names", () => {
  for (const source of [WEB, "Finance/bank.csv", "picks"]) {
    for (const raw of [
      { view: "list", source },
      { view: "table", source, columns: ["name", "status"] },
      { view: "table", source, columns: ["title", "status"], layout: "cards" },
      { view: "timeline", source, start: "start", end: "end" },
    ]) {
      assert.deepEqual(draw(raw, ROWS), { links: [], opened: [] }, JSON.stringify(raw));
    }
  }
  // A board needs rows it can write back; a saved list is one.
  assert.deepEqual(draw({ view: "board", source: "picks", group: "status" }, ROWS), { links: [], opened: [] });
});

test("rows that are notes, tasks or a base's notes link to their note", () => {
  for (const [source, extra] of [["notes", { from: "Apps" }], ["tasks", { from: "Apps" }], ["[[Books.base]]", {}]] as const) {
    for (const raw of [
      { view: "list", source, ...extra },
      { view: "table", source, ...extra, columns: ["name", "status"] },
      { view: "table", source, ...extra, columns: ["title", "status"], layout: "cards" },
      { view: "timeline", source, ...extra, start: "start", end: "end" },
      ...(source === "tasks" ? [] : [{ view: "board", source, ...extra, group: "status" }]),
    ]) {
      assert.deepEqual(draw(raw, ROWS).opened, ["Apps/Meds.md"], JSON.stringify(raw));
    }
  }
});
