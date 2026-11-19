// Core interaction: search box, selections, row actions, saving notes, edit in place.
const OPENLIBRARY = ["https://openlibrary.org/search.json?q=dune&limit=10"];
const USGS = ["https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"];

const ROOMS = `---
app: Which room takes the most chores, and what is left there
data:
  chores:
    source: jobs
panels:
  - view: bar
    title: Chores per room
    source: chores
    group: room
    select: room
  - view: list
    title: In that room
    source: chores
    where: {room: $room.room}
    item: "{task}"
jobs:
  - {task: Wipe the counters, room: kitchen}
  - {task: Mop, room: kitchen}
  - {task: Scrub the tub, room: bathroom}
  - {task: Weed, room: garden}
---
`;

export default async function interaction(t) {
  const { check, run, expect, press, type } = t;

  await check("Library: typing and Enter searches, keeping the caret in the box; picking a result fills About", async () => {
    await run(`await na.open("Apps/Library");`);
    const before = await run(`
      const el = na.view().contentEl;
      const box = el.querySelector('input[aria-label="q"]');
      box.focus();
      const about = [...el.querySelectorAll(".na-panel")].find((p) => p.querySelector(".na-title")?.textContent === "About this book");
      return { focused: document.activeElement === box, about: na.text(about) };`);
    await type("dune");
    await press("Enter");
    const r = await run(`
      const el = na.view().contentEl;
      const box = el.querySelector('input[aria-label="q"]');
      const results = await na.until(() => el.querySelectorAll(".na-view-list li").length >= 3 && !el.querySelector(".na-loading, .na-stale"), 10000);
      await na.sleep(300);
      return { results: !!results, items: [...el.querySelectorAll(".na-view-list li")].slice(0, 3).map((li) => li.textContent), focused: document.activeElement === box, caret: box.selectionStart, value: box.value };`);
    // Tab from the box reaches the first result; Enter picks it.
    await press("Tab");
    const tabbed = await run(`return { cls: document.activeElement?.className, text: document.activeElement?.textContent?.slice(0, 40) };`);
    await press("Enter");
    const after = await run(`
      await na.sleep(800);
      const about = [...na.view().contentEl.querySelectorAll(".na-panel")].find((p) => p.querySelector(".na-title")?.textContent === "About this book");
      return na.text(about);`);
    expect(before.focused && before.about.includes("Pick a row in “Search results”"), before);
    expect(r.results && r.focused && r.caret === 4 && r.value === "dune", r);
    expect(/na-selectable/.test(tabbed.cls ?? ""), { tabbed, note: "Tab from the search box should reach the first result" });
    expect(/, by .+First published in \d{4}; \d+ editions\./.test(after), after);
    return `${r.items[0]} … caret ${r.caret}; About: ${after.slice(0, 70)}`;
  }, { net: OPENLIBRARY });

  await check("Library: Add on Dune says it exists; Add on a new title creates the note and the shelf shows it", async () => {
    const r = await run(`
      const el = na.view().contentEl;
      const items = [...el.querySelectorAll(".na-view-list li")];
      const dune = items.find((li) => li.textContent.startsWith("Dune · "));
      const other = items.find((li) => !li.textContent.startsWith("Dune · ") && !app.vault.getAbstractFileByPath("Books/" + li.textContent.split(" · ")[0] + ".md") && !/[\\\\/:*?"<>|#^\\[\\]]/.test(li.textContent.split(" · ")[0]));
      const mark = na.notices.length;
      na.button("Add", dune).click();
      const exists = await na.noticesSince(mark, "already exists");
      const title = other.textContent.split(" · ")[0];
      const shelfBefore = el.querySelectorAll(".na-view-table tbody tr").length;
      na.button("Add", other).click();
      const created = await na.until(() => na.fm("Books/" + title + ".md"), 5000);
      await na.until(() => el.querySelectorAll(".na-view-table tbody tr").length === shelfBefore + 1, 3000);
      const text = await na.read("Books/" + title + ".md");
      const shelf = [...el.querySelectorAll(".na-view-table tbody tr")].map((tr) => tr.textContent);
      await na.remove("Books/" + title + ".md");
      return { exists, title, created, text, shelfBefore, shelf };`);
    expect(r.exists.includes("“Dune” already exists"), r.exists);
    expect(r.created && r.created.title === r.title && r.created.status === "to read" && typeof r.created.year === "number" && r.created.at, r);
    expect(r.text.startsWith("---\n") && r.shelf.length === r.shelfBefore + 1 && r.shelf.some((s) => s.includes(r.title)), r);
    return `“Dune” already exists; created Books/${r.title}.md (year ${r.created.year}) and the shelf shows it`;
  }, { net: OPENLIBRARY });

  await check("Library: a status dropdown writes the note and keeps focus without redrawing the table", async () => {
    const r = await run(`
      await na.open("Apps/Library");
      const el = na.view().contentEl;
      const row = [...el.querySelectorAll(".na-view-table tbody tr")].find((tr) => tr.textContent.startsWith("Dune"));
      const select = row.querySelector("select");
      const table = el.querySelector(".na-view-table table");
      select.focus();
      na.choose(select, "reading");
      const written = await na.until(() => na.fm("Books/Dune.md")?.status === "reading", 3000);
      await na.sleep(800);
      const out = { written: !!written, sameSelect: row.isConnected && row.querySelector("select") === select, sameTable: el.querySelector(".na-view-table table") === table, focused: document.activeElement === select, value: select.selectedOptions[0]?.textContent };
      na.choose(select, "done");
      await na.until(() => na.fm("Books/Dune.md")?.status === "done", 3000);
      return out;`);
    expect(r.written && r.sameSelect && r.sameTable && r.focused && r.value === "reading", r);
    return "status: reading written; same table, focus kept";
  });

  await check("Chores: the form has task, room, done; Add lists it in To do; ticking it moves it to Done", async () => {
    const r = await run(`
      await na.open("Apps/Chores");
      const el = na.view().contentEl;
      const form = el.querySelector(".na-view-form");
      const fields = [...form.querySelectorAll(".na-field > span")].map((s) => s.textContent);
      na.fill(form.querySelector('input[type="text"]'), "Descale the kettle");
      na.choose(form.querySelector("select"), "kitchen");
      na.button("Add", form).click();
      const todo = () => [...el.querySelectorAll(".na-view-table tbody tr")];
      await na.until(() => todo().some((tr) => tr.textContent.includes("Descale the kettle")), 3000);
      const listed = todo().map((tr) => tr.textContent);
      const tick = todo().find((tr) => tr.textContent.includes("Descale the kettle")).querySelector('input[type="checkbox"]');
      tick.click();
      await na.until(() => !todo().some((tr) => tr.textContent.includes("Descale the kettle")), 3000);
      await na.sleep(500);
      return { fields, listed, after: todo().map((tr) => tr.textContent), done: el.querySelector(".na-view-number .na-big")?.textContent, saved: na.fm("Apps/Chores data.md")?.chores };`);
    expect(JSON.stringify(r.fields) === '["task","room","done"]', r.fields);
    expect(r.listed.some((x) => x.includes("Descale the kettle")) && !r.after.some((x) => x.includes("Descale the kettle")) && r.done === "1", r);
    expect(r.saved?.length === 1 && r.saved[0].done === true && r.saved[0].room === "kitchen", r.saved);
    return "added, ticked, Done 1";
  });

  await check("Planet Earth: switching the period loads that period's .geojson feed", async () => {
    const r = await run(`
      await na.open("Apps/Planet Earth");
      const el = na.view().contentEl;
      na.choose(el.querySelector('select[aria-label="period"]'), "1");
      await na.sleep(300);
      await na.until(() => !el.querySelector(".na-stale, .na-loading"), 10000);
      await na.sleep(300);
      const first = el.querySelector(".na-view-number");
      return { title: first.querySelector(".na-title")?.textContent, value: first.querySelector(".na-big")?.textContent, errors: na.errors() };`);
    expect(r.title === "Earthquakes, past day" && /^\d+$/.test(r.value ?? "") && r.errors === 0, r);
    return `${r.title}: ${r.value}`;
  }, { net: USGS });

  await check("a bar chart with select: clicking a bar dims the others and filters the list; again clears it", async () => {
    const r = await run(`
      await na.write("Scratch/Rooms.md", ${JSON.stringify(ROOMS)});
      await na.sleep(800);
      await na.open("Scratch/Rooms");
      const el = na.view().contentEl;
      const bars = () => [...el.querySelectorAll(".na-view-bar path.na-bar")];
      const list = () => na.text(el.querySelector(".na-view-list"));
      const waiting = list();
      bars().find((b) => b.getAttribute("aria-label") === "kitchen").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await na.sleep(600);
      const opacity = bars().map((b) => b.getAttribute("aria-label") + " " + getComputedStyle(b).opacity);
      const picked = list();
      bars().find((b) => b.classList.contains("na-selected")).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await na.sleep(600);
      return { waiting, opacity, picked, cleared: list(), after: bars().map((b) => getComputedStyle(b).opacity) };`);
    expect(r.waiting.includes("Pick a row in “Chores per room”"), r);
    expect(r.opacity.filter((o) => o === "kitchen 1").length === 1 && r.opacity.filter((o) => o.endsWith(" 0.35")).length === 2 && r.picked.includes("Wipe the counters") && r.picked.includes("Mop") && !r.picked.includes("Weed"), r);
    expect(r.cleared.includes("Pick a row") && r.after.every((o) => o === "1"), r);
    return `opacity ${r.opacity.join(",")}; list: ${r.picked}`;
  });
}
