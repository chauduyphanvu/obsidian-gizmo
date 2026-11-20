// Views: board, timeline, calendar (month and year), keyboard on days.

const JOURNAL = (month) => `---
app: Mark the days I journaled and read back what I wrote
data:
  entries:
    source: journal
panels:
  - view: calendar
    title: Journal days
    source: entries
    group: at
    select: day
  - view: list
    title: That day
    source: entries
    where: {at: $day.at}
    item: "{text}"
journal:
  - {at: ${month}-02T08:00, text: Started a new notebook}
  - {at: ${month}-09T21:00, text: Long walk by the river}
  - {at: ${month}-09T22:00, text: Called my sister}
---
`;

/** In the page: a column's cards on the Projects board, by its name. */
const COLUMN = `(name) => [...na.view().contentEl.querySelectorAll('.gz-board-col[aria-label="' + name + '"] .gz-board-card')].map((c) => c.querySelector(".gz-board-text").textContent)`;

export default async function views(t) {
  const { check, run, expect, press } = t;

  await check("Projects: Move to… sets the note's status; the card shows under the new column with focus kept", async () => {
    const r = await run(`
      await na.open("Apps/Projects");
      const el = na.view().contentEl;
      const column = ${COLUMN};
      const card = [...el.querySelectorAll(".gz-board-card")].find((c) => c.textContent.includes("Japan trip"));
      const select = card.querySelector("select.gz-move");
      select.focus();
      na.choose(select, "doing");
      const written = await na.until(() => na.fm("Projects/Japan trip.md")?.status === "doing", 3000);
      await na.until(() => column("doing").some((c) => c.startsWith("Japan trip")), 3000);
      await na.sleep(300);
      const active = document.activeElement;
      return { written: !!written, idea: column("idea"), doing: column("doing"), focus: active?.className, focusCard: active?.closest(".gz-board-card")?.textContent.slice(0, 20) };`);
    expect(r.written && r.doing.some((c) => c.startsWith("Japan trip")) && !r.idea.some((c) => c.startsWith("Japan trip")), r);
    expect(/gz-move/.test(r.focus ?? "") && r.focusCard?.startsWith("Japan trip"), { note: "focus should stay on the moved card's Move to… menu", ...r });
    return `doing: ${r.doing.join(", ")}; focus on its menu`;
  });

  await check("Projects: a real mouse drag moves a card from idea to doing", async () => {
    const pos = await run(`
      await na.open("Apps/Projects");
      const el = na.view().contentEl;
      const card = [...el.querySelectorAll(".gz-board-card")].find((c) => c.textContent.includes("Learn Rust"));
      const col = el.querySelector('.gz-board-col[aria-label="doing"]');
      card.scrollIntoView({ block: "center" });
      await na.sleep(200);
      const a = card.querySelector(".gz-board-text").getBoundingClientRect(), b = col.getBoundingClientRect();
      return { from: [a.x + 6, a.y + a.height / 2], to: [b.x + b.width / 2, b.y + b.height - 12] };`);
    const dragged = await t.drag(pos.from, pos.to);
    const r = await run(`
      const column = ${COLUMN};
      await na.until(() => na.fm("Projects/Learn Rust.md")?.status === "doing", 3000);
      await na.until(() => column("doing").some((c) => c.startsWith("Learn Rust")), 3000);
      const out = { status: na.fm("Projects/Learn Rust.md")?.status, doing: column("doing") };
      await app.fileManager.processFrontMatter(na.file("Projects/Learn Rust.md"), (fm) => { fm.status = "idea"; });
      return out;`);
    expect(dragged && r.status === "doing" && r.doing.some((c) => c.startsWith("Learn Rust")), { dragged, ...r });
    return `doing: ${r.doing.join(", ")}`;
  });

  await check("Projects: a timeline bar picks the project; picking it again clears it", async () => {
    const r = await run(`
      await na.open("Apps/Projects");
      const el = na.view().contentEl;
      const schedule = [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === "Schedule");
      const picked = () => schedule.querySelector(".gz-detail") ? na.text(schedule.querySelector(".gz-detail")) : "";
      const before = picked();
      const bar = () => [...el.querySelectorAll(".gz-tl-bar")].find((b) => (b.getAttribute("aria-label") ?? b.closest(".gz-tl-row").textContent).includes("Kitchen remodel"));
      bar().click();
      await na.sleep(500);
      const after = picked();
      bar().click();
      await na.sleep(500);
      return { before, after, cleared: picked() };`);
    // The project's due date shows under the schedule, with a link to its note.
    expect(r.before === "" && r.after.includes("Kitchen remodel is due 2026-12-15") && r.after.includes("Open") && r.cleared === "", r);
    return r.after;
  });

  await check("Projects: the calendar's ‹ › change month, and it stays on that month after a card moves", async () => {
    const r = await run(`
      await na.open("Apps/Projects");
      const el = na.view().contentEl;
      const cal = el.querySelector(".gz-view-calendar");
      const title = () => cal.querySelector(".gz-cal-title").textContent;
      const first = title();
      cal.querySelector(".gz-cal-next").click();
      await na.sleep(200);
      const next = title();
      cal.querySelector(".gz-cal-prev").click();
      cal.querySelector(".gz-cal-prev").click();
      await na.sleep(200);
      const prev = title();
      cal.querySelector(".gz-cal-next").click();
      cal.querySelector(".gz-cal-next").click();
      await na.sleep(200);
      const shown = title();
      const card = [...el.querySelectorAll(".gz-board-card")].find((c) => c.textContent.includes("Japan trip"));
      na.choose(card.querySelector("select.gz-move"), "idea");
      await na.until(() => na.fm("Projects/Japan trip.md")?.status === "idea", 3000);
      await na.sleep(800);
      return { first, next, prev, shown, after: title(), dueDays: [...cal.querySelectorAll(".gz-cal-day .gz-cal-val")].length };`);
    expect(r.first !== r.next && r.prev !== r.first && r.shown === r.next && r.after === r.next, r);
    return `${r.first} → ${r.next} → ${r.prev} → ${r.shown}; after a move still ${r.after}`;
  });

  await check("Habits, Year tab: Stretched raises the streak and shades today's square, labelled with today's count; the year fits the panel", async () => {
    const r = await run(`
      const today = new Date();
      const key = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
      // The apps checks stretched today already; that stretch is taken back so today starts empty.
      await app.fileManager.processFrontMatter(na.file("Apps/Habits data.md"), (fm) => { fm.stretches = fm.stretches.filter((s) => !String(s.at).startsWith(key)); });
      await na.open("Apps/Habits");
      const el = na.view().contentEl;
      // Once the app has written its data note, an edit by hand counts when it's imported.
      const card = await na.until(() => el.querySelector(".gz-hand-edit"), 1500);
      if (card) {
        na.button("Import the edit", card).click();
        await na.until(() => !el.querySelector(".gz-hand-edit"), 3000);
      }
      [...el.querySelectorAll("button.gz-tab")].find((b) => b.textContent === "Year").click();
      await na.sleep(400);
      const day = () => el.querySelector('.gz-cal-year [data-date="' + key + '"]');
      const label = () => day().getAttribute("aria-label");
      const streak = () => el.querySelector(".gz-view-number .gz-big").textContent;
      const before = { streak: streak(), label: label(), cls: day().getAttribute("class") };
      na.button("Stretched").click();
      await na.until(() => label() !== before.label, 3000);
      await na.sleep(300);
      const svg = el.querySelector(".gz-cal-year");
      const panel = el.querySelector(".gz-view-calendar");
      return { key, before, streak: streak(), label: label(), cls: day().getAttribute("class"), svg: svg.getBoundingClientRect().width, panel: panel.clientWidth, scroll: el.querySelector(".gz-cal-scroll").scrollWidth - el.querySelector(".gz-cal-scroll").clientWidth };`);
    expect(r.before.label === `${r.key}: 0` && !/gz-step/.test(r.before.cls), r.before);
    expect(Number.parseInt(r.streak) > Number.parseInt(r.before.streak) && r.label === `${r.key}: 1` && /gz-step-\d/.test(r.cls) && /gz-today/.test(r.cls), { before: r.before, after: r.streak, label: r.label, cls: r.cls });
    expect(r.svg <= r.panel && r.scroll <= 0, r);
    return `streak ${r.before.streak} → ${r.streak}; ${r.label}; ${r.cls}; ${Math.round(r.svg)} px in a ${r.panel} px panel`;
  });

  await check("calendar keys: Tab reaches the first day, arrows move by day and week, Enter picks the day", async () => {
    const month = await run(`const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");`);
    await run(`
      await na.write("Scratch/Journal.md", ${JSON.stringify(JOURNAL("__MONTH__"))}.replaceAll("__MONTH__", ${JSON.stringify(month)}));
      await na.sleep(800);
      await na.open("Scratch/Journal");
      na.view().contentEl.querySelector(".gz-cal-today").focus();`);
    const at = () => run(`return document.activeElement?.getAttribute("data-date");`);
    await press("Tab");
    const first = await at();
    await press("ArrowRight");
    const right = await at();
    await press("ArrowDown");
    const down = await at();
    await press("ArrowUp");
    await press("ArrowDown");
    await press("Enter");
    const r = await run(`
      await na.sleep(500);
      const el = na.view().contentEl;
      const list = [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === "That day");
      return { list: na.text(list), selected: el.querySelector(".gz-cal-day.gz-selected")?.getAttribute("data-date"), focus: document.activeElement?.getAttribute("data-date") };`);
    expect(first === `${month}-01` && right === `${month}-02` && down === `${month}-09`, { first, right, down });
    expect(r.selected === `${month}-09` && r.focus === `${month}-09` && r.list.includes("Long walk by the river") && r.list.includes("Called my sister") && !r.list.includes("notebook"), r);
    return `Tab → ${first}, → ${right}, ↓ ${down}, Enter picks it: ${r.list}`;
  });
}
