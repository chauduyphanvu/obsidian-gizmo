import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { HostedApp } from "../src/hosted.ts";
import { LensIndex, LensStack } from "../src/lenses.ts";
import { readComponentPreview } from "../src/spec.ts";
import { fakeEnv, listsIn } from "./support/fakes.ts";
import { parseYaml, vaultNote } from "./support/yaml.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const change = (el: Element) => el.dispatchEvent(new window.Event("change", { bubbles: true }));
const choose = (select: Element, label: string) => {
  for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === label);
  change(select);
};

/** The Books folder of the test vault, as notes. */
function books() {
  const names = readdirSync(new URL("./vault/Books", import.meta.url)).filter((n) => n.endsWith(".md"));
  return Object.fromEntries(names.map((n) => [`Books/${n}`, { fm: vaultNote(`Books/${n}`).fm }]));
}

test("Reading progress: a lens above every book tracks the page I'm on, saved in the book itself", async () => {
  const component = vaultNote("Components/Reading progress.md").fm;
  const t = fakeEnv({ "Components/Reading progress.md": { fm: component }, "Apps/Library.md": { fm: vaultNote("Apps/Library.md").fm }, ...books() });
  const preview = readComponentPreview(component, { path: "Components/Reading progress.md", notes: t.env.notes });
  assert.deepEqual(preview.result.errors, []);
  assert.equal(preview.lens, "Books");

  const index = new LensIndex(t.data);
  assert.deepEqual(index.lensesFor("Books/Dune.md"), ["Components/Reading progress.md"]);
  assert.deepEqual(index.lensesFor("Apps/Library.md"), []);

  const grants: Record<string, string[]> = {};
  t.env.isGranted = (key, wanted) => wanted.length === 0 || (grants[key] ?? []).join("\n") === wanted.join("\n");
  t.env.grant = async (key, wanted) => { grants[key] = wanted; };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const stack = new LensStack(el, index, () => t.env, { folded: () => false, setFolded: () => {} });
  stack.show("Books/Dune.md");
  await settle();
  assert.equal(text(el.querySelector(".gz-lens-name")), "Reading progress");
  assert.deepEqual([...el.querySelectorAll(".gz-card li")].map(text), ["Change properties of notes in Books"]);
  (el.querySelector(".gz-card button.mod-cta") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(grants, { "Components/Reading progress.md": ["edit:Books"] });
  assert.equal(el.querySelector(".gz-error"), null);
  assert.equal(text(el.querySelector(".gz-view-progress .gz-big")), "412/ 412 pages");

  const form = el.querySelector("form.gz-form")!;
  const [page, pages] = [...form.querySelectorAll("input")] as HTMLInputElement[];
  const status = form.querySelector("select")!;
  assert.deepEqual([page.value, pages.value, text(status.querySelector("option[selected]"))], ["412", "412", "done"]);
  page.value = "100";
  change(page);
  await settle();
  choose(status, "reading");
  await settle();
  assert.deepEqual(t.f.files.get("Books/Dune.md")!.fm, { finished: "2026-02-10", status: "reading", page: 100, pages: 412 });
  assert.equal(text(el.querySelector(".gz-view-progress .gz-big")), "100/ 412 pages");
  assert.deepEqual(t.writes, ["Books/Dune.md", "Books/Dune.md"]);
  stack.dispose();
});

test("Today: my day at a glance, logging meds and water from the note itself", async () => {
  const today = vaultNote("Today.md");
  const sources = [...today.body.matchAll(/```gizmo\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(sources.length, 2);
  const t = fakeEnv({ "Today.md": { fm: today.fm }, "Apps/Meds.md": { fm: vaultNote("Apps/Meds.md").fm }, "Daily.md": {} });
  const [meds, water] = sources.map((source) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    new HostedApp(el, parseYaml(source), source, "Today.md", t.env).load();
    return el;
  });
  await settle();
  assert.equal(meds.querySelector(".gz-error"), null);
  assert.equal(water.querySelector(".gz-error"), null);

  // Meds, as that app: only the panel asked for, saving to Meds's own data note.
  assert.deepEqual([...meds.querySelectorAll(".gz-panel")].map((p) => text(p)), ["Took meds"]);
  (meds.querySelector("button.gz-button") as HTMLButtonElement).click();
  await settle();
  assert.equal((t.f.files.get("Apps/Meds data.md")!.fm!.doses as unknown[]).length, 1);
  assert.deepEqual(t.notices, ["Logged"]);

  // Water, an app of the note's own, saving to its data note.
  assert.equal(text(water.querySelector(".gz-view-number .gz-big")), "0of 8");
  (water.querySelector("button.gz-button") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(listsIn(t.f.files.get("Today data.md")!.fm), { water: [{ at: "2026-11-18T12:00" }] });
  assert.equal(text(water.querySelector(".gz-view-number .gz-big")), "1of 8");
  assert.deepEqual(t.writes, ["Daily.md", "Apps/Meds data.md", "Today data.md"]);
});
