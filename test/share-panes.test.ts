import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import { toBundle } from "../src/bundle.ts";
import { ledgerStore } from "../src/datastore.ts";
import { notesToShare } from "../src/install.ts";
import { drawKindPlan, kindLists, offerList } from "../src/kind-pane.ts";
import { checkSaid, extractSaid, sealExtract, sealSaid, sealedKindAt } from "../src/seal-actions.ts";
import { drawInstall, drawShare } from "../src/share-pane.ts";
import { runtimeOn } from "./support/runtime.ts";

// Share, Install, Make a list a kind and the seal actions as panes and helpers any host uses:
// Obsidian's modals and commands and the standalone app's windows wrap these.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T, ms = 2000): Promise<T> => {
  for (let t = 0; t < ms; t += 20) {
    const v = fn();
    if (v) return v;
    await wait(20);
  }
  return fn();
};
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const texts = (el: Element, sel: string) => [...el.querySelectorAll(sel)].map(text);
const button = (el: Element, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

const READING = {
  app: "Reading",
  data: { books: { source: "notes", from: "Books" } },
  panels: [
    { view: "list", source: "books", action: "Add", save: "Books/", name: "{title}", template: "[[Book template]]" },
    { view: "number", title: "Due", source: "books", agg: "count", alert: "> 5", then: { app: "[[Errands]]", do: "add" } },
  ],
};
/** A note as the test vault keeps it, its body read back as a real host reads the whole note. */
const noteOf = (fm: Record<string, unknown>) => ({ fm: structuredClone(fm), body: `---\n${stringify(fm)}---\n` });
/** Reading and the template it takes along. */
const reading = () => ({ "Apps/Reading.md": noteOf(READING), "Templates/Book template.md": { body: "# {title}\n" } });

test("Share: what goes along, the warnings, the text; Copy copies it, says so and closes", async () => {
  const t = await runtimeOn(reading());
  const got = await notesToShare(t.runtime, "Apps/Reading.md");
  assert.ok(!("error" in got), JSON.stringify(got));
  const bundle = toBundle(got.notes, got.about);
  assert.ok(!("error" in bundle));
  const el = document.createElement("div");
  const did: string[] = [];
  drawShare(el, "Reading", got.notes, bundle.text, got.runs, {
    copy: (value, done) => { did.push(`copied ${value.length}`); done(); },
    notify: (m) => did.push(m),
    close: () => did.push("closed"),
  });
  const said = texts(el, "p");
  assert.equal(said[0], "It takes Book template along with Reading.");
  assert.match(said[1], /^It runs “add” in Errands, which isn't included/);
  assert.equal((el.querySelector("textarea") as HTMLTextAreaElement).value, bundle.text);
  button(el, "Copy").click();
  assert.deepEqual(did, [`copied ${bundle.text.length}`, "Copied Reading; paste it in a gist or a message to share it", "closed"]);
});

test("Install: pasted text is read at once and previewed; its own name is refused; a link waits for Preview; Install plans again at the click", async () => {
  const source = await runtimeOn(reading());
  const got = await notesToShare(source.runtime, "Apps/Reading.md");
  assert.ok(!("error" in got));
  const bundle = toBundle(got.notes, got.about);
  assert.ok(!("error" in bundle));

  // Into a vault that has Reading already: refused, Install stays off.
  const same = await runtimeOn(reading());
  const refused = document.createElement("div");
  drawInstall(refused, same.runtime, { start: bundle.text, tryIt: () => assert.fail("tried"), install: async () => assert.fail("installed"), close: () => {} });
  await until(() => refused.querySelector("h4"));
  assert.match(text(refused.querySelector(".gz-error-text")), /Reading.*; rename or move that note to install this\./);
  assert.equal(button(refused, "Install").disabled, true);
  assert.equal(button(refused, "Try it").disabled, false, "an app can still be tried");

  // Into an empty vault: what it makes, then Install with a plan made at the click.
  const fresh = await runtimeOn({});
  const el = document.createElement("div");
  const installed: { creates: string[]; name: string }[] = [];
  let closed = 0;
  drawInstall(el, fresh.runtime, {
    start: bundle.text,
    tryIt: () => {},
    install: async (plan, name) => { installed.push({ creates: "refusal" in plan ? [] : plan.create.map((n) => n.path), name }); return true; },
    close: () => { closed++; },
  });
  await until(() => el.querySelector("h4"));
  assert.equal(text(el.querySelector("h4")), "Reading");
  assert.ok(texts(el, "p").includes("Creates Book template, Reading."), texts(el, "p").join(" | "));
  button(el, "Install").click();
  await until(() => closed);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].name, "Reading");
  assert.equal(installed[0].creates.length, 2);

  // A link only says where it would fetch from until Preview is pressed.
  const fetched: string[] = [];
  const layer = fresh.runtime.dataLayer.host;
  const real = layer.fetch.bind(layer);
  layer.fetch = async (url, headers, init) => { fetched.push(url); return real(url, headers, init); };
  const linked = document.createElement("div");
  drawInstall(linked, fresh.runtime, { start: "https://gist.example.com/raw/reading.md", tryIt: () => {}, install: async () => true, close: () => {} });
  await wait(30);
  assert.equal(text(linked.querySelector(".gz-install-preview p")), "Press Preview to fetch gist.example.com");
  assert.deepEqual(fetched, [], "nothing fetched before Preview");
  button(linked, "Preview").click();
  await until(() => fetched.length);
  assert.deepEqual(fetched, ["https://gist.example.com/raw/reading.md"]);
});

const SPEND = {
  app: "Log what I spend",
  data: { spend: { source: "spend", fields: { amount: { type: "number" }, note: "text" } } },
  panels: [{ view: "form", title: "Spent something", save: "spend", label: "Add" }, { view: "table", title: "Recent", source: "spend" }],
};

test("Make a list a kind: the lists an app could give, the plan line by line, a failure said in place, success closing", async () => {
  const t = await runtimeOn({ "Apps/Budget.md": noteOf(SPEND), "Apps/Notes.md": { fm: { app: "Notes", panels: [{ view: "value", value: 1 }] }, body: "" } });
  const store = ledgerStore(t.runtime.dataLayer.ledger!, "Apps/Budget data.md", () => SPEND);
  await store.add("spend", { amount: 12, note: "lunch", at: "2026-11-18T12:00" });
  assert.deepEqual(kindLists(t.runtime, "Apps/Notes.md", { app: "Notes", panels: [{ view: "value", value: 1 }] }), { error: "Notes saves no rows of its own to make a kind of" });
  const found = kindLists(t.runtime, "Apps/Budget.md", SPEND);
  assert.ok(!("error" in found));
  assert.deepEqual(found.lists, ["spend"]);
  const offered = await offerList(t.runtime, "Apps/Budget.md", SPEND, found.spec, "spend");
  assert.ok(!("error" in offered), JSON.stringify(offered));

  const el = document.createElement("div");
  let tries = 0;
  let closed = 0;
  drawKindPlan(el, "Budget", offered.plan, offered.rows, { make: async () => (++tries === 1 ? "Couldn't: the disk is full" : undefined), close: () => { closed++; } });
  const items = texts(el, "li");
  assert.match(items[0], /^Makes the note .*\.md, with the fields Budget gives spend\.$/);
  assert.equal(items[1], "Carries its 1 row over.");
  assert.ok(el.querySelector("li pre"), "the changed line, before and after");
  button(el, "Make the kind").click();
  await until(() => text(el.querySelector(".gz-new-app-problem")));
  assert.equal(text(el.querySelector(".gz-new-app-problem")), "Couldn't: the disk is full");
  assert.equal(button(el, "Make the kind").disabled, false);
  button(el, "Make the kind").click();
  await until(() => closed);
  assert.equal(tries, 2);
});

test("the seal actions: a kind that isn't sealed says how; Seal, Check, and an extract written beside the kind, numbered when taken", async () => {
  const ev = (t: number, row: string) => `${JSON.stringify({ op: "add", l: "dose", row, v: { what: "morning" }, t: `${new Date(t).toISOString()}/0`, d: "d1mac000" })}\n`;
  const t = await runtimeOn({ "Kinds/Dose.md": { fm: { kind: "dose", fields: { what: "text" }, seal: true } }, "Kinds/Plain.md": { fm: { kind: "plain", fields: { what: "text" } } }, "Apps/A.md": { fm: { app: "A", panels: [] } } });
  t.f.advance(Date.UTC(2026, 10, 22) - t.f.host.now());
  t.f.others.set("Kinds/Dose data/log/d1mac000-2026-11.jsonl", ev(Date.UTC(2026, 10, 19), "00000000000000a1"));

  assert.equal(sealedKindAt(t.runtime, "Apps/A.md"), undefined, "an app is no kind");
  assert.match((sealedKindAt(t.runtime, "Kinds/Plain.md") as { why: string }).why, /^Plain isn't sealed: add seal: true/);
  const k = sealedKindAt(t.runtime, "Kinds/Dose.md");
  assert.ok(k && !("why" in k));
  assert.match(await sealSaid(t.runtime, k), /^Sealed/);
  assert.match(await checkSaid(t.runtime, k), /Dose/);

  const first = await sealExtract(t.runtime, k);
  assert.match(first, /^Kinds\/Dose sealed \d{4}-\d{2}-\d{2}\.html$/);
  assert.match(t.f.others.get(first) ?? "", /<html/i);
  const second = await sealExtract(t.runtime, k);
  assert.equal(second, first.replace(/\.html$/, " 2.html"));
  assert.equal(extractSaid(first), `Made ${first}: one file that checks itself in any browser`);
});
