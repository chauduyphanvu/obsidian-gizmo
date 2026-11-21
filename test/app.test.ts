import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController, type AppEnv } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { checkPanel, panelIds, type Panel } from "../src/spec.ts";
import { seriesNames } from "../src/views/common.ts";
import { VIEW_DEFS, type PanelCtx } from "../src/views/registry.ts";
import { fakeHost } from "./support/fakes.ts";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };

/** A controller on a fake vault. `edit` changes a note the way Obsidian would and delivers the change. */
function setup(notes: Parameters<typeof fakeHost>[0]) {
  const f = fakeHost(notes);
  const data = new DataLayer(f.host);
  const writes: string[] = [];
  const notices: string[] = [];
  const edit = async (path: string, change: (fm: Record<string, unknown>) => void) => {
    const note = f.files.get(path) ?? { fm: {} };
    note.fm ??= {};
    change(note.fm);
    f.files.set(path, note);
    data.fileChanged(path);
    f.flush();
    await settle();
  };
  const env: AppEnv = {
    data,
    frontmatter: (path) => f.files.get(path)?.fm,
    notes: {
      resolve: (link) => [...f.files.keys()].find((p) => p === `${link}.md` || p.endsWith(`/${link}.md`)),
      frontmatter: (path) => f.files.get(path)?.fm,
    },
    isGranted: () => true,
    granted: () => [],
    grant: async () => {},
    storePath: (store) => `${store}.md`,
    writeFrontmatter: async (path, fn) => { writes.push(path); await edit(path, fn); },
    updateFrontmatter: async (path, fn) => {
      if (!f.files.has(path)) return false;
      writes.push(path);
      await edit(path, fn);
      return true;
    },
    appendLine: async (path) => { writes.push(path); },
    createNote: async () => false,
    readBody: async () => "",
    setTaskDone: async () => false,
    notify: (m) => { notices.push(m); },
    openNote: () => {},
    showSource: () => {},
    showSourceAt: () => {},
    sourceLines: async () => [],
    copy: () => {},
    now: () => new Date(2026, 10, 18, 12, 0),
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, "Apps/W.md", env);
  return { app, root, edit, writes, notices, f };
}

const text = (el: Element | null | undefined) => el?.textContent ?? "";

test("every view's examples draw", () => {
  const ctx: PanelCtx = {
    now: new Date(2026, 10, 18), width: () => 600,
    runActions: async () => {}, toggleChecked: async () => {}, clearChecked: async () => {},
    openNote: () => {}, timer: () => ({ remainingMs: 60_000 }),
    startTimer: () => {}, pauseTimer: () => {}, resetTimer: () => {},
    select: () => {}, selected: () => undefined, editRow: async () => {},
  };
  for (const def of VIEW_DEFS) {
    for (const ex of def.examples.filter((e) => !e.errors)) {
      const p = checkPanel(ex.panel, true).panel as Panel;
      const xField = p.group ?? p.x;
      const ys = seriesNames(p).length ? seriesNames(p) : ["count"];
      const row = (x: string, v: number) => ({ [xField!]: x, ...Object.fromEntries(ys.map((y) => [y, v])) });
      const rows = xField
        ? [row("2026-11-17", 1), row("2026-11-18", 2)]
        : def.id === "checklist" ? ["Passport"] : [{ weight: 80, name: "Dentist", path: "Health/Dentist.md", date: "2026-12-04", temp: 7 }];
      const el = document.createElement("div");
      def.mount(el, p, ctx, "k").update(def.needsSource || p.source || def.implicitSource ? rows : undefined);
      assert.ok(el.childNodes.length > 0, `${def.id} drew nothing for ${JSON.stringify(ex.panel)}`);
    }
  }
});

test("panel ids are stable and tell identical panels apart", () => {
  const a = { view: "countdown", to: "2027-01-01" };
  const b = { view: "number", source: "x" };
  const ids = panelIds([a, b, a]);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(panelIds([b, a]), [ids[1], ids[0]]);
  assert.deepEqual(panelIds([{ to: "2027-01-01", view: "countdown" }]), [ids[0]]);
});

test("a slow web source doesn't hold up the other panels", async () => {
  const { app, root } = setup({
    "Apps/W.md": { fm: { app: "x", panels: [
      { view: "number", source: "https://api.example.com/never", field: "t" },
      { view: "countdown", to: "2026-12-18" },
    ] } },
  });
  app.load();
  await settle();
  assert.ok(root.querySelector(".gz-view-number")!.classList.contains("gz-loading"));
  assert.equal(text(root.querySelector(".gz-view-countdown .gz-big")), "30days");
});

test("new data updates its panel and leaves typed input alone", async () => {
  const { app, root, edit } = setup({
    "Apps/W.md": { fm: { app: "x", panels: [
      { view: "form", fields: { weight: "number" }, save: "weights" },
      { view: "number", source: "weights", field: "weight" },
    ] } },
    "Apps/W data.md": { fm: { weights: [{ weight: 80.2 }] } },
  });
  app.load();
  await settle();
  assert.equal(text(root.querySelector(".gz-view-number .gz-big")), "80.2");
  const input = root.querySelector(".gz-form input") as HTMLInputElement;
  input.value = "77";
  await edit("Apps/W data.md", (fm) => { fm.weights = [{ weight: 80.2 }, { weight: 79.5 }]; });
  assert.equal(text(root.querySelector(".gz-view-number .gz-big")), "79.5");
  assert.equal(root.querySelector(".gz-form input"), input);
  assert.equal(input.value, "77");
});

test("editing one panel's keys keeps the other panels as they are", async () => {
  const panels = [
    { view: "form", fields: { weight: "number" }, save: "weights" },
    { view: "number", source: "weights", field: "weight" },
  ];
  const { app, root, edit } = setup({ "Apps/W.md": { fm: { app: "x", panels } }, "Apps/W data.md": { fm: { weights: [{ weight: 80 }] } } });
  app.load();
  await settle();
  const form = root.querySelector(".gz-view-form");
  const before = root.querySelector(".gz-view-number");
  await edit("Apps/W.md", (fm) => { fm.panels = [panels[0], { ...panels[1], unit: "kg" }, { view: "countdown", to: "2027-01-01" }]; });
  assert.equal(root.querySelector(".gz-view-form"), form);
  assert.notEqual(root.querySelector(".gz-view-number"), before);
  assert.equal(text(root.querySelector(".gz-view-number .gz-unit")), "kg");
  assert.deepEqual([...root.querySelectorAll(".gz-panel")].map((e) => e.className.split(" ")[1]), ["gz-view-form", "gz-view-number", "gz-view-countdown"]);
});

test("a notes panel follows edits to the notes it reads", async () => {
  const { app, root, edit } = setup({
    "Apps/W.md": { fm: { app: "x", view: "list", source: "notes", from: "Health", item: "{date} {name}" } },
    "Health/Dentist.md": { fm: { date: "2026-12-04" } },
  });
  app.load();
  await settle();
  assert.equal(text(root.querySelector(".gz-list")), "2026-12-04 Dentist");
  await edit("Health/Dentist.md", (fm) => { fm.date = "2026-12-20"; });
  assert.equal(text(root.querySelector(".gz-list")), "2026-12-20 Dentist");
});

test("saving writes the data note, never the app note", async () => {
  const { app, root, writes, f } = setup({
    "Apps/W.md": { fm: { app: "x", panels: [
      { view: "button", label: "Took meds", save: "doses", notify: "Logged" },
      { view: "number", source: "doses", where: { at: "today" }, agg: "count" },
    ] } },
  });
  app.load();
  await settle();
  (root.querySelector("button.gz-button") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(writes, ["Apps/W data.md"]);
  assert.equal(f.files.get("Apps/W data.md")?.fm?.doses instanceof Array, true);
  assert.equal(text(root.querySelector(".gz-view-number .gz-big")), "1");
});

test("broken keys show the problems and redraw once fixed", async () => {
  const { app, root, edit } = setup({ "Apps/W.md": { fm: { app: "x", panels: [{ view: "gauge" }] } } });
  app.load();
  await settle();
  assert.match(text(root.querySelector(".gz-error")), /view must be one of/);
  await edit("Apps/W.md", (fm) => { fm.panels = [{ view: "countdown", to: "2026-11-25" }]; });
  assert.equal(root.querySelector(".gz-error"), null);
  assert.equal(text(root.querySelector(".gz-big")), "7days");
});

test("editing a data block remounts only the panels that use it", async () => {
  const panels = [
    { view: "number", source: "weekly", field: "weight" },
    { view: "number", source: "weights", field: "weight", agg: "max" },
  ];
  const { app, root, edit } = setup({
    "Apps/W.md": { fm: { app: "x", data: { weekly: { source: "weights", limit: 1 } }, panels } },
    "Apps/W data.md": { fm: { weights: [{ weight: 80 }, { weight: 82 }] } },
  });
  app.load();
  await settle();
  const [first, second] = [...root.querySelectorAll(".gz-view-number")];
  assert.equal(text(first.querySelector(".gz-big")), "80");
  await edit("Apps/W.md", (fm) => { fm.data = { weekly: { source: "weights", sort: "-weight", limit: 1 } }; });
  const [first2, second2] = [...root.querySelectorAll(".gz-view-number")];
  assert.notEqual(first2, first);
  assert.equal(second2, second);
  assert.equal(text(first2.querySelector(".gz-big")), "82");
});

test("without tabs there's no tab bar; spans become classes, in twelfths of the row", async () => {
  const { app, root } = setup({ "Apps/W.md": { fm: { app: "x", panels: [
    { view: "countdown", to: "2027-01-01" },
    { view: "countdown", to: "2027-02-01", span: 2 },
    { view: "line", source: "weights", x: "at", y: "weight" },
  ] } } });
  app.load();
  await settle();
  assert.equal(root.querySelector(".gz-tabs"), null);
  assert.equal(root.querySelector(".gz-grid")!.className, "gz-grid gz-cols-4");
  assert.deepEqual([...root.querySelectorAll(".gz-panel")].map((e) => [...e.classList].find((c) => c.startsWith("gz-span-"))), ["gz-span-3", "gz-span-6", "gz-span-12"]);
});

test("small panels that asked for no span share their row instead of leaving part of it empty", async () => {
  const { app, root } = setup({ "Apps/W.md": { fm: { app: "x", panels: [
    { view: "countdown", to: "2027-01-01" },
    { view: "countdown", to: "2027-02-01" },
    { view: "line", source: "weights", x: "at", y: "weight" },
  ] } } });
  app.load();
  await settle();
  assert.deepEqual([...root.querySelectorAll(".gz-panel")].map((e) => [...e.classList].find((c) => c.startsWith("gz-span-"))), ["gz-span-6", "gz-span-6", "gz-span-12"]);
});

test("tabs: untabbed panels stay above the bar; switching keeps elements and typed text", async () => {
  const { app, root } = setup({
    "Apps/W.md": { fm: { app: "x", panels: [
      { view: "countdown", to: "2027-01-01" },
      { view: "form", fields: { weight: "number" }, save: "weights", tab: "Log" },
      { view: "line", source: "weights", x: "at", y: "weight", tab: "Chart" },
      { view: "countdown", to: "2027-02-01", tab: "Log" },
    ] } },
    "Apps/W data.md": { fm: { weights: [{ at: "2026-11-17", weight: 80 }, { at: "2026-11-18", weight: 79 }] } },
  });
  app.load();
  await settle();
  const children = [...root.querySelector(".gz-grid")!.children];
  assert.deepEqual(children.map((e) => e.classList.contains("gz-tabs") ? "tabs" : e.className.split(" ")[1]),
    ["gz-view-countdown", "tabs", "gz-view-form", "gz-view-line", "gz-view-countdown"]);
  const tabs = [...root.querySelectorAll("button.gz-tab")] as HTMLButtonElement[];
  assert.deepEqual(tabs.map((b) => [b.textContent, b.classList.contains("is-active")]), [["Log", true], ["Chart", false]]);
  const off = () => children.filter((e) => e.classList.contains("gz-off")).map((e) => e.className.split(" ")[1]);
  assert.deepEqual(off(), ["gz-view-line"]);
  // A chart in a hidden tab is still drawn at its real width.
  assert.equal(root.querySelector(".gz-chart-svg")!.getAttribute("viewBox"), "0 0 912 220");

  const input = root.querySelector(".gz-form input") as HTMLInputElement;
  input.value = "77";
  tabs[1].click();
  assert.deepEqual(off(), ["gz-view-form", "gz-view-countdown"]);
  tabs[0].click();
  assert.equal(root.querySelector(".gz-form input"), input);
  assert.equal(input.value, "77");
});

test("the open tab survives an edit to the note while it still exists", async () => {
  const panels = [{ view: "countdown", to: "2027-01-01", tab: "A" }, { view: "countdown", to: "2027-02-01", tab: "B" }];
  const { app, root, edit } = setup({ "Apps/W.md": { fm: { app: "x", panels } } });
  app.load();
  await settle();
  (root.querySelectorAll("button.gz-tab")[1] as HTMLButtonElement).click();
  await edit("Apps/W.md", (fm) => { fm.panels = [...panels, { view: "countdown", to: "2027-03-01", tab: "C" }]; });
  assert.deepEqual([...root.querySelectorAll("button.gz-tab.is-active")].map((b) => b.textContent), ["B"]);
  await edit("Apps/W.md", (fm) => { fm.panels = [panels[0]]; });
  assert.deepEqual([...root.querySelectorAll("button.gz-tab.is-active")].map((b) => b.textContent), ["A"]);
});
