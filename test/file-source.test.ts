import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { sourceDef } from "../src/sources/registry.ts";
import { readSpec, type Panel } from "../src/spec.ts";
import { askersOf, describePermission, permissionsOf } from "../src/permissions.ts";
import { fakeEnv, fakeHost } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const FILES = { appPath: "Apps/Bank.md", dataPath: "Apps/Bank data.md" };
const NOW = new Date(2026, 10, 18, 12, 0);

const CSV = `Date,Description,Amount,Category
2026-11-02,Corner Cafe,-4.5,Dining
2026-11-03,Landlord,-1200,Rent
2026-11-04,"Bistro ""Le Chat"", Main St",-62.8,Dining
2026-11-05,Salary,3200,Income
`;
const RATES = { rates: [{ code: "EUR", rate: 0.9 }, { code: "GBP", rate: 0.8 }] };

const panelOf = (keys: Record<string, unknown>): Panel => readSpec({ app: "x", ...keys })!.spec!.panels[0].panel;
const load = (dl: DataLayer, p: Panel) => dl.panelData(p.source, p, FILES, { ttlMs: 0, now: NOW });

test("a source is a file when it names a .csv, .json or .ics in the vault, never a URL", () => {
  for (const s of ["Finance/bank.csv", "bank.CSV", "[[bank.csv]]", "[[Finance/bank.csv|My bank]]", "Data/rates.json", "Calendar/family.ics", "[[Family.ICS#week]]"]) {
    assert.equal(sourceDef(s).id, "file", s);
  }
  for (const s of ["https://example.com/a.csv", "http://example.com/a.json"]) assert.equal(sourceDef(s).id, "url", s);
  for (const s of ["notes", "doses", "bank", "[[Books]]", "a.csv.old"]) assert.notEqual(sourceDef(s).id, "file", s);
});

test("CSV and JSON files load through the pipeline, by path or by link", async () => {
  const f = fakeHost({ "Finance/bank.csv": { raw: CSV }, "Data/rates.json": { raw: JSON.stringify(RATES) } });
  const dl = new DataLayer(f.host);
  const dining = panelOf({ view: "table", source: "Finance/bank.csv", where: { Category: "Dining" }, sort: "Amount" });
  assert.deepEqual(await load(dl, dining), [
    { Date: "2026-11-04", Description: 'Bistro "Le Chat", Main St', Amount: -62.8, Category: "Dining" },
    { Date: "2026-11-02", Description: "Corner Cafe", Amount: -4.5, Category: "Dining" },
  ]);
  const big = panelOf({ view: "number", source: "Finance/bank.csv", where: { Amount: "< -100" }, field: "Amount", agg: "sum" });
  assert.deepEqual(await load(dl, big), [{ Date: "2026-11-03", Description: "Landlord", Amount: -1200, Category: "Rent" }]);
  for (const source of ["[[bank.csv]]", "[[Finance/bank.csv|My bank]]", "bank.csv"]) {
    assert.equal(((await load(dl, panelOf({ view: "table", source }))) as unknown[]).length, 4, source);
  }
  const rates = panelOf({ view: "table", source: "Data/rates.json", pick: "rates", where: { code: "GBP" } });
  assert.deepEqual(await load(dl, rates), [{ code: "GBP", rate: 0.8 }]);
});

test("a calendar file is expanded around the panel's now", async () => {
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261103", "RRULE:FREQ=WEEKLY;COUNT=3", "UID:bins", "SUMMARY:Bins out", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  const dl = new DataLayer(fakeHost({ "Calendar/family.ics": { raw: ics } }).host);
  const rows = (await load(dl, panelOf({ view: "table", source: "Calendar/family.ics" }))) as { start: string }[];
  assert.deepEqual(rows.map((r) => r.start), ["2026-11-03", "2026-11-10", "2026-11-17"]);
});

test("a byte order mark doesn't stick to the first column; bad JSON says which file", async () => {
  const f = fakeHost({ "Finance/export.csv": { raw: `﻿${CSV}` }, "Data/bad.json": { raw: "{nope" } });
  const dl = new DataLayer(f.host);
  const rows = (await load(dl, panelOf({ view: "table", source: "Finance/export.csv", limit: 1 }))) as Record<string, unknown>[];
  assert.deepEqual(Object.keys(rows[0]), ["Date", "Description", "Amount", "Category"]);
  await assert.rejects(load(dl, panelOf({ view: "table", source: "Data/bad.json" })), /^Error: Can't read Data\/bad\.json: /);
});

test("a file is read once until it changes, and a change reaches only the panels that read it", async () => {
  const f = fakeHost({ "Finance/bank.csv": { raw: CSV }, "Finance/cards.csv": { raw: "Card,Limit\nVisa,5000\n" } });
  const reads: string[] = [];
  const read = f.host.readFile;
  f.host.readFile = (path) => { reads.push(path); return read(path); };
  const dl = new DataLayer(f.host);
  const bank = panelOf({ view: "table", source: "[[bank.csv]]" });
  const cards = panelOf({ view: "table", source: "Finance/cards.csv" });
  const heard: string[][] = [];
  dl.subscribe(dl.depsOf(bank.source, bank, FILES), (c) => heard.push(["bank", ...c]));
  dl.subscribe(dl.depsOf(cards.source, cards, FILES), (c) => heard.push(["cards", ...c]));

  await load(dl, bank);
  await load(dl, bank);
  await load(dl, cards);
  assert.deepEqual(reads, ["Finance/bank.csv", "Finance/cards.csv"]);

  f.files.get("Finance/bank.csv")!.raw = "Date,Description,Amount,Category\n2026-11-09,Gym,-30,Health\n";
  dl.fileChanged("Finance/bank.csv");
  f.flush();
  assert.deepEqual(heard.map((h) => h[0]), ["bank"]);
  assert.deepEqual(await load(dl, bank), [{ Date: "2026-11-09", Description: "Gym", Amount: -30, Category: "Health" }]);
  await load(dl, cards);
  assert.deepEqual(reads, ["Finance/bank.csv", "Finance/cards.csv", "Finance/bank.csv"]);
  // A file that isn't a note never becomes a row of a notes query.
  assert.deepEqual(dl.notes("Finance"), []);
});

test("a missing file is the panel's error, and the panel loads once the file appears", async () => {
  const bank = { view: "table", source: "Finance/bank.csv", columns: ["Description", "Amount"] };
  const t = fakeEnv({ "Apps/Bank.md": { fm: { app: "Bank", panels: [bank] } } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Bank.md", t.env).load();
  await settle();
  assert.equal(text(root.querySelector(".gz-panel.gz-error")), "tableCan't find Finance/bank.csvTry againShow in source");

  t.f.files.set("Finance/bank.csv", { raw: CSV });
  t.changed("Finance/bank.csv");
  await settle();
  assert.equal(root.querySelector(".gz-error"), null);
  assert.equal(root.querySelectorAll("tbody tr").length, 4);
});

test("an app's panel on a file follows the file, and leaves the panels on other files alone", async () => {
  const note = { app: "Money", panels: [
    { view: "table", title: "Bank", source: "Finance/bank.csv", columns: ["Description"] },
    { view: "table", title: "Cards", source: "Finance/cards.csv", columns: ["Card"] },
  ] };
  const t = fakeEnv({ "Apps/Money.md": { fm: note }, "Finance/bank.csv": { raw: CSV }, "Finance/cards.csv": { raw: "Card,Limit\nVisa,5000\n" } });
  const reads: string[] = [];
  const read = t.f.host.readFile;
  t.f.host.readFile = (path) => { reads.push(path); return read(path); };
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Money.md", t.env).load();
  await settle();
  const [bank, cards] = [...root.querySelectorAll(".gz-panel")];
  assert.equal(bank.querySelectorAll("tbody tr").length, 4);

  t.f.files.get("Finance/bank.csv")!.raw = `${CSV}2026-11-06,Gym,-30,Health\n`;
  t.changed("Finance/bank.csv");
  await settle();
  assert.equal(bank.querySelectorAll("tbody tr").length, 5);
  assert.equal(text(cards.querySelector("tbody tr")), "Visa");
  assert.deepEqual(reads, ["Finance/bank.csv", "Finance/cards.csv", "Finance/bank.csv"]);
});

test("a file needs a permission, worded as reading that file", () => {
  const spec = (source: string) => readSpec({ app: "x", view: "table", source }, { path: "Apps/Bank.md" })!.spec!;
  assert.deepEqual(permissionsOf(spec("Finance/bank.csv"), "Apps/Bank.md"), ["read:Finance/bank.csv"]);
  assert.deepEqual(permissionsOf(spec("[[Finance/bank.csv|My bank]]"), "Apps/Bank.md"), ["read:Finance/bank.csv"]);
  assert.deepEqual(permissionsOf(spec("[[bank.csv]]"), "Apps/Bank.md"), ["read:bank.csv"]);
  assert.deepEqual([...askersOf(spec("Finance/bank.csv"), "Apps/Bank.md")], [["read:Finance/bank.csv", new Set(["Apps/Bank.md"])]]);
  assert.equal(describePermission("read:Finance/bank.csv"), "Read Finance/bank.csv");
  assert.equal(describePermission("read:Calendar/family.ics"), "Read Calendar/family.ics");
  assert.equal(describePermission("read:bank.csv"), "Read bank.csv");
});

test("a $name can't choose a file", () => {
  const refused = (source: string) => readSpec({ app: "x", inputs: { f: ["a.csv", "b.csv"] }, view: "table", source })!.errors;
  const message = "$f can't choose the source; use it in a URL's path or query, or in where";
  assert.ok(refused("Finance/$f").includes(message), refused("Finance/$f").join("; "));
  assert.ok(refused("$f").includes(message));
  assert.ok(refused("Finance/$f.csv").includes(message));
  // A selection is a name too.
  const picked = readSpec({ app: "x", panels: [
    { view: "table", source: "notes", from: "Books", select: "book" },
    { view: "table", source: "Finance/$book.csv" },
  ] })!.errors;
  assert.ok(picked.some((e) => e.includes("$book can't choose the source")), picked.join("; "));
});

test("a note created by an app shows up in a notes query at once, and again with its properties", () => {
  const f = fakeHost({ "Reading/a.md": { fm: { read: true } }, "Inbox/x.md": {} });
  const dl = new DataLayer(f.host);
  assert.deepEqual(dl.notes("Reading").map((r) => r.name), ["a"]);
  const heard: string[][] = [];
  dl.subscribe(["notes:Reading"], (c) => heard.push([...c]));

  // The vault's create event: the metadata cache hasn't read the new note yet.
  f.files.set("Reading/b.md", {});
  dl.fileChanged("Reading/b.md");
  f.flush();
  assert.deepEqual(dl.notes("Reading").map((r) => r.name), ["a", "b"]);
  assert.equal(dl.notes("Reading")[1].link, undefined);
  assert.equal(heard.length, 1);

  // Then the metadata cache's changed event.
  f.files.get("Reading/b.md")!.fm = { link: "https://example.com/b", read: false };
  dl.fileChanged("Reading/b.md");
  f.flush();
  assert.deepEqual(dl.notes("Reading").map((r) => [r.name, r.link, r.read]), [["a", undefined, true], ["b", "https://example.com/b", false]]);
  assert.equal(heard.length, 2);
});

test("a file that isn't a note is announced as file:<path> without becoming a row", () => {
  const f = fakeHost({ "Finance/old.md": { fm: {} } });
  const dl = new DataLayer(f.host);
  assert.equal(dl.notes("Finance").length, 1);
  const heard: string[][] = [];
  dl.subscribe(["file:Finance/bank.csv", "notes:Finance"], (c) => heard.push([...c]));
  f.files.set("Finance/bank.csv", { raw: CSV });
  dl.fileChanged("Finance/bank.csv");
  f.flush();
  assert.deepEqual(heard, [["file:Finance/bank.csv"]]);
  assert.equal(dl.notes("Finance").length, 1);
});
