import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import { ledgerStore } from "../src/datastore.ts";
import { offerKind } from "../src/kind-make.ts";
import { readSpec } from "../src/spec.ts";
import { runtimeOn } from "./support/runtime.ts";

/** A small app that keeps its own list, as an app does before the list becomes a kind. */
const SPEND = {
  app: "Log what I spend",
  data: { spend: { source: "spend", fields: { amount: { type: "number" }, note: "text" } } },
  panels: [
    { view: "form", title: "Spent something", save: "spend", label: "Add" },
    { view: "table", title: "Recent", source: "spend" },
  ],
};

async function budget() {
  const t = await runtimeOn({ "Apps/Budget.md": { fm: structuredClone(SPEND), body: "" } });
  const store = ledgerStore(t.runtime.dataLayer.ledger!, "Apps/Budget data.md", () => SPEND);
  await store.add("spend", { amount: 12, note: "lunch", at: "2026-11-18T12:00" });
  await store.add("spend", { amount: 30, note: "fuel", at: "2026-11-18T13:00" });
  const spec = readSpec(SPEND, { path: "Apps/Budget.md", notes: t.runtime.host.notes })!.spec!;
  // The app's text as the vault holds it.
  const text = `---\n${stringify(SPEND)}---\n`;
  return { t, spec, text };
}

test("making a list a kind: the kind note first with the rows it carries, then the app's lines", async () => {
  const { t, spec, text } = await budget();
  const offered = await offerKind(t.runtime, "Apps/Budget.md", text, SPEND, spec, "spend");
  assert.ok(!("error" in offered), JSON.stringify(offered));
  assert.equal(offered.rows, 2);
  const made = await offered.make();
  assert.deepEqual(made, { ok: true, said: `${offered.plan.path.replace(/^.*\//, "").replace(/\.md$/, "")} is a kind now, with 2 rows from Budget` });
  assert.ok(t.f.files.has(offered.plan.path), "the kind note");
  const kindData = offered.plan.path.replace(/\.md$/, " data.md");
  const lists = (await t.runtime.dataLayer.ledger!.state(kindData, {})).lists;
  assert.equal([...lists.values()].reduce((n, l) => n + l.rows.length, 0), 2, "its rows");
  assert.equal((t.f.files.get("Apps/Budget.md")!.fm as typeof SPEND).data.spend.source, "[[Spend]]", "the app's list now reads the kind");
});

test("an app changed after the offer: the kind is made and its rows kept, and the app is left for you to point at it", async () => {
  const { t, spec, text } = await budget();
  const offered = await offerKind(t.runtime, "Apps/Budget.md", text, SPEND, spec, "spend");
  assert.ok(!("error" in offered));
  t.f.files.get("Apps/Budget.md")!.body = "edited meanwhile\n";
  const made = await offered.make();
  assert.equal(made.ok, false);
  assert.match(made.said, /is made, but Budget changed meanwhile; point its source and save at "\[\[.*\]\]" yourself/);
  assert.ok(t.f.files.has(offered.plan.path));
  assert.equal((t.f.files.get("Apps/Budget.md")!.fm as typeof SPEND).data.spend.source, "spend", "the app's own lines untouched");

  // Offered again: the kind's name is taken, so it would go beside it, never over it.
  const again = await offerKind(t.runtime, "Apps/Budget.md", text, SPEND, spec, "spend");
  assert.ok(!("error" in again));
  assert.equal(again.plan.path, "Apps/Spend rows.md");
});
