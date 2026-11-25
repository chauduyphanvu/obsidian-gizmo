// Core interaction: search box, selections, row actions, saving notes, edit in place.
import { prompts } from "./apps.mjs";

const OPENLIBRARY = ["https://openlibrary.org/search.json?q=dune&limit=10"];
/** How long a search waits for Open Library, which can take well over ten seconds to answer. */
const OPENLIBRARY_WAIT = 30000;
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
  /** Whether the Library search got its results; the check that adds from them needs them. */
  let searched = false;

  await check("Library: typing and Enter searches, keeping the caret in the box; picking a result fills About in the sheet, and Escape closes it", async () => {
    await run(`await na.open("Apps/Library");`);
    const before = await run(`
      const el = na.view().contentEl;
      const box = el.querySelector('input[aria-label="q"]');
      box.focus();
      // Composed, About waits for a pick out of sight, in the sheet slot.
      const about = el.querySelector(".gz-sheet-slot > .gz-panel");
      return { focused: document.activeElement === box, waits: about.classList.contains("gz-collapsed") && !about.textContent };`);
    await type("dune");
    await press("Enter");
    const r = await run(`
      const el = na.view().contentEl;
      const box = el.querySelector('input[aria-label="q"]');
      const results = await na.until(() => el.querySelectorAll(".gz-view-list li").length >= 3 && !el.querySelector(".gz-loading, .gz-stale"), ${OPENLIBRARY_WAIT});
      await na.sleep(300);
      return { results: !!results, pending: !!el.querySelector(".gz-loading, .gz-stale"), items: [...el.querySelectorAll(".gz-view-list li")].slice(0, 3).map((li) => li.textContent), focused: document.activeElement === box, caret: box.selectionStart, value: box.value };`);
    // Still waiting for its answer says nothing about the plugin; an answer that is wrong does.
    if (!r.results && r.pending) t.skip(`Open Library hasn't answered in ${OPENLIBRARY_WAIT / 1000} s`);
    searched = r.results;
    // Tab from the box reaches the first result; Enter picks it.
    await press("Tab");
    const tabbed = await run(`return { cls: document.activeElement?.className, text: document.activeElement?.textContent?.slice(0, 40) };`);
    await press("Enter");
    // About opens in the sheet beside the results, with the focus.
    const opened = await run(`
      await na.sleep(800);
      const sheet = na.view().contentEl.querySelector(".gz-sheet.is-open");
      const about = [...(sheet?.querySelectorAll(".gz-sheet-panels > .gz-panel") ?? [])].find((p) => p.querySelector(".gz-title")?.textContent === "About this book");
      return { text: about ? na.text(about) : "", kicker: sheet?.querySelector(".gz-sheet-kicker")?.textContent, focused: !!document.activeElement?.closest(".gz-sheet") };`);
    const after = opened.text;
    await press("Escape");
    const closed = await run(`
      await na.sleep(400);
      const el = na.view().contentEl;
      const about = el.querySelector(".gz-sheet-slot > .gz-panel");
      return { open: !!el.querySelector(".gz-sheet.is-open"), waits: !!about && about.classList.contains("gz-collapsed") && !about.textContent, focus: document.activeElement?.className };`);
    expect(before.focused && before.waits, before);
    expect(r.results && r.focused && r.caret === 4 && r.value === "dune", r);
    expect(/gz-selectable/.test(tabbed.cls ?? ""), { tabbed, note: "Tab from the search box should reach the first result" });
    expect(/, by .+First published in \d{4}; \d+ editions\./.test(after), after);
    expect(opened.kicker === "Search results" && opened.focused, opened);
    // Escape closes the sheet: About waits out of sight again and the focus is back on the result.
    expect(!closed.open && closed.waits && /gz-selectable/.test(closed.focus ?? ""), closed);
    return `${r.items[0]} … caret ${r.caret}; About: ${after.slice(0, 70)}`;
  }, { net: OPENLIBRARY });

  await check("Library: Add on Dune says it exists; Add on a new title creates the note and the shelf shows it", async () => {
    if (!searched) t.skip("the search before it got no results from Open Library to add");
    const r = await run(`
      const el = na.view().contentEl;
      const items = [...el.querySelectorAll(".gz-view-list li")];
      const dune = items.find((li) => li.textContent.startsWith("Dune · "));
      const other = items.find((li) => !li.textContent.startsWith("Dune · ") && !app.vault.getAbstractFileByPath("Books/" + li.textContent.split(" · ")[0] + ".md") && !/[\\\\/:*?"<>|#^\\[\\]]/.test(li.textContent.split(" · ")[0]));
      const mark = na.notices.length;
      na.button("Add", dune).click();
      const exists = await na.noticesSince(mark, "already exists");
      const title = other.textContent.split(" · ")[0];
      const shelfBefore = el.querySelectorAll(".gz-view-table tbody tr").length;
      na.button("Add", other).click();
      const created = await na.until(() => na.fm("Books/" + title + ".md"), 5000);
      await na.until(() => el.querySelectorAll(".gz-view-table tbody tr").length === shelfBefore + 1, 3000);
      const text = await na.read("Books/" + title + ".md");
      const shelf = [...el.querySelectorAll(".gz-view-table tbody tr")].map((tr) => tr.textContent);
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
      const row = [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.startsWith("Dune"));
      const select = row.querySelector("select");
      const table = el.querySelector(".gz-view-table table");
      select.focus();
      na.choose(select, "reading");
      const written = await na.until(() => na.fm("Books/Dune.md")?.status === "reading", 3000);
      await na.sleep(800);
      const out = { written: !!written, sameSelect: row.isConnected && row.querySelector("select") === select, sameTable: el.querySelector(".gz-view-table table") === table, focused: document.activeElement === select, value: select.selectedOptions[0]?.textContent };
      na.choose(select, "done");
      await na.until(() => na.fm("Books/Dune.md")?.status === "done", 3000);
      return out;`);
    expect(r.written && r.sameSelect && r.sameTable && r.focused && r.value === "reading", r);
    return "status: reading written; same table, focus kept";
  });

  await check("Library: setting the day a book was finished writes the note and moves the reading goal", async () => {
    const r = await run(`
      await na.write("Books/Project Hail Mary.md", "---\\nstatus: reading\\n---\\n");
      await na.open("Apps/Library");
      const el = na.view().contentEl;
      const goal = () => el.querySelector(".gz-view-progress .gz-big")?.textContent;
      const row = await na.until(() => [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.startsWith("Project Hail Mary")), 3000);
      const before = goal();
      const d = new Date();
      const today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      na.fill(row.querySelector('input[type="date"]'), today);
      const written = await na.until(() => na.fm("Books/Project Hail Mary.md")?.finished === today, 3000);
      await na.until(() => goal() !== before, 3000);
      const after = goal();
      await na.remove("Books/Project Hail Mary.md");
      return { before, after, written: !!written, title: el.querySelector(".gz-view-progress .gz-title")?.textContent };`);
    const count = (s) => Number(s?.split("/")[0]);
    expect(r.written && r.title === "Reading goal" && /\/ 24 books$/.test(r.after ?? "") && count(r.after) === count(r.before) + 1, r);
    return `${r.before} → ${r.after}`;
  });

  await check("Chores: the form has task, room, done; Add lists it in To do; ticking it moves it to Done", async () => {
    const r = await run(`
      await na.open("Apps/Chores");
      const el = na.view().contentEl;
      const form = el.querySelector(".gz-view-form");
      const fields = [...form.querySelectorAll(".gz-field > span")].map((s) => s.textContent);
      na.fill(form.querySelector('input[type="text"]'), "Descale the kettle");
      na.choose(form.querySelector("select"), "kitchen");
      na.button("Add", form).click();
      const todo = () => [...el.querySelectorAll(".gz-view-table tbody tr")];
      await na.until(() => todo().some((tr) => tr.textContent.includes("Descale the kettle")), 3000);
      const listed = todo().map((tr) => tr.textContent);
      const tick = todo().find((tr) => tr.textContent.includes("Descale the kettle")).querySelector('input[type="checkbox"]');
      tick.click();
      await na.until(() => !todo().some((tr) => tr.textContent.includes("Descale the kettle")), 3000);
      await na.sleep(500);
      return { fields, listed, after: todo().map((tr) => tr.textContent), done: el.querySelector(".gz-view-number .gz-big")?.textContent, saved: na.fm("Apps/Chores data.md")?.chores };`);
    expect(JSON.stringify(r.fields) === '["task","room","done"]', r.fields);
    expect(r.listed.some((x) => x.includes("Descale the kettle")) && !r.after.some((x) => x.includes("Descale the kettle")) && r.done === "1", r);
    expect(r.saved?.length === 1 && r.saved[0].done === true && r.saved[0].room === "kitchen", r.saved);
    return "added, ticked, Done 1";
  });

  await check("Chores: ticking a row says so under the table with Undo, and ⌘Z puts it back", async () => {
    const r = await run(`
      await na.open("Apps/Chores");
      const el = na.view().contentEl;
      const form = el.querySelector(".gz-view-form");
      na.fill(form.querySelector('input[type="text"]'), "Water the plants");
      na.choose(form.querySelector("select"), "garden");
      na.button("Add", form).click();
      const todo = () => [...el.querySelectorAll(".gz-view-table tbody tr")];
      await na.until(() => todo().some((tr) => tr.textContent.includes("Water the plants")), 3000);
      todo().find((tr) => tr.textContent.includes("Water the plants")).querySelector('input[type="checkbox"]').click();
      const said = await na.until(() => el.querySelector(".gz-view-table ~ .gz-addline-under .gz-notice-text, .gz-panel + .gz-addline-under .gz-notice-text")?.textContent, 3000);
      document.activeElement?.blur();
      return { said, undo: !!el.querySelector(".gz-addline-under button.gz-undo") };`);
    expect(r.said === "Changed done from false to true" && r.undo, r);
    await t.press("z", 4);
    const back = await run(`
      const el = na.view().contentEl;
      const todo = () => [...el.querySelectorAll(".gz-view-table tbody tr")];
      await na.until(() => todo().some((tr) => tr.textContent.includes("Water the plants")), 3000);
      await na.sleep(300);
      return { listed: todo().some((tr) => tr.textContent.includes("Water the plants")), said: el.querySelector(".gz-notice-text")?.textContent, saved: na.fm("Apps/Chores data.md")?.chores?.find((c) => c.task === "Water the plants") };`);
    expect(back.listed && back.saved?.done === false && back.said === "Undone", back);
    return "said with Undo; ⌘Z put it back";
  });

  await check("Planet Earth: switching the period loads that period's .geojson feed", async () => {
    const r = await run(`
      await na.open("Apps/Planet Earth");
      const el = na.view().contentEl;
      na.choose(el.querySelector('select[aria-label="period"]'), "1");
      await na.sleep(300);
      await na.until(() => !el.querySelector(".gz-stale, .gz-loading"), 10000);
      await na.sleep(300);
      const first = el.querySelector(".gz-view-number");
      return { title: first.querySelector(".gz-title")?.textContent, value: first.querySelector(".gz-big")?.textContent, errors: na.errors() };`);
    expect(r.title === "Earthquakes, past day" && /^\d+$/.test(r.value ?? "") && r.errors === 0, r);
    return `${r.title}: ${r.value}`;
  }, { net: USGS });

  await check("Planet Earth: asks for its three hosts; picking a quake shows it as a card with its USGS page; Follow keeps it with a note on why", async () => {
    const want = ["Fetch data from api.open-meteo.com — for [[City]]", "Fetch data from earthquake.usgs.gov", "Fetch data from services.swpc.noaa.gov"];
    expect(JSON.stringify([...(prompts["Planet Earth"] ?? [])].sort()) === JSON.stringify(want), prompts["Planet Earth"]);
    const r = await run(`
      await na.open("Apps/Planet Earth");
      const el = na.view().contentEl;
      [...el.querySelectorAll("button.gz-tab")].find((b) => b.textContent === "Earthquakes").click();
      const panel = (title) => [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
      const row = await na.until(() => panel("The ten strongest")?.querySelector("tbody tr"), 10000);
      const [mag, place] = [...row.querySelectorAll("td")].map((td) => td.textContent);
      // Composed, the picked quake waits out of sight, in the sheet slot; picked, it shows in the sheet.
      const waiter = el.querySelector(".gz-sheet-slot > .gz-panel");
      const waiting = waiter.classList.contains("gz-collapsed") && !waiter.textContent;
      row.click();
      const card = await na.until(() => waiter.querySelector(".gz-rowcard"), 3000);
      const inSheet = !!waiter.closest(".gz-sheet.is-open .gz-sheet-panels");
      const link = card?.querySelector("a")?.getAttribute("href");
      const mark = na.notices.length;
      na.button("Follow", row).click();
      const saved = await na.until(() => na.fm("Apps/Planet Earth data.md")?.following?.at(-1), 3000);
      // Said under the panel whose row it was, with Undo, not as a notice.
      const notices = [await na.until(() => el.querySelector(".gz-notice-text")?.textContent, 3000)];
      await na.sleep(600);
      const followed = [...panel("Quakes I'm following").querySelectorAll("tbody tr")].find((tr) => tr.querySelector("td").textContent === saved?.quake);
      na.fill(followed.querySelector("input"), "Near family");
      const note = await na.until(() => na.fm("Apps/Planet Earth data.md")?.following?.find((f) => f.quake === saved.quake)?.note, 3000);
      el.querySelector(".gz-sheet.is-open .gz-sheet-close").click();
      await na.sleep(300);
      const closed = !el.querySelector(".gz-sheet.is-open") && waiter.parentElement.classList.contains("gz-sheet-slot") && waiter.classList.contains("gz-collapsed");
      return { mag, place, waiting, inSheet, closed, title: card?.querySelector(".gz-rowcard-title")?.textContent, link, saved, notices, note, errors: na.errors() };`);
    expect(r.waiting && r.inSheet && r.closed && /^\d+\.\d$/.test(r.mag) && r.title === r.place, r);
    expect(/^https:\/\/earthquake\.usgs\.gov\/earthquakes\/eventpage\/\w+$/.test(r.link ?? "") && r.saved?.page === r.link && r.saved.quake.startsWith("M ") && typeof r.saved.when === "number", r);
    expect(r.notices.includes(`Following ${r.place}`) && r.note === "Near family" && r.errors === 0, r);
    return `picked M${r.mag} ${r.place}; followed with a note`;
  }, { net: USGS });

  await check("a bar chart with select: clicking a bar dims the others and opens the list in the sheet; again clears it", async () => {
    const r = await run(`
      await na.write("Scratch/Rooms.md", ${JSON.stringify(ROOMS)});
      await na.sleep(800);
      await na.open("Scratch/Rooms");
      const el = na.view().contentEl;
      const bars = () => [...el.querySelectorAll(".gz-view-bar path.gz-bar")];
      // A bar is named by its x, then its value: "kitchen: 2".
      const room = (b) => b.getAttribute("aria-label").split(":")[0];
      const list = () => na.text(el.querySelector(".gz-view-list"));
      // Composed, the list waits for a pick out of sight.
      const hidden = () => el.querySelector(".gz-view-list").classList.contains("gz-collapsed");
      const waiting = hidden();
      bars().find((b) => room(b) === "kitchen").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await na.sleep(600);
      const opacity = bars().map((b) => room(b) + " " + getComputedStyle(b).opacity);
      const picked = list();
      const shown = !hidden();
      const sheet = el.querySelector(".gz-sheet.is-open");
      const opened = { inSheet: !!el.querySelector(".gz-sheet.is-open .gz-sheet-panels > .gz-view-list"), kicker: sheet?.querySelector(".gz-sheet-kicker")?.textContent, title: sheet?.querySelector(".gz-sheet-title")?.textContent, line: sheet?.querySelector(".gz-sheet-line")?.textContent };
      bars().find((b) => b.classList.contains("gz-selected")).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await na.sleep(600);
      return { waiting, opacity, picked, shown, opened, closed: !el.querySelector(".gz-sheet.is-open"), cleared: hidden(), after: bars().map((b) => getComputedStyle(b).opacity) };`);
    expect(r.waiting && r.shown, r);
    expect(r.opened.inSheet && r.opened.kicker === "Chores per room" && r.opened.title === "kitchen" && r.opened.line === "2 entries" && r.closed, r);
    expect(r.opacity.filter((o) => o === "kitchen 1").length === 1 && r.opacity.filter((o) => o.endsWith(" 0.35")).length === 2 && r.picked.includes("Wipe the counters") && r.picked.includes("Mop") && !r.picked.includes("Weed"), r);
    expect(r.cleared && r.after.every((o) => o === "1"), r);
    return `opacity ${r.opacity.join(",")}; list: ${r.picked}`;
  });

  await check("Library: a shelf row, with neither select nor detail, opens in the sheet with its fields; Escape closes it and the focus goes back to the row", async () => {
    const r = await run(`
      await na.open("Apps/Library");
      const el = na.view().contentEl;
      const row = await na.until(() => [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.startsWith("Dune")), 3000);
      row.querySelectorAll("td")[1].click();
      const sheet = await na.until(() => el.querySelector(".gz-sheet.is-open"), 3000);
      await na.sleep(300);
      const fields = [...sheet.querySelectorAll(".gz-sheet-field")].map((f) => [f.querySelector(".gz-sheet-label").textContent, f.querySelector("select")?.selectedOptions[0]?.textContent ?? f.querySelector("input")?.value ?? f.querySelector(".gz-sheet-value").textContent]);
      const box = sheet.getBoundingClientRect(), view = el.getBoundingClientRect(), leaf = na.view().containerEl.getBoundingClientRect();
      // The app scrolls under the sheet; the sheet stays where it is.
      el.scrollTop = 200;
      await na.sleep(100);
      const scrolled = sheet.getBoundingClientRect().top;
      el.scrollTop = 0;
      return {
        kicker: sheet.querySelector(".gz-sheet-kicker").textContent, title: sheet.querySelector(".gz-sheet-title").textContent, fields,
        actions: [...sheet.querySelectorAll(".gz-sheet-actions > *")].map((a) => a.textContent), selected: row.classList.contains("gz-selected"), status: na.fm("Books/Dune.md")?.status,
        focused: document.activeElement === sheet, top: Math.round(box.top - view.top), right: Math.round(leaf.right - box.right), width: Math.round(box.width), bottom: Math.round(leaf.bottom - box.bottom), scrolled: Math.round(scrolled - box.top),
      };`);
    await press("Escape");
    const after = await run(`
      await na.sleep(400);
      const el = na.view().contentEl;
      const row = [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.startsWith("Dune"));
      return { open: !!el.querySelector(".gz-sheet.is-open"), focused: document.activeElement === row, selected: row.classList.contains("gz-selected") };`);
    expect(r.kicker === "My shelf" && r.title === "Dune" && r.selected && r.focused, r);
    expect(JSON.stringify(r.fields.map(([label]) => label)) === '["Book","Author","Status","Finished"]' && r.fields[0][1] === "Dune" && r.fields[2][1] === r.status, r);
    expect(JSON.stringify(r.actions) === '["Open"]', r.actions);
    // Flush right under the tab's header, as tall as the tab's content, and still while the app scrolls.
    expect(r.top === 0 && r.right === 0 && r.bottom === 0 && r.width === 380 && r.scrolled === 0, r);
    expect(!after.open && after.focused && !after.selected, after);
    return `${r.title}: ${r.fields.map(([k, v]) => `${k} ${v}`).join(", ")}; Escape closed it`;
  });
}
