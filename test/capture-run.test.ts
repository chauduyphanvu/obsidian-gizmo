import assert from "node:assert/strict";
import { test } from "node:test";
import { capturedText, runsText, singleRowAdded, submitLine, whatIfAppOf } from "../src/capture-run.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { runtimeOn } from "./support/runtime.ts";

const INBOX = { app: "Inbox", panels: [{ view: "form", title: "Add", fields: { task: "text" }, save: "todo", shortcut: "add", alias: "task" }] };
const SPEND = { kind: "spend", fields: { amount: "number", memo: "text" } };
const BUDGET = { app: "Budget", panels: [{ view: "form", title: "Spent", save: "[[Spend]]", shortcut: "spend" }] };
const MONTH = { app: "Month", panels: [{ view: "table", source: "[[Spend]]" }] };

async function started() {
  const t = await runtimeOn({
    "Apps/Inbox.md": { fm: INBOX, body: "" },
    "Kinds/Spend.md": { fm: SPEND, body: "" },
    "Apps/Budget.md": { fm: BUDGET, body: "" },
    "Apps/Month.md": { fm: MONTH, body: "" },
  });
  // Each app as allowed when first opened.
  for (const path of ["Apps/Inbox.md", "Apps/Budget.md", "Apps/Month.md"]) {
    const spec = readSpec(t.f.files.get(path)!.fm!, { path, notes: t.runtime.host.notes })!.spec!;
    await t.runtime.grant(path, permissionsOf(spec, path));
  }
  await t.runtime.start();
  return t;
}

test("Enter on a line: a question, a what-if, a line it can't read, or a run told once with its one row", async () => {
  const t = await started();
  const busy: boolean[] = [];
  assert.deepEqual(await submitLine(t.runtime, "   ", { asks: true }), { kind: "empty" });
  assert.deepEqual(await submitLine(t.runtime, "? spend this month", { asks: true }), { kind: "ask" });
  assert.notEqual((await submitLine(t.runtime, "? spend this month", { asks: false })).kind, "ask", "no ask pane: not a question");
  assert.deepEqual(await submitLine(t.runtime, "zzz nothing", { asks: true, busy: (b) => busy.push(b) }), { kind: "unread" });
  assert.deepEqual(busy, [true, false], "busy only while it runs");

  const ran = await submitLine(t.runtime, "add buy milk", { asks: true });
  assert.equal(ran.kind, "ran", JSON.stringify(ran));
  assert.ok(ran.kind === "ran" && ran.entryId);
  assert.ok(await singleRowAdded(t.runtime, ran.entryId), "the one row it saved");
  assert.equal(await singleRowAdded(t.runtime, undefined), undefined);
  assert.deepEqual(t.notices, [], "told by the host, not by the run");
});

test("a what-if is tried in the open app when that app reads the line's kind, else in the shortcut's own app", async () => {
  const t = await started();
  const inMonth = await submitLine(t.runtime, "what if spend 40", { asks: true, open: "Apps/Month.md" });
  assert.deepEqual(inMonth, { kind: "what-if", app: "Apps/Month.md", line: "spend 40" });
  const elsewhere = await submitLine(t.runtime, "what if spend 40", { asks: true, open: "Apps/Inbox.md" });
  assert.deepEqual(elsewhere, { kind: "what-if", app: "Apps/Budget.md", line: "spend 40" });
  const target = { app: "Budget", path: "Apps/Budget.md", shortcut: "spend", label: "Spent" } as Parameters<typeof whatIfAppOf>[1];
  assert.equal(whatIfAppOf(t.runtime, target, undefined), "Apps/Budget.md");
  assert.equal((await submitLine(t.runtime, "what if nothing here", { asks: true })).kind, "unread");
});

test("what a run is told as, and what a line runs", () => {
  assert.equal(capturedText("add x", undefined), "Ran “add x”.");
  assert.equal(capturedText("add x", "Added x"), "Added x.");
  assert.equal(capturedText("add x", "Added x!"), "Added x!");
  const parsed = { ok: true, target: { app: "Inbox", label: "Add" } } as Parameters<typeof runsText>[0];
  assert.equal(runsText(parsed, new Date()), "Inbox: Add");
});
