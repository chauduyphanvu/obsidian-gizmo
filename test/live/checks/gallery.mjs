// The gallery, copied over a copy of test/vault: every note opens, and each app's main use works.

const APPS = ["Aurora watch", "Book finder", "Budget", "Decision journal", "Medication log", "Project board", "Read later", "Sleep", "Task inbox", "Trip planner", "Watchlist", "Weight"];
const COMPONENTS = ["Decision review", "Destination weather", "Reading progress", "Tracker kit"];
const NOAA = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const NET = {
  "Aurora watch": [NOAA, "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"],
  "Read later": ["https://feeds.bbci.co.uk/news/technology/rss.xml", "https://feeds.npr.org/1001/rss.xml"],
  "Trip planner": ["https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY", "https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69&current=temperature_2m",
    "https://archive-api.open-meteo.com/v1/archive?latitude=35.68&longitude=139.69&start_date=2025-01-01&end_date=2025-01-02&daily=temperature_2m_max"],
  Watchlist: ["https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=5d&interval=1d"],
  "Book finder": ["https://openlibrary.org/search.json?q=ursula&limit=10"],
};

/** In the page: a panel of the open app by its title. */
const PANEL = `(title) => [...na.view().contentEl.querySelectorAll(".na-panel")].find((p) => p.querySelector(".na-title")?.textContent === title)`;

export default async function gallery(t) {
  const { check, run, expect, type, press } = t;
  await run(`[...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins")?.click(); await na.sleep(300);`);

  await check("Medication log, never opened: its command says to open it once", async () => {
    const r = await run(`
      const mark = na.notices.length;
      app.commands.executeCommandById("note-apps:Apps/Medication log.md:took-meds");
      return { notices: await na.noticesSince(mark, "Open"), data: na.exists("Apps/Medication log data.md") };`);
    expect(r.notices.includes("Open Medication log once to allow it") && !r.data, r);
    return r.notices.join(" | ");
  });

  for (const name of [...APPS, ...COMPONENTS]) {
    const folder = APPS.includes(name) ? "Apps" : "Components";
    await check(`opens ${name} with no problems`, async () => {
      const r = await run(`
        const { prompt } = await na.open("${folder}/${name}");
        await na.until(() => !na.view().contentEl.querySelector(".na-loading"), 8000);
        return { prompt, state: na.state(), errors: na.errors(), text: na.text() };`);
      expect(r.state === `note-app:${folder}/${name}.md` && r.errors === 0 && !r.text.includes("keys have problems"), r);
      if (folder === "Components") expect(r.text.includes("A component. Use it in an app's panels:"), r.text);
      return `${r.prompt ? `asked ${r.prompt.length}; ` : ""}${r.text.slice(0, 70)}`;
    }, { net: NET[name] });
  }

  await check("Today: the water counter counts, and the Medication log block logs a dose", async () => {
    const r = await run(`
      await na.openMd("Today.md", "preview");
      await na.sleep(800);
      const [meds, water] = na.embeds();
      const doses = () => na.fm("Apps/Medication log data.md")?.doses?.length ?? 0;
      const glasses = () => na.fm("Today data.md")?.water?.length ?? 0;
      const before = { doses: doses(), glasses: glasses(), water: na.text(water) };
      na.button("Drank a glass of water", water).click();
      await na.until(() => glasses() === before.glasses + 1, 3000);
      na.button("Took meds", meds).click();
      await na.until(() => doses() === before.doses + 1, 3000);
      await na.sleep(600);
      const [m2, w2] = na.embeds();
      return { before, doses: doses(), glasses: glasses(), water: na.text(w2), meds: na.text(m2) };`);
    expect(r.glasses === r.before.glasses + 1 && r.water.includes(`${r.glasses}/ 8 glasses`), r);
    expect(r.doses === r.before.doses + 1 && r.meds.includes(`Doses today | ${r.doses}`), r);
    return `${r.water}; ${r.meds}`;
  });

  await check("Medication log, once opened: its command logs a dose with the app closed and the status bar follows", async () => {
    const r = await run(`
      await na.open("Apps/Medication log");
      await na.openMd("Daily.md", "preview");
      const doses = () => na.fm("Apps/Medication log data.md")?.doses?.length ?? 0;
      const status = () => na.status().find((s) => s.startsWith("Doses today"));
      const before = { doses: doses(), status: await na.until(status, 5000) };
      const mark = na.notices.length;
      app.commands.executeCommandById("note-apps:Apps/Medication log.md:took-meds");
      const notices = await na.noticesSince(mark, "Dose logged");
      await na.until(() => doses() === before.doses + 1, 3000);
      const after = await na.until(() => status() !== before.status && status(), 3000);
      return { before, notices, doses: doses(), after, state: na.state() };`);
    expect(r.doses === r.before.doses + 1 && r.notices.includes("Dose logged") && r.after === `Doses today: ${Number(r.before.status?.split(": ")[1]) + 1}` && r.state === "markdown:Daily.md", r);
    return `${r.before.status} → ${r.after}`;
  });

  await check("Project board: Move to… moves a card; picking it shows its dates under the board and Open opens its note", async () => {
    const r = await run(`
      await na.open("Apps/Project board");
      const el = na.view().contentEl;
      const board = ${PANEL}("Projects");
      const card = () => [...el.querySelectorAll(".na-board-card")].find((c) => c.textContent.includes("Tax return"));
      const from = card().closest(".na-board-col").getAttribute("aria-label");
      const to = from === "doing" ? "done" : "doing";
      na.choose(card().querySelector("select.na-move"), to);
      await na.until(() => na.fm("Projects/Tax return.md")?.status === to, 3000);
      await na.until(() => card()?.closest(".na-board-col")?.getAttribute("aria-label") === to, 3000);
      // Tax return now shares its column with another project: the detail must be its own.
      const neighbours = card().closest(".na-board-col").querySelectorAll(".na-board-card").length;
      card().scrollIntoView({ block: "center" });
      await na.sleep(300);
      const line = card().querySelector(".na-board-text").getBoundingClientRect();
      const title = card().querySelector(".na-board-text a").getBoundingClientRect();
      return { from, to, status: na.fm("Projects/Tax return.md")?.status, neighbours, at: [Math.min(title.right + 8, line.right - 2), line.top + line.height / 2], waiting: !board.querySelector(".na-detail") };`);
    expect(r.status === r.to && r.waiting, r);
    // A real click on the card, beside its title (the title itself is a link to the note).
    await t.click(r.at);
    const after = await run(`
      const board = ${PANEL}("Projects");
      const detail = await na.until(() => board.querySelector(".na-detail"), 3000);
      const picked = detail?.querySelector(".na-detail-text")?.textContent;
      const link = detail?.querySelector("a");
      const label = link?.textContent;
      link?.click();
      await na.sleep(1000);
      return { picked, label, state: na.state() };`);
    expect(after.picked?.startsWith(`Tax return is ${r.to}, due `) && after.label === "Open" && after.state === "markdown:Projects/Tax return.md", { ...r, ...after });
    return `${r.from} → ${r.to} (${r.neighbours} in that column); ${after.picked}; opened ${after.state}`;
  });

  await check("Decision journal: a decision typed and written down with real keys and clicks is due today; scoring it moves the count and the share, and its lens reads it back", async () => {
    const DECISION = "Plant garlic before the frost";
    const at = (selector, root) => `(() => { const el = ${root}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return [r.x + Math.min(12, r.width / 2), r.y + r.height / 2]; })()`;
    const before = await run(`
      await na.open("Apps/Decision journal");
      const panel = ${PANEL};
      const number = (title) => panel(title).querySelector(".na-big").textContent;
      const form = panel("A decision I'm making");
      const name = ${at('input[type="text"]', "form")};
      await na.sleep(200);
      return { ready: Number(number("Ready to score")), right: number("Right so far"), name, captions: [...form.querySelectorAll(".na-field > span")].map((s) => s.textContent) };`);
    expect(JSON.stringify(before.captions) === JSON.stringify(["Decision", "I expected", "% sure", "Due"]), before);
    await t.click(before.name);
    await type(DECISION);
    await press("Tab");
    await type("Most of the cloves come up in spring");
    const write = await run(`const form = (${PANEL})("A decision I'm making"); const b = [...form.querySelectorAll("button")].find((x) => x.textContent === "Write it down"); b.scrollIntoView({ block: "center" }); await na.sleep(200); const r = b.getBoundingClientRect(); return { at: [r.x + r.width / 2, r.y + r.height / 2], mark: na.notices.length };`);
    await t.click(write.at);
    const written = await run(`
      const panel = ${PANEL};
      const path = "Decisions/${DECISION}.md";
      const fm = await na.until(() => na.fm(path), 5000);
      const ready = await na.until(() => Number(panel("Ready to score").querySelector(".na-big").textContent) === ${before.ready} + 1, 3000);
      const notices = await na.noticesSince(${write.mark}, "Written down");
      const tab = [...na.view().contentEl.querySelectorAll("button.na-tab")].find((b) => b.textContent === "Score");
      tab.scrollIntoView({ block: "center" });
      await na.sleep(200);
      const r = tab.getBoundingClientRect();
      return { fm, ready: !!ready, notices, tab: [r.x + r.width / 2, r.y + r.height / 2] };`);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(written.fm?.expect === "Most of the cloves come up in spring" && written.fm.confidence === 60 && written.fm.outcome === "open" && written.fm.made === today && written.fm.review === today && written.ready, written);
    expect(written.notices.includes(`Written down. Come back on ${today} to score it.`), written.notices);
    await t.click(written.tab);
    const scored = await run(`
      const panel = ${PANEL};
      const row = await na.until(() => [...panel("How did these turn out?").querySelectorAll("tbody tr")].find((tr) => tr.textContent.startsWith("${DECISION}")), 3000);
      na.choose(row.querySelector("select"), "right");
      const fm = await na.until(() => na.fm("Decisions/${DECISION}.md")?.outcome === "right" && na.fm("Decisions/${DECISION}.md"), 3000);
      await na.until(() => Number(panel("Ready to score").querySelector(".na-big").textContent) === ${before.ready}, 3000);
      await na.sleep(300);
      const gone = ![...panel("How did these turn out?").querySelectorAll("tbody tr")].some((tr) => tr.textContent.startsWith("${DECISION}"));
      return { fm, ready: Number(panel("Ready to score").querySelector(".na-big").textContent), right: panel("Right so far").querySelector(".na-big").textContent, gone };`);
    expect(scored.fm?.outcome === "right" && scored.ready === before.ready && scored.gone && /^\d+%$/.test(scored.right) && scored.right !== before.right, { before, scored });
    const lens = await run(`
      await app.workspace.openLinkText("Decisions/${DECISION}", "", false);
      await na.sleep(1200);
      const el = na.view().contentEl.querySelector(".na-lens");
      const out = { state: na.state(), name: el?.querySelector(".na-lens-name")?.textContent, text: el && na.text(el) };
      await na.remove("Decisions/${DECISION}.md");
      return out;`);
    expect(lens.state === `markdown:Decisions/${DECISION}.md` && lens.name === "Decision review" && lens.text?.includes("I expected: Most of the cloves come up in spring (60% sure). It went right."), lens);
    return `written (due ${today}); scored right: ready ${before.ready + 1} → ${scored.ready}, right so far ${before.right} → ${scored.right}; lens: ${lens.text.slice(0, 70)}`;
  });

  await check("Task inbox: a task added through the form shows in Open; ticking it ticks its line", async () => {
    await run(`await na.open("Apps/Task inbox"); na.view().contentEl.querySelector('.na-form input[type="text"]').focus();`);
    await type("Call the plumber");
    await press("Enter");
    const r = await run(`
      const el = na.view().contentEl;
      const row = () => [...el.querySelectorAll(".na-view-table tbody tr")].find((tr) => tr.textContent.includes("Call the plumber"));
      await na.until(row, 3000);
      const added = await na.read("Tasks/Inbox.md");
      row().querySelector('input[type="checkbox"]').click();
      await na.until(async () => (await na.read("Tasks/Inbox.md")).includes("- [x] Call the plumber"), 3000);
      await na.until(() => !row(), 3000);
      const done = na.text((${PANEL})("Done"));
      return { added, after: await na.read("Tasks/Inbox.md"), done };`);
    expect(r.added.includes("- [ ] Call the plumber") && r.after.includes("- [x] Call the plumber") && r.done.includes("Call the plumber · Inbox"), r);
    return JSON.stringify(r.after.trim());
  });

  await check("Sleep: the Tracker kit's form logs a night into Sleep data, and the latest and the table follow", async () => {
    await run(`
      await na.open("Apps/Sleep");
      const form = (${PANEL})("Log my sleep");
      form.querySelector('input[type="number"]').focus();`);
    await type("7.5");
    await press("Enter");
    const r = await run(`
      const saved = await na.until(() => na.fm("Apps/Sleep data.md")?.sleep?.at(-1), 3000);
      const latest = await na.until(() => (${PANEL})("Latest").querySelector(".na-big")?.textContent === "7.5hours" && "7.5hours", 3000);
      const row = (${PANEL})("Entries").querySelector("tbody tr");
      return { saved, latest, row: row && [...row.querySelectorAll("td")].map((td) => td.querySelector("input")?.value ?? td.textContent), goal: (${PANEL})("My sleep against my goal").querySelector(".na-goal-label")?.textContent, errors: na.errors() };`);
    expect(r.saved?.value === 7.5 && typeof r.saved.at === "string" && r.latest === "7.5hours" && r.row?.[1] === "7.5" && r.goal === "goal 8 hours" && r.errors === 0, r);
    return `saved ${JSON.stringify(r.saved)}; latest ${r.latest}; ${r.goal}`;
  });

  await check("Trip planner: days to go, itinerary rows, and the dollars follow its rate property", async () => {
    const r = await run(`
      await na.open("Apps/Trip planner");
      const el = na.view().contentEl;
      const panel = ${PANEL};
      const tab = (name) => [...el.querySelectorAll("button.na-tab")].find((b) => b.textContent === name).click();
      const days = panel("Days to go").querySelector(".na-big").textContent;
      tab("Itinerary");
      await na.sleep(300);
      const itinerary = [...panel("Itinerary").querySelectorAll("tbody tr")].map((tr) => tr.textContent);
      tab("Spending");
      await na.sleep(300);
      const form = panel("Spent abroad");
      na.fill(form.querySelector('input[type="text"]'), "Ramen");
      na.fill(form.querySelector('input[type="number"]'), "1500");
      na.button("Add", form).click();
      const spent = () => panel("Spent so far").querySelector(".na-big").textContent;
      const at150 = await na.until(() => spent() === "$10.00" && spent(), 3000);
      const file = na.file("Apps/Trip planner.md");
      const original = await app.vault.read(file);
      await app.vault.modify(file, original.replace("rate: 150", "rate: 100"));
      const at100 = await na.until(() => spent() === "$15.00" && spent(), 3000);
      await app.vault.modify(file, original);
      return { days, itinerary, at150, at100, back: await na.until(() => spent() === "$10.00" && spent(), 3000) };`);
    expect(/^\d+ days$/.test(r.days) && r.itinerary.length >= 3, r);
    expect(r.at150 === "$10.00" && r.at100 === "$15.00" && r.back === "$10.00", r);
    return `${r.days} to go; ${r.itinerary.length} itinerary rows; ¥1500 is ${r.at150} at 150, ${r.at100} at 100`;
  }, { net: NET["Trip planner"] });

  await check("Book finder: Add saves a book note, and the Reading progress lens shows on it", async () => {
    await run(`await na.open("Apps/Book finder"); na.view().contentEl.querySelector('input[aria-label="q"]').focus();`);
    await type("ursula le guin");
    await press("Enter");
    const searched = await run(`
      const el = na.view().contentEl;
      const results = await na.until(() => el.querySelectorAll(".na-view-list li").length > 2 && !el.querySelector(".na-stale, .na-loading"), 30000);
      return { results: !!results, pending: !!el.querySelector(".na-stale, .na-loading") };`);
    // Still waiting for its answer says nothing about the plugin; an answer that is wrong does.
    if (!searched.results && searched.pending) t.skip("Open Library hasn't answered in 30 s");
    const r = await run(`
      const el = na.view().contentEl;
      const item = [...el.querySelectorAll(".na-view-list li")].find((li) => {
        const title = li.textContent.split(" · ")[0];
        return !/[\\\\/:*?"<>|#^\\[\\]]/.test(title) && !na.exists("Books/" + title + ".md");
      });
      const title = item.textContent.split(" · ")[0];
      na.button("Add", item).click();
      const fm = await na.until(() => na.fm("Books/" + title + ".md"), 5000);
      await app.workspace.openLinkText("Books/" + title, "", false);
      await na.sleep(1200);
      const lens = na.view().contentEl.querySelector(".na-lens");
      return { title, fm, state: na.state(), name: lens?.querySelector(".na-lens-name")?.textContent, lens: lens && na.text(lens) };`);
    expect(r.fm && r.fm.status === "to read" && typeof r.fm.year === "number" && r.state === `markdown:Books/${r.title}.md`, r);
    expect(r.name === "Reading progress" && r.lens.includes("Change properties of notes in Books"), r);
    return `Books/${r.title}.md; lens: ${r.lens.slice(0, 80)}`;
  }, { net: NET["Book finder"] });

  // Screenshots of every gallery app, light and dark at desktop width, and at phone width.
  for (const theme of ["light", "dark"]) {
    await t.theme(theme);
    for (const name of APPS) {
      await run(`await na.open("Apps/${name}"); await na.until(() => !na.view().contentEl.querySelector(".na-loading"), 6000); await na.sleep(600);`);
      await t.shot(`gallery-${name.replace(/ /g, "-")}-${theme}.png`, 1280, 900);
    }
  }
  await run(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();`);
  for (const name of APPS) {
    await run(`await na.open("Apps/${name}"); await na.until(() => !na.view().contentEl.querySelector(".na-loading"), 6000); await na.sleep(600);`);
    await t.shot(`gallery-${name.replace(/ /g, "-")}-phone.png`, 390, 844, 2);
  }
  await run(`await na.openMd("Today.md", "live"); await na.sleep(800);`);
  await t.shot("gallery-Today-phone.png", 390, 844, 2);
  await t.theme("light");
  await run(`await na.openMd("Today.md", "live"); await na.sleep(800);`);
  await t.shot("gallery-Today-light.png", 1280, 900);
}
