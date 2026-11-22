import assert from "node:assert/strict";
import { test } from "node:test";
import { readSpec } from "../src/spec.ts";
import { askersOf, permissionsOf } from "../src/permissions.ts";
import { fakeBackground } from "./support/fakes.ts";

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";

test("the index holds app notes only, read from the metadata at start", async () => {
  const t = fakeBackground({
    "Apps/A.md": { fm: { app: "A", view: "countdown", to: "2027-01-01" } },
    "Apps/A data.md": { fm: { doses: [] } },
    "Components/C.md": { fm: { component: "C", panels: [{ view: "countdown", to: "2027-01-01" }] } },
  });
  assert.equal(t.bg.spec("Apps/A.md"), undefined, "nothing before start");
  await t.bg.start();
  assert.equal(t.bg.spec("Apps/A.md")?.panels.length, 1);
  assert.equal(t.bg.spec("Apps/A data.md"), undefined);
  assert.equal(t.bg.spec("Components/C.md"), undefined);
});

test("evaluate: a panel's value without drawing it, inputs at their starting values", async () => {
  const fm = {
    app: "Doses",
    inputs: { who: ["ann", "bob"], q: "text" },
    panels: [
      { view: "number", title: "Doses", source: "doses", where: { who: "$who" }, agg: "count" },
      { view: "text", source: "doses", text: "{count} doses, last {who}" },
      { view: "list", source: "doses", where: { who: "$q" } },
      { view: "number", source: "https://api.example.com/fail", field: "t" },
    ],
  };
  const t = fakeBackground({
    "Apps/D.md": { fm },
    "Apps/D data.md": { fm: { doses: [{ who: "ann", at: "2026-11-18T08:00" }, { who: "bob", at: "2026-11-18T09:00" }, { who: "ann", at: "2026-11-18T10:00" }] } },
  });
  await t.bg.start();
  const panels = readSpec(fm, { path: "Apps/D.md" })!.spec!.panels;
  const [count, text, search, failing] = await Promise.all(panels.map((ps) => t.bg.evaluate("Apps/D.md", ps)));
  assert.equal("value" in count && count.value, 2);
  assert.equal("value" in text && text.value, "3 doses, last ann");
  assert.deepEqual(search, { waiting: "q" });
  assert.deepEqual(failing, { error: "api.example.com answered 503" });
  assert.deepEqual(await t.bg.evaluate("Apps/Nope.md", panels[0]), { error: "Nope isn't an app" });
});

test("the index follows the app note, the components it uses, and app notes that come and go", async () => {
  const t = fakeBackground({
    "Apps/W.md": { fm: { app: "W", panels: [{ use: "[[Card]]" }] } },
    "Components/Card.md": { fm: { component: "c", panels: [{ view: "text", text: "one" }] } },
  });
  await t.bg.start();
  const text = (path: string) => t.bg.spec(path)?.panels.map((ps) => ps.panel.text ?? ps.panel.view).join();
  assert.equal(text("Apps/W.md"), "one");

  t.f.files.get("Components/Card.md")!.fm = { component: "c", panels: [{ view: "text", text: "two" }] };
  t.changed("Components/Card.md");
  assert.equal(text("Apps/W.md"), "two");

  t.f.files.get("Apps/W.md")!.fm = { app: "W", panels: [{ use: "[[Card]]" }, { view: "countdown", to: "2027-01-01" }] };
  t.changed("Apps/W.md");
  assert.equal(text("Apps/W.md"), "two,countdown");

  // A note that becomes an app is indexed when the metadata says it changed.
  t.f.files.set("Apps/New.md", { fm: { app: "N", view: "text", text: "new" } });
  t.bg.noteChanged("Apps/New.md");
  assert.equal(text("Apps/New.md"), "new");

  // A deleted or renamed app leaves the index; its new path comes in.
  t.f.files.set("Apps/Renamed.md", t.f.files.get("Apps/W.md")!);
  t.f.files.delete("Apps/W.md");
  t.data.fileRenamed("Apps/Renamed.md", "Apps/W.md");
  t.f.flush();
  t.bg.noteChanged("Apps/Renamed.md");
  assert.equal(t.bg.spec("Apps/W.md"), undefined);
  assert.equal(text("Apps/Renamed.md"), "two,countdown");

  // An app that loses its app key leaves too.
  t.f.files.get("Apps/New.md")!.fm = { title: "just a note" };
  t.changed("Apps/New.md");
  assert.equal(t.bg.spec("Apps/New.md"), undefined);
  t.bg.stop();
  t.bg.noteChanged("Apps/Renamed.md");
  assert.equal(t.bg.spec("Apps/Renamed.md"), undefined);
  await settle(1);
});

test("what works while the app is closed can't wait for typing or a pick", () => {
  const r = readSpec({
    app: "x",
    inputs: { q: "text", range: [7, 30] },
    data: { kp: { source: `${KP}?q=$q`, record: "1h" }, ok: { source: `${KP}?days=$range`, record: "1h" } },
    panels: [
      { view: "list", source: "notes", from: "Books", select: "book" },
      { view: "number", source: "https://api.example.com/s?q=$q", field: "t", pin: "status" },
      { view: "number", source: "https://api.example.com/b?id=$book.id", field: "t", alert: "> 5" },
      { view: "button", label: "Go", notify: "Going with $q", shortcut: "go" },
      { view: "number", source: "https://api.example.com/r?days=$range", field: "t", pin: "status" },
    ],
  })!;
  assert.deepEqual(r.errors, [
    "data.kp: record can't depend on $q, which has no value until someone types",
    "panel 2: pin can't depend on $q, which has no value until someone types",
    "panel 3: alert can't depend on $book, which has no value until someone picks a row",
    "panel 4: shortcut can't depend on $q, which has no value until someone types",
  ]);
});

test("an alert, a pin and a shortcut can read $this, the app's own note: told from its property while the app is closed, with no new permission; a property it doesn't have says so", async () => {
  const fm = {
    app: "Budget", limit: 100,
    panels: [
      { view: "number", title: "Spent", source: "spend", field: "amount", agg: "sum", alert: "> $this.limit", shortcut: "spent" },
      { view: "number", title: "Each under the limit", source: "spend", where: { amount: "< $this.limit" }, agg: "count", pin: "status" },
    ],
  };
  const r = readSpec(fm, { path: "Apps/B.md" })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(permissionsOf(r.spec!, "Apps/B.md"), ["answer:spent"], "the same as with the limit typed in the alert");
  assert.deepEqual(permissionsOf(readSpec({ ...fm, panels: [{ ...fm.panels[0], alert: "> 100" }, fm.panels[1]] }, { path: "Apps/B.md" })!.spec!, "Apps/B.md"), ["answer:spent"]);
  const t = fakeBackground({ "Apps/B.md": { fm }, "Apps/B data.md": { fm: { spend: [{ amount: 60, at: "2026-11-18T08:00" }] } } });
  await t.bg.start();
  await settle();
  assert.deepEqual([t.notices, t.out.status.map((x) => x.text)], [[], ["Each under the limit: 1"]]);
  // A second row goes past the note's limit: told, as an alert with the number typed in it would be.
  await t.env.store!("Apps/B data.md", "Apps/B.md").add("spend", { amount: 50, at: "2026-11-18T09:00" });
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.notices, ["B: Spent 110"]);

  // Without the property, the panel says what is missing, not that someone must type.
  const bare = { ...fm, limit: undefined };
  const p = readSpec(bare, { path: "Apps/B.md" })!;
  assert.deepEqual(p.errors, []);
  const e = fakeBackground({ "Apps/B.md": { fm: bare } });
  await e.bg.start();
  assert.deepEqual(await e.bg.evaluate("Apps/B.md", p.spec!.panels[0]), { error: "alert reads $this.limit, and this note has no limit property: add it to the note's properties" });
  // A where on it matches no row, as it always has: the pin counts none.
  assert.equal((await e.bg.evaluate("Apps/B.md", p.spec!.panels[1]) as { shown: string }).shown, "0");
});

test("shortcuts are unique per app; record needs a URL source and asks for it", () => {
  const r = readSpec({
    app: "x",
    data: {
      kp: { source: KP, record: "1h" },
      local: { source: "doses", record: "1h", into: "samples" },
      quiet: { source: "https://quiet.example.com/x?k={secret:demo}", record: "1d" },
    },
    panels: [
      { view: "button", label: "A", save: "a", shortcut: "go" },
      { view: "form", fields: { n: "number" }, save: "b", shortcut: "go" },
      { view: "number", source: "kp", field: "kp_index" },
    ],
  })!;
  assert.deepEqual(r.errors, ["data.local: record needs a URL source", 'panel 2: two panels use the shortcut "go"']);
  assert.deepEqual(r.spec!.blocks.local, { source: "doses" });
  // A recorded block nobody shows is still fetched, so the app asks for it.
  assert.deepEqual(permissionsOf(r.spec!, "Apps/X.md"), ["net:quiet.example.com", "net:services.swpc.noaa.gov", "secret:demo"]);
  assert.deepEqual([...askersOf(r.spec!, "Apps/X.md").get("net:quiet.example.com")!], ["Apps/X.md"]);
});
