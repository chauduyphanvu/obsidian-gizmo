// The gallery, copied over a copy of test/vault: every note opens, and each app's main use works.

const APPS = ["Aurora watch", "Bills and renewals", "Book finder", "Budget", "Decision journal", "Household chores", "Medication log", "Practice", "Project board", "Read later", "Task inbox", "Trip planner", "Vitals", "Trades"];
const COMPONENTS = ["Decision review", "Destination weather", "Reading progress", "Tracker kit"];
const KINDS = ["Chore", "Dose", "Measurement", "Renewal", "Spend", "Trade"];
const NOAA = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const NET = {
  "Aurora watch": [NOAA, "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"],
  "Read later": ["https://feeds.bbci.co.uk/news/technology/rss.xml", "https://feeds.npr.org/1001/rss.xml"],
  "Trip planner": ["https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY", "https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69&current=temperature_2m",
    "https://archive-api.open-meteo.com/v1/archive?latitude=35.68&longitude=139.69&start_date=2025-01-01&end_date=2025-01-02&daily=temperature_2m_max"],
  Trades: ["https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=5d&interval=1d"],
  "Book finder": ["https://openlibrary.org/search.json?q=ursula&limit=10"],
};

/** In the page: a panel of the open app by its title. */
const PANEL = `(title) => [...na.view().contentEl.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title)`;

export default async function gallery(t) {
  const { check, run, expect, type, press } = t;
  await run(`[...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins")?.click(); await na.sleep(300);`);

  await check("Medication log, never opened: its command says to open it once", async () => {
    const r = await run(`
      const mark = na.notices.length;
      const doses = () => na.fm("Kinds/Dose data.md")?.dose?.length ?? 0;
      const before = doses();
      app.commands.executeCommandById("gizmo:Apps/Medication log.md:took-meds");
      const notices = await na.noticesSince(mark, "Open");
      await na.sleep(800);
      return { notices, before, after: doses() };`);
    expect(r.notices.includes("Open Medication log once to allow it") && r.after === r.before, r);
    return r.notices.join(" | ");
  });

  for (const name of [...APPS, ...COMPONENTS, ...KINDS]) {
    const folder = APPS.includes(name) ? "Apps" : KINDS.includes(name) ? "Kinds" : "Components";
    await check(`opens ${name} with no problems`, async () => {
      const r = await run(`
        const { prompt } = await na.open("${folder}/${name}");
        await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 8000);
        return { prompt, state: na.state(), errors: na.errors(), text: na.text() };`);
      expect(r.state === `gizmo:${folder}/${name}.md` && r.errors === 0 && !r.text.includes("keys have problems"), r);
      if (folder === "Components") expect(r.text.includes("A component. Use it in an app's panels:"), r.text);
      return `${r.prompt ? `asked ${r.prompt.length}; ` : ""}${r.text.slice(0, 70)}`;
    }, { net: NET[name] });
  }

  await check("Today: the water counter counts, and the Medication log block logs a dose", async () => {
    const r = await run(`
      await na.openMd("Today.md", "preview");
      await na.sleep(800);
      const [meds, water] = na.embeds();
      // The kind holds weeks of sample doses; the block counts today's.
      const d = new Date();
      const ymd = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const doses = () => (na.fm("Kinds/Dose data.md")?.dose ?? []).filter((x) => String(x.at).startsWith(ymd) && x.refill == null).length;
      const glasses = () => na.fm("Today data.md")?.water?.length ?? 0;
      const before = { doses: doses(), glasses: glasses(), water: na.text(water) };
      na.button("Drank a glass of water", water).click();
      await na.until(() => glasses() === before.glasses + 1, 3000);
      na.button("Took Medication A", meds).click();
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
      const doses = () => na.fm("Kinds/Dose data.md")?.dose?.length ?? 0;
      const status = () => na.status().find((s) => s.startsWith("Doses today"));
      const before = { doses: doses(), status: await na.until(status, 5000) };
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:Apps/Medication log.md:took-meds");
      const notices = await na.noticesSince(mark, "Logged Medication A");
      await na.until(() => doses() === before.doses + 1, 3000);
      const after = await na.until(() => status() !== before.status && status(), 3000);
      return { before, notices, doses: doses(), after, state: na.state() };`);
    expect(r.doses === r.before.doses + 1 && r.notices.includes("Logged Medication A") && r.after === `Doses today: ${Number(r.before.status?.split(": ")[1]) + 1}` && r.state === "markdown:Daily.md", r);
    return `${r.before.status} → ${r.after}`;
  });

  await check("Project board: Move to… moves a card; picking it shows its dates in the sheet and Open opens its note", async () => {
    const r = await run(`
      await na.open("Apps/Project board");
      const el = na.view().contentEl;
      const board = (${PANEL})("Projects");
      const card = () => [...el.querySelectorAll(".gz-board-card")].find((c) => c.textContent.includes("Tax return"));
      const from = card().closest(".gz-board-col").getAttribute("aria-label");
      const to = from === "doing" ? "done" : "doing";
      na.choose(card().querySelector("select.gz-move"), to);
      await na.until(() => na.fm("Projects/Tax return.md")?.status === to, 3000);
      await na.until(() => card()?.closest(".gz-board-col")?.getAttribute("aria-label") === to, 3000);
      // Tax return now shares its column with another project: the detail must be its own.
      const neighbours = card().closest(".gz-board-col").querySelectorAll(".gz-board-card").length;
      card().scrollIntoView({ block: "center" });
      await na.sleep(300);
      const line = card().querySelector(".gz-board-text").getBoundingClientRect();
      const title = card().querySelector(".gz-board-text a").getBoundingClientRect();
      return { from, to, status: na.fm("Projects/Tax return.md")?.status, neighbours, at: [Math.min(title.right + 8, line.right - 2), line.top + line.height / 2], waiting: !board.querySelector(".gz-detail") && !el.querySelector(".gz-sheet.is-open") };`);
    expect(r.status === r.to && r.waiting, r);
    // A real click on the card, beside its title (the title itself is a link to the note).
    await t.click(r.at);
    const after = await run(`
      const sheet = await na.until(() => na.view().contentEl.querySelector(".gz-sheet.is-open"), 3000);
      const picked = sheet?.querySelector(".gz-sheet-line")?.textContent;
      const inline = !!(${PANEL})("Projects").querySelector(".gz-detail");
      const link = sheet?.querySelector(".gz-sheet-actions a");
      const label = link?.textContent;
      link?.click();
      await na.sleep(1000);
      return { picked, inline, label, state: na.state() };`);
    expect(after.picked?.startsWith(`Tax return is ${r.to}, due `) && !after.inline && after.label === "Open" && after.state === "markdown:Projects/Tax return.md", { ...r, ...after });
    return `${r.from} → ${r.to} (${r.neighbours} in that column); ${after.picked}; opened ${after.state}`;
  });

  await check("Decision journal: a decision typed and written down with real keys and clicks is due today; scoring it moves the count and the share, and its lens reads it back", async () => {
    const DECISION = "Plant garlic before the frost";
    const at = (selector, root) => `(() => { const el = ${root}.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return [r.x + Math.min(12, r.width / 2), r.y + r.height / 2]; })()`;
    const before = await run(`
      await na.open("Apps/Decision journal");
      const panel = ${PANEL};
      const number = (title) => panel(title).querySelector(".gz-big").textContent;
      const form = panel("A decision I'm making");
      const name = ${at("input.gz-addline-input", "form")};
      await na.sleep(200);
      return { ready: Number(number("Ready to score")), right: number("Right so far"), name };`);
    // Composed, the form is an add line: each quoted text fills the next text field.
    await t.click(before.name);
    await type(`"${DECISION}" "Most of the cloves come up in spring"`);
    const write = await run(`const form = (${PANEL})("A decision I'm making"); const b = form.querySelector("button.gz-addline-go"); b.scrollIntoView({ block: "center" }); await na.sleep(200); const r = b.getBoundingClientRect(); return { at: [r.x + r.width / 2, r.y + r.height / 2], mark: na.notices.length, label: b.textContent, captions: [...form.querySelectorAll(".gz-pv-label")].map((s) => s.textContent) };`);
    expect(JSON.stringify(write.captions) === JSON.stringify(["Decision", "I expected", "% sure", "Due"]) && write.label === "Write it down", write);
    await t.click(write.at);
    const written = await run(`
      const panel = ${PANEL};
      const path = "Decisions/${DECISION}.md";
      const fm = await na.until(() => na.fm(path), 5000);
      const ready = await na.until(() => Number(panel("Ready to score").querySelector(".gz-big").textContent) === ${before.ready} + 1, 3000);
      // Its notify is said under the line, in place of a notice.
      const notices = [await na.until(() => panel("A decision I'm making").querySelector(".gz-notice-text")?.textContent, 3000)];
      const tab = [...na.view().contentEl.querySelectorAll("button.gz-tab")].find((b) => b.textContent === "Score");
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
      await na.until(() => Number(panel("Ready to score").querySelector(".gz-big").textContent) === ${before.ready}, 3000);
      await na.sleep(300);
      const gone = ![...panel("How did these turn out?").querySelectorAll("tbody tr")].some((tr) => tr.textContent.startsWith("${DECISION}"));
      return { fm, ready: Number(panel("Ready to score").querySelector(".gz-big").textContent), right: panel("Right so far").querySelector(".gz-big").textContent, gone };`);
    expect(scored.fm?.outcome === "right" && scored.ready === before.ready && scored.gone && /^\d+%$/.test(scored.right) && scored.right !== before.right, { before, scored });
    // The lens asks once to change notes in Decisions; allowed, it reads the decision back.
    const lens = await run(`
      await app.workspace.openLinkText("Decisions/${DECISION}", "", false);
      await na.sleep(1200);
      const el = () => na.view().contentEl.querySelector(".gz-lens");
      const asked = na.text(el());
      na.button("Allow", el())?.click();
      const line = await na.until(() => el()?.querySelector(".gz-view-text .gz-text")?.textContent, 5000);
      const out = { state: na.state(), name: el()?.querySelector(".gz-lens-name")?.textContent, asked, text: el() && na.text(el()), line };
      await na.remove("Decisions/${DECISION}.md");
      return out;`);
    expect(lens.state === `markdown:Decisions/${DECISION}.md` && lens.name === "Decision review" && lens.asked.includes("Change properties of notes in Decisions"), lens);
    expect(lens.line === "I expected: Most of the cloves come up in spring (60% sure). It went right.", lens);
    return `written (due ${today}); scored right: ready ${before.ready + 1} → ${scored.ready}, right so far ${before.right} → ${scored.right}; lens: ${lens.line}`;
  });

  await check("Task inbox: a task added through the form shows in Open; ticking it ticks its line", async () => {
    await run(`await na.open("Apps/Task inbox"); na.view().contentEl.querySelector(".gz-addline-input").focus();`);
    await type("Call the plumber");
    await press("Enter");
    const r = await run(`
      const el = na.view().contentEl;
      const row = () => [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.includes("Call the plumber"));
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

  await check("Practice: the Tracker kit's form logs a session into Practice data, and the latest and the table follow", async () => {
    await run(`
      await na.open("Apps/Practice");
      const form = (${PANEL})("Log my practice");
      form.querySelector(".gz-addline-input").focus();`);
    await type("25");
    await press("Enter");
    const r = await run(`
      const saved = await na.until(() => na.fm("Apps/Practice data.md")?.practice?.at(-1), 3000);
      const latest = await na.until(() => (${PANEL})("Latest").querySelector(".gz-big")?.textContent === "25minutes" && "25minutes", 3000);
      const row = (${PANEL})("Entries").querySelector("tbody tr");
      return { saved, latest, row: row && [...row.querySelectorAll("td")].map((td) => td.querySelector("input")?.value ?? td.textContent), goal: (${PANEL})("My practice against my goal").querySelector(".gz-goal-label")?.textContent, errors: na.errors() };`);
    expect(r.saved?.value === 25 && typeof r.saved.at === "string" && r.latest === "25minutes" && r.row?.[1] === "25" && r.goal === "Goal 30 minutes" && r.errors === 0, r);
    return `saved ${JSON.stringify(r.saved)}; latest ${r.latest}; ${r.goal}`;
  });

  await check("Budget: / from anywhere focuses the add line; a typed line shows what it saves, Enter saves it, and ⌘Z takes it back", async () => {
    const key = (k, code, vk, modifiers = 0) => t.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(modifiers ? {} : { text: k }) })
      .then(() => t.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }));
    const before = await run(`
      await na.open("Apps/Budget");
      await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 5000);
      document.activeElement?.blur();
      return na.fm("Kinds/Spend data.md")?.spend?.length ?? 0;`);
    await key("/", "Slash", 191);
    await t.sleep(200);
    const focused = await run(`const a = document.activeElement; return { line: a?.classList.contains("gz-addline-input"), value: a?.value };`);
    expect(focused.line && focused.value === "", focused);
    // "tran", not "tra": travel starts with tra too, so three letters pick no choice.
    await type("4.20 lunch tran");
    const preview = await run(`
      const el = na.view().contentEl;
      return { values: [...el.querySelectorAll(".gz-pv")].map((p) => p.querySelector(".gz-pv-value, .gz-chip.is-on")?.textContent ?? "—"), go: !el.querySelector(".gz-addline-go").disabled };`);
    expect(JSON.stringify(preview) === JSON.stringify({ values: ["$4.20", "transport", "lunch"], go: true }), preview);
    await t.shot("gallery-Budget-addline-typing.png", 1280, 900);
    await press("Enter");
    const saved = await run(`
      const rows = await na.until(() => (na.fm("Kinds/Spend data.md")?.spend?.length ?? 0) === ${before} + 1 && na.fm("Kinds/Spend data.md").spend, 5000);
      const said = await na.until(() => na.view().contentEl.querySelector(".gz-notice-text")?.textContent, 3000);
      const line = na.view().contentEl.querySelector(".gz-addline-input").value;
      document.activeElement?.blur();
      return { row: rows && rows.at(-1), said, line, undo: !!na.view().contentEl.querySelector(".gz-notice button.gz-undo") };`);
    expect(saved.row?.amount === 4.2 && saved.row.category === "transport" && saved.row.note === "lunch" && saved.said === "Added $4.20 to spend" && saved.line === "" && saved.undo, saved);
    await t.shot("gallery-Budget-addline-saved.png", 1280, 900);
    await key("z", "KeyZ", 90, process.platform === "darwin" ? 4 : 2);
    const undone = await run(`
      const back = await na.until(() => (na.fm("Kinds/Spend data.md")?.spend?.length ?? 0) === ${before}, 5000);
      return { back: !!back, said: await na.until(() => na.view().contentEl.querySelector(".gz-notice-text")?.textContent === "Undone" && "Undone", 3000), errors: na.errors() };`);
    expect(undone.back && undone.said === "Undone" && undone.errors === 0, undone);
    return `saved ${JSON.stringify({ amount: saved.row.amount, category: saved.row.category, note: saved.row.note })}; “${saved.said}”; ⌘Z: ${undone.said}`;
  });

  await check("Trip planner: days to go and the itinerary; what the trip comes to against its budget, and a cost planned past it puts the alert on; yen saved in dollars to Spend at the note's rate count in Budget; Budget's rows stay out of the trip; spend works on Do…", async () => {
    const r = await run(`
      const panel = ${PANEL};
      const big = (title) => panel(title)?.querySelector(".gz-big")?.textContent;
      const money = (text) => Number((text ?? "").replace(/[$,]/g, ""));
      const rows = () => na.fm("Kinds/Spend data.md")?.spend ?? [];
      const planned = async () => ((await na.plugin().dataLayer.ledger.state("Kinds/Spend data.md", na.fm("Kinds/Spend.md"))).lists.get("spend")?.rows ?? []).filter((x) => x.line === "planned" && x.trip === "Tokyo");
      const add = (title, line) => {
        const form = panel(title);
        na.fill(form.querySelector(".gz-addline-input"), line);
        form.querySelector("button.gz-addline-go").click();
      };
      const tab = (name) => [...na.view().contentEl.querySelectorAll("button.gz-tab")].find((b) => b.textContent === name).click();
      await na.open("Apps/Budget");
      const budgetBefore = money(await na.until(() => big("Spent so far"), 5000));
      const n = rows().length;
      await na.open("Apps/Trip planner");
      const days = big("Days to go");
      const comes = await na.until(() => big("The trip comes to"), 5000);
      // A meter beside the answer it measures shows no title of its own.
      const meter = na.view().contentEl.querySelector(".gz-meter .gz-meter-legend")?.textContent;
      // A night in a ryokan on the trip's fourth day: past the budget, told now.
      const departs = na.fm("Apps/Trip planner.md").departs;
      const d = new Date(departs + "T12:00");
      d.setDate(d.getDate() + 3);
      const mark = na.notices.length;
      add("Plan a cost", "420 Ryokan in Hakone @" + d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
      // The number tweens from the old total to the new one: wait for where it lands.
      const over = await na.until(() => big("The trip comes to") === "$3,350.00" && big("The trip comes to"), 4000) || big("The trip comes to");
      const status = panel("The trip comes to")?.querySelector(".gz-ans-status")?.textContent;
      const told = await na.noticesSince(mark, "Trip planner", 4000);
      const ryokan = (await planned()).filter((x) => x.note === "Ryokan in Hakone").length;
      tab("Itinerary");
      await na.sleep(300);
      const itinerary = [...panel("Itinerary").querySelectorAll("tbody tr")].map((tr) => tr.textContent);
      tab("Spending");
      await na.sleep(300);
      const spent = () => big("Spent so far");
      const start = money(spent());
      // Composed, the form is an add line: the word is the item, the number the yen.
      add("Spent abroad", "Ramen 1500");
      const at150 = money(await na.until(() => money(spent()) === start + 10 && spent(), 3000));
      const saved = await na.until(() => rows().length === n + 1 && rows().at(-1), 5000);
      const file = na.file("Apps/Trip planner.md");
      const original = await app.vault.read(file);
      await app.vault.modify(file, original.replace("rate: 150", "rate: 100"));
      await na.sleep(1000);
      const kept = money(spent());
      add("Spent abroad", "Sushi 1500");
      const at100 = money(await na.until(() => money(spent()) === start + 25 && spent(), 3000));
      await na.until(() => rows().length === n + 2, 5000);
      await app.vault.modify(file, original);
      await na.sleep(600);
      await na.open("Apps/Budget");
      const budgetAfter = money(await na.until(() => money(big("Spent so far")) !== budgetBefore && big("Spent so far"), 5000));
      add("Spent something", "7 food coffee");
      await na.until(() => rows().length === n + 3, 5000);
      await na.open("Apps/Trip planner");
      tab("Spending");
      await na.sleep(800);
      const expenses = [...panel("Expenses").querySelectorAll("tbody tr:not(.gz-ledger-group)")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.querySelector("input")?.value ?? td.textContent).join(" | "));
      const word = na.plugin().background.captureIndex().names.get("spend")?.app;
      const ran = await na.plugin().background.capture("spend 14.5 food lunch");
      const lunch = await na.until(() => rows().length === n + 4 && rows().at(-1), 5000);
      return { days, comes, meter, over, status, told, ryokan, itinerary, start, at150, saved, kept, at100, budgetBefore, budgetAfter, expenses, total: money(spent()), word, ran: ran.ok, lunch, errors: na.errors() };`);
    await t.shot("gallery-Trip-planner-spending.png", 1280, 900);
    expect(/^\d+ days$/.test(r.days) && r.itinerary.length >= 3, r);
    // The sample flights are paid; the rail pass, the hotel, six days of food and teamLab are planned.
    expect(r.comes === "$2,930.00" && r.meter === "92% of $3,200$270.00 left" && r.over === "$3,350.00" && r.status === "The alert is on" && r.told.includes("Trip planner: The trip comes to $3,350.00") && r.ryokan === 1, r);
    expect(r.start === 1240 && r.at150 === r.start + 10 && r.kept === r.start + 10 && r.at100 === r.start + 25, r);
    expect(r.saved && r.saved.amount === 10 && typeof r.saved.amount === "number" && r.saved.local === 1500 && r.saved.category === "travel" && r.saved.trip === "Tokyo" && r.saved.note === "Ramen", r);
    expect(Math.abs(r.budgetAfter - r.budgetBefore - 25) < 0.001, r);
    // Both are saved in the same minute, so their order is either; the flights were booked weeks ago.
    const today = r.expenses.filter((x) => !x.startsWith("Flights"));
    expect(JSON.stringify([...today].sort()) === JSON.stringify(["Ramen | ¥1,500 | $10.00", "Sushi | ¥1,500 | $15.00"]) && r.total === r.start + 25 && r.errors === 0, r);
    expect(r.word === "Spend" && r.ran && r.lunch?.amount === 14.5 && r.lunch.category === "food" && r.lunch.note === "lunch" && !r.lunch.trip, r);
    return `${r.days} to go; comes to ${r.comes}, ${r.over} with a ryokan (${r.status}); ¥1500 is $10 at 150 and $15 at 100; Budget $${r.budgetBefore} → $${r.budgetAfter}`;
  }, { net: NET["Trip planner"] });

  await check("Book finder: Add saves a book note, and the Reading progress lens shows on it", async () => {
    await run(`await na.open("Apps/Book finder"); na.view().contentEl.querySelector('input[aria-label="q"]').focus();`);
    await type("ursula le guin");
    await press("Enter");
    const searched = await run(`
      const el = na.view().contentEl;
      const results = await na.until(() => el.querySelectorAll(".gz-view-list li").length > 2 && !el.querySelector(".gz-stale, .gz-loading"), 30000);
      return { results: !!results, pending: !!el.querySelector(".gz-stale, .gz-loading") };`);
    // Still waiting for its answer says nothing about the plugin; an answer that is wrong does.
    if (!searched.results && searched.pending) t.skip("Open Library hasn't answered in 30 s");
    const r = await run(`
      const el = na.view().contentEl;
      const item = [...el.querySelectorAll(".gz-view-list li")].find((li) => {
        const title = li.textContent.split(" · ")[0];
        return !/[\\\\/:*?"<>|#^\\[\\]]/.test(title) && !na.exists("Books/" + title + ".md");
      });
      const title = item.textContent.split(" · ")[0];
      na.button("Add", item).click();
      const fm = await na.until(() => na.fm("Books/" + title + ".md"), 5000);
      await app.workspace.openLinkText("Books/" + title, "", false);
      await na.sleep(1200);
      const lens = na.view().contentEl.querySelector(".gz-lens");
      return { title, fm, state: na.state(), name: lens?.querySelector(".gz-lens-name")?.textContent, lens: lens && na.text(lens) };`);
    expect(r.fm && r.fm.status === "to read" && typeof r.fm.year === "number" && r.state === `markdown:Books/${r.title}.md`, r);
    expect(r.name === "Reading progress" && r.lens.includes("Change properties of notes in Books"), r);
    return `Books/${r.title}.md; lens: ${r.lens.slice(0, 80)}`;
  }, { net: NET["Book finder"] });

  await check("Share Practice shows its text with the Tracker kit; installed under another name it reuses the kit and opens; under its own name it's refused", async () => {
    const r = await run(`
      await na.open("Apps/Practice");
      app.commands.executeCommandById("gizmo:share-app");
      const shared = await na.until(() => activeDocument.querySelector(".modal .gz-share-text"), 3000);
      const modal = shared.closest(".modal");
      const text = shared.value;
      const said = na.text(modal);
      modal.querySelector(".modal-close-button, .modal-header-button").click();
      await na.sleep(300);

      const install = async (bundle) => {
        app.commands.executeCommandById("gizmo:install-app");
        const area = await na.until(() => activeDocument.querySelector(".modal .gz-share-text"), 3000);
        const m = area.closest(".modal");
        area.value = bundle;
        [...m.querySelectorAll("button")].find((b) => b.textContent === "Preview").click();
        const preview = await na.until(() => m.querySelector(".gz-install-preview h4, .gz-install-preview .gz-error-text") && na.text(m.querySelector(".gz-install-preview")), 3000);
        return { m, preview, button: [...m.querySelectorAll("button")].find((b) => b.textContent === "Install") };
      };
      const refused = await install(text);
      const refusedDisabled = refused.button.disabled;
      refused.m.querySelector(".modal-close-button, .modal-header-button").click();
      await na.sleep(300);

      const copy = text.replace(/^# Practice$/m, "# Practice copy").replace("gizmo-note Practice\\n", "gizmo-note Practice copy\\n");
      const fresh = await install(copy);
      fresh.button.click();
      const opened = await na.until(() => na.state() === "gizmo:" + (app.fileManager.getNewFileParent("").path === "/" ? "" : app.fileManager.getNewFileParent("").path + "/") + "Practice copy.md" && na.state(), 5000);
      await na.settle?.();
      await na.sleep(800);
      const copies = app.vault.getMarkdownFiles().filter((f) => f.basename === "Tracker kit").length;
      return { text, said, refused: refused.preview, refusedDisabled, preview: fresh.preview, opened, copies, errors: na.errors(), app: na.text() };`);
    expect(r.text.startsWith("# Practice\n") && r.text.includes("````gizmo-note Practice\n") && r.text.includes("````gizmo-note Tracker kit\n"), r.text.slice(0, 200));
    expect(r.said.includes("It takes Tracker kit along with Practice."), r.said);
    expect(r.refused.includes("“Practice” already exists") && r.refusedDisabled, r);
    expect(r.preview.includes("Creates Practice copy, and uses your Tracker kit.") && r.preview.includes("It asks for nothing"), r.preview);
    expect(r.opened && r.copies === 1 && r.errors === 0, r);
    return `refused as taken; installed: ${r.preview.slice(0, 90)}`;
  });

  // ---- A made-up week with Budget, Bills and renewals and Medication log, on their sample rows -----
  // The sample rows are written for today (scripts/samples.ts): the same story, whatever the day.

  /** Page code: panels of the open app by title, what they show, its tabs and add lines; a kind's rows, every line. */
  const P = `
    const panel = (title) => [...na.view().contentEl.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
    const big = (title) => panel(title)?.querySelector(".gz-big, .gz-text, .gz-empty")?.textContent;
    const rowsOf = (title) => [...(panel(title)?.querySelectorAll("tbody tr:not(.gz-ledger-group)") ?? [])].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.querySelector("input, select")?.value ?? td.textContent).join(" | "));
    const tab = async (name) => { [...na.view().contentEl.querySelectorAll("button.gz-tab")].find((b) => b.textContent === name)?.click(); await na.sleep(600); };
    const add = async (title, line) => {
      const form = panel(title);
      na.fill(form.querySelector(".gz-addline-input"), line);
      await na.sleep(300);
      const preview = [...form.querySelectorAll(".gz-pv")].map((p) => p.textContent);
      form.querySelector("button.gz-addline-go").click();
      await na.sleep(900);
      return preview;
    };
    const kindRows = async (name, list) => (await na.plugin().dataLayer.ledger.state("Kinds/" + name + " data.md", na.fm("Kinds/" + name + ".md"))).lists.get(list)?.rows.map((r) => ({ ...r })) ?? [];
    const asks = () => na.plugin().background.asks.list();
    const pad = (n) => String(n).padStart(2, "0");
    const day = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    /** The weekday n days back, as a line's @ takes it: never today, so never a time still to come. */
    const back = (n) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.now() - n * 86400000).getDay()];
    /** The day n days back (ahead, when n is below 0), as a row's time starts. */
    const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return day(d); };`;
  const CLEAN = `
    const trust = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins");
    if (trust) { trust.click(); await na.until(() => na.plugin()?.background, 5000); await na.sleep(1500); }`;
  const now = new Date();
  // The four charges nobody logged are 12 to 2 days old: the month's totals hold them all from the 13th.
  const WHOLE = now.getDate() >= 13;
  const money = (s) => Number(String(s).replace(/[$,]/g, ""));
  const closeModals = async () => {
    for (let i = 0; i < 5 && (await run(`return document.querySelectorAll(".modal").length;`)); i++) await press("Escape");
  };
  const letter = async (ch) => {
    const code = `Key${ch.toUpperCase()}`;
    const vk = ch.toUpperCase().charCodeAt(0);
    await t.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await t.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await run(`await na.sleep(200);`);
  };

  await check("week, Monday: the sample export in Inbox/Bank was read in as Spend was allowed, its pay cheques left out; Budget's own card pairs it, Accept all there counts each charge once, and STREAMFLIX's dearer charge settles its bill", async () => {
    await closeModals();
    const card = `panel("Charges from the bank, not checked yet")?.querySelector(".gz-reconcile")`;
    const before = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Budget");
      await na.until(() => big("The month lands at"), 5000);
      const box = await na.until(() => ${card}, 5000);
      await na.sleep(600);
      box?.scrollIntoView({ block: "center" });
      return {
        imported: na.notices.filter((n) => n.startsWith("Imported") && n.includes("into Spend")),
        lands: big("The month lands at"), spent: big("Spent so far"), coming: big("Still to come"),
        title: box?.querySelector(".gz-title")?.textContent, counts: [...(box?.querySelectorAll(".gz-reconcile-count") ?? [])].map((c) => c.textContent),
        streamflix: asks().filter((a) => a.text.includes("STREAMFLIX")).map((a) => a.text), errors: na.errors(),
      };`);
    await t.shot("week-budget-card.png", 1280, 900);
    const after = await run(`
      ${P}
      const box = ${card};
      if (!box) return { error: "no card" };
      na.button("Accept all", box).click();
      await na.until(() => !${card}, 6000);
      await na.sleep(900);
      panel("Charges from the bank, not checked yet")?.scrollIntoView({ block: "center" });
      const rows = await kindRows("Spend", "spend");
      const of = (note, n) => rows.filter((x) => x.note === note && String(x.at).startsWith(ago(n))).map((x) => (x.line ?? "logged") + " " + x.amount + (x.matched ? " settled" : "")).sort();
      const [entry] = await na.plugin().activity.list("Apps/Budget.md");
      return {
        water: of("METRO WATER", 2), streamflix: of("STREAMFLIX", 6), entry: entry && [entry.what, entry.changes.length],
        lands: big("The month lands at"), spent: big("Spent so far"), coming: big("Still to come"), waiting: big("Charges from the bank, not checked yet"),
        streamflixAsks: asks().filter((a) => a.text.includes("STREAMFLIX")).length, errors: na.errors(),
      };`);
    await t.shot("week-budget-after-accept.png", 1280, 900);
    expect(before.errors === 0 && before.imported.some((n) => /^Imported 14 rows from Checking \d{4}-\d{2}\.csv into Spend, skipped 2$/.test(n)), before);
    // Rows other checks logged today sit in the file's days too, so only what the file holds is counted here.
    expect(before.title === "14 rows from a file to check" && before.counts[0] === "10 pair with rows you logged" && before.counts[1] === "4 only in the file" && before.streamflix.length === 1, before);
    expect(JSON.stringify(after.water) === JSON.stringify(["logged 38.2", "planned 38.2 settled"]) && JSON.stringify(after.streamflix) === JSON.stringify(["logged 17.99", "planned 15.49 settled"]) && after.streamflixAsks === 0, after);
    // Each of the 4 rows only in the file is taken as logged and keeps which import row it was: two changes each.
    expect(JSON.stringify(after.entry) === JSON.stringify(["Accepted 14 rows from a file", 20]) && after.waiting?.startsWith("No charge from the bank waits") && after.errors === 0, after);
    // Four charges nobody logged (6.75, 17.99, 18.00 and the water's 38.20) now count; the water bill and STREAMFLIX no longer wait.
    if (WHOLE) expect(Math.abs(money(after.spent) - money(before.spent) - 80.94) < 0.005 && Math.abs(money(before.coming) - money(after.coming) - 53.69) < 0.005 && Math.abs(money(after.lands) - money(before.lands) - 27.25) < 0.005, { before, after });
    return `${before.imported[0]}; ${before.counts.join(", ")}; STREAMFLIX ${after.streamflix.join(" + ")}; lands ${before.lands} → ${after.lands}, spent ${before.spent} → ${after.spent}${WHOLE ? "" : " (totals not checked before the 13th)"}`;
  });

  await check("week, Thursday: groceries logged for the day, then that week's export read in with Import rows into a kind…, its pay cheque left out; Bills shows that STREAMFLIX, settled, charged more than planned", async () => {
    const logged = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Budget");
      const preview = await add("Spent something", "71.35 food groceries @" + back(3) + " 18:00");
      await na.until(async () => (await kindRows("Spend", "spend")).some((x) => x.amount === 71.35), 4000);
      const d = new Date(Date.now() - 3 * 86400000);
      const us = (n) => { const x = new Date(d.getTime() + n * 86400000); return (x.getMonth() + 1) + "/" + x.getDate() + "/" + x.getFullYear(); };
      const name = "Checking week of " + day(d);
      await na.write("Downloads/" + name + ".csv", ["Posted Date,Description,Amount", us(1) + ",GREENLEAF MARKET,-71.35", us(1) + ",BLUE DOOR CAFE,-5.25", us(2) + ",PARKWAY PHARMACY,-12.40", us(2) + ",PAYROLL ACME CO,3120.55", ""].join("\\n"));
      await na.sleep(600);
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:import-rows");
      let input = await na.until(() => document.querySelector(".prompt .prompt-input"), 3000);
      // Spend, Measurement and Trade each have an import: the command asks which first.
      const asked = input?.placeholder;
      na.fill(input, "Spend: bank");
      const way = await na.until(() => document.querySelector(".prompt .suggestion-item.is-selected"), 3000);
      const ways = [...document.querySelectorAll(".prompt .suggestion-item")].map((x) => x.textContent);
      way?.click();
      input = await na.until(() => { const i = document.querySelector(".prompt .prompt-input"); return i?.placeholder.startsWith("A file") && i; }, 3000);
      const placeholder = input?.placeholder;
      na.fill(input, name);
      const pick = await na.until(() => document.querySelector(".prompt .suggestion-item.is-selected"), 3000);
      const picked = pick?.textContent;
      pick?.click();
      const said = await na.noticesSince(mark, "Imported", 5000);
      await na.open("Kinds/Spend");
      const card = await na.until(() => na.view().contentEl.querySelector(".gz-reconcile"), 5000);
      await na.sleep(400);
      return { preview, asked, ways, placeholder, picked, said, counts: [...(card?.querySelectorAll(".gz-reconcile-count") ?? [])].map((c) => c.textContent) };`);
    await t.shot("week-import-command-card.png", 1280, 900);
    const priced = await run(`
      ${P}
      const box = na.view().contentEl.querySelector(".gz-reconcile");
      if (box) na.button("Accept all", box).click();
      await na.until(() => !na.view().contentEl.querySelector(".gz-reconcile"), 5000);
      const added = (await kindRows("Spend", "spend")).filter((x) => x.note === "PARKWAY PHARMACY").map((x) => x.line ?? "logged");
      await na.open("Apps/Bills and renewals");
      await tab("Price changes");
      await na.sleep(500);
      return { added, change: rowsOf("Charged more than planned"), errors: na.errors() };`);
    await t.shot("week-bills-streamflix-settled-rise.png", 1280, 900);
    expect(logged.asked === "Which kind, and which of its imports?" && logged.ways[0] === "Spend: bank", logged);
    expect(logged.preview.some((p) => p.startsWith("at")) && logged.placeholder === "A file to read into Spend as bank" && logged.picked?.startsWith("Downloads/Checking week of"), logged);
    // Rows other checks logged today sit in the file's days too, so only what the file holds is counted here.
    expect(logged.said.some((n) => /^Imported 3 rows from Checking week of .* into Spend, skipped 1$/.test(n)) && logged.counts[0] === "1 pair with rows you logged" && logged.counts[1] === "2 only in the file", logged);
    expect(JSON.stringify(priced.added) === JSON.stringify(["logged"]) && JSON.stringify(priced.change) === JSON.stringify(["STREAMFLIX | $15.49 | $17.99 | $2.50"]) && priced.errors === 0, priced);
    return `${logged.said.find((n) => n.startsWith("Imported"))}; ${logged.counts.slice(0, 2).join(", ")}; price change ${priced.change[0]}`;
  });

  await check("week, Saturday: Bills and renewals: a bill planned on its add line shows in Coming up, and the renewals whose day to start has come wait in Next", async () => {
    const r = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Bills and renewals");
      await tab("Next 30 days");
      await na.sleep(500);
      const first = { headline: big("Bills in the next 30 days"), start: big("Renewals to start"), renewals: rowsOf("Renewals by deadline").length };
      const preview = await add("A bill", '12.99 "NEWSDAILY DIGITAL" fun @+10d');
      await na.until(() => rowsOf("Coming up").some((x) => x.startsWith("NEWSDAILY DIGITAL")), 4000);
      await na.sleep(400);
      const planned = (await kindRows("Spend", "spend")).filter((x) => x.note === "NEWSDAILY DIGITAL").map((x) => x.line);
      await na.plugin().background.tick();
      await na.sleep(500);
      return { first, preview, planned, due: ago(-12), renewalAsks: asks().filter((a) => a.app === "Renewal").map((a) => a.text), errors: na.errors() };`);
    await t.shot("week-bills-coming-up.png", 1280, 900);
    expect(r.preview.some((p) => p.startsWith("planned")) && JSON.stringify(r.planned) === JSON.stringify(["planned"]) && r.errors === 0, r);
    // The enrolment's day to start was two days ago; the home insurance's is in two days.
    expect(r.renewalAsks.some((a) => a.startsWith(`Benefits open enrolment ${r.due}`)) && !r.renewalAsks.some((a) => a.startsWith("Renew home insurance")), r);
    return `${r.first.headline} in the next 30 days, ${r.first.start} renewals to start; asks: ${r.renewalAsks.map((a) => a.split(",")[0]).join("; ")}`;
  });

  await check("week, Sunday: Next, one ask at a time: Enter says the enrolment was done (and FASTNET paid, once its time has come), Skip puts off the rest; STREAMFLIX, settled on Monday, asks nothing", async () => {
    await closeModals();
    await run(`${CLEAN} app.commands.executeCommandById("gizmo:next"); await na.until(() => document.querySelector(".gz-next .gz-next-text, .gz-next .gz-next-empty"), 3000); await na.sleep(300);`);
    const shots = { "Benefits open enrolment": "week-next-renewal.png", FASTNET: "week-next-fastnet.png" };
    const seen = [];
    for (let i = 0; i < 40; i++) {
      const shown = await run(`await na.sleep(300); const n = document.querySelector(".gz-next"); return n?.querySelector(".gz-next-empty") ? "" : n?.querySelector(".gz-next-text")?.textContent ?? "";`);
      if (!shown) break;
      const key = Object.keys(shots).find((k) => shown.includes(k));
      seen.push(key ? shown : `(skipped) ${shown.split(",")[0]}`);
      if (key) {
        await t.shot(shots[key], 1100, 760);
        delete shots[key];
        await press("Enter");
      } else await run(`[...document.querySelectorAll(".gz-next-buttons button")].find((b) => b.textContent === "Skip")?.click();`);
      await run(`await na.until(() => (document.querySelector(".gz-next .gz-next-text")?.textContent ?? "") !== ${JSON.stringify(shown)}, 3000);`);
    }
    await closeModals();
    const after = await run(`
      ${P}
      const rows = await kindRows("Spend", "spend");
      const renewals = await kindRows("Renewal", "renewal");
      await na.open("Apps/Bills and renewals");
      await tab("Price changes");
      const change = rowsOf("Charged more than planned");
      await tab("Done");
      await na.sleep(400);
      return {
        fastnet: rows.filter((x) => x.note === "FASTNET INTERNET" && String(x.at).startsWith(ago(0))).map((x) => x.line ?? "logged"),
        enrolment: renewals.filter((x) => x.what === "Benefits open enrolment").map((x) => x.line ?? "logged"),
        change, renewed: rowsOf("Renewed"), errors: na.errors(),
      };`);
    await t.shot("week-bills-done.png", 1280, 900);
    const answered = seen.filter((s) => !s.startsWith("(skipped)"));
    const fastnet = answered.some((s) => s.startsWith("65 home FASTNET INTERNET, planned "));
    expect(answered.some((s) => s.startsWith("Benefits open enrolment ")) && !seen.some((s) => s.includes("STREAMFLIX")), seen);
    expect(JSON.stringify(after.enrolment) === JSON.stringify(["logged"]) && JSON.stringify(after.fastnet) === JSON.stringify([fastnet ? "logged" : "planned"]), after);
    expect(JSON.stringify(after.change) === JSON.stringify(["STREAMFLIX | $15.49 | $17.99 | $2.50"]) && after.renewed.some((x) => x.includes("Benefits open enrolment")) && after.errors === 0, after);
    return `answered: ${answered.map((s) => s.split(",")[0]).join("; ")}; skipped ${seen.length - answered.length}`;
  });

  await check("week, Sunday: What if… a concert this month: Budget, shown at the month's end, has spent all it planned and says the alert would go on as it is planned; Discard leaves nothing", async () => {
    const r = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Budget");
      await na.sleep(500);
      const live = big("The month lands at");
      const lands = Number(String(live).replace(/[$,]/g, ""));
      if (lands >= 2500) return { live, already: true };
      // Enough to go past the limit, in round fifties, as a person would type it.
      const amount = Math.ceil((2550 - lands) / 50) * 50;
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const t = new Date(now.getFullYear(), now.getMonth(), Math.min(now.getDate() + 3, last.getDate()), 20, 0);
      const when = t > now ? t : new Date(now.getTime() + 10 * 60000);
      const dayName = when.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
      app.commands.executeCommandById("gizmo:capture");
      const input = await na.until(() => document.querySelector(".gz-capture-input"), 3000);
      na.fill(input, "what if spend " + amount + " fun concert @" + day(when) + " " + pad(when.getHours()) + ":" + pad(when.getMinutes()));
      await na.sleep(600);
      const hint = document.querySelector(".gz-capture-hint")?.textContent;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const aheadTab = () => app.workspace.getLeavesOfType("gizmo").find((l) => l.view.file?.path === "Apps/Budget.md" && l.view.contentEl.querySelector(".gz-ahead"));
      await na.until(() => aheadTab()?.view.contentEl.querySelector(".gz-ahead")?.innerText.includes("On the way there"), 8000);
      app.workspace.setActiveLeaf(aheadTab(), { focus: true });
      await na.sleep(800);
      const card = aheadTab()?.view.contentEl.querySelector(".gz-ahead")?.innerText.replace(/\\n+/g, " | ");
      const shown = (title) => [...aheadTab().view.contentEl.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title)?.querySelector(".gz-big")?.textContent;
      const today = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
      return { live, amount, hint, card, dayName, today, ahead: shown("The month lands at"), spent: shown("Spent so far"), coming: shown("Still to come") };`);
    if (r.already) return `the month already lands at ${r.live}, past the limit: no alert left to go on`;
    await t.shot("week-what-if-concert.png", 1280, 900);
    const gone = await run(`
      const aheadTab = () => app.workspace.getLeavesOfType("gizmo").find((l) => l.view.file?.path === "Apps/Budget.md" && l.view.contentEl.querySelector(".gz-ahead"));
      [...aheadTab().view.contentEl.querySelectorAll(".gz-ahead button")].find((b) => b.textContent === "Discard")?.click();
      await na.sleep(800);
      const rows = (await na.plugin().dataLayer.ledger.state("Kinds/Spend data.md", na.fm("Kinds/Spend.md"))).lists.get("spend")?.rows ?? [];
      aheadTab()?.detach();
      await na.sleep(300);
      return rows.some((x) => x.note === "concert");`);
    expect(r.hint?.startsWith("What if, in Budget: ") && Math.abs(money(r.ahead) - money(r.live) - r.amount) < 0.005, r);
    // At the month's end every bill planned in it has happened: all of it is spent, and nothing is still to come.
    expect(r.coming === "$0.00" && Math.abs(money(r.spent) - money(r.ahead)) < 0.005, r);
    // The month lands at what is planned too, so planning the concert puts the alert on today, as Keep would.
    expect(r.card?.includes(`“The month lands at” (> 2500) would go on ${r.today}`) && !gone, r);
    return `${r.amount} on a concert: ${r.live} → ${r.ahead} at the month's end; ${r.card.match(/“The month lands at”[^|]*/)?.[0]}`;
  });

  await check("Medication log for a week: past days' doses with @, today's with one tap; a schedule planned in Do…; a refill; For the doctor sums it up", async () => {
    const r = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Medication log");
      await na.sleep(500);
      const lines = ["meds @" + back(3) + " 8:05", "medb @" + back(3) + " 8:10", "medb @" + back(3) + " 20:15", "meds @" + back(2) + " 8:20", "medb @" + back(2) + " 8:20",
        'dose "Medication B" "late, felt fine" @' + back(2) + " 22:40", "meds @yday 9:45", "medb @yday 9:45"];
      const ran = [];
      for (const line of lines) ran.push((await na.plugin().background.capture(line)).ok);
      await na.sleep(500);
      na.button("Took Medication A").click();
      await na.sleep(900);
      const today = { doses: big("Doses today"), list: rowsOf("Today's doses") };
      const until = new Date(Date.now() + 14 * 86400000);
      app.commands.executeCommandById("gizmo:capture");
      const input = await na.until(() => document.querySelector(".gz-capture-input"), 3000);
      na.fill(input, 'dose "Medication B" @every day 08:00 until ' + day(until));
      await na.sleep(600);
      return { ran, today, hint: document.querySelector(".gz-capture-hint")?.textContent, effects: [...document.querySelectorAll(".gz-capture .gz-effects li")].map((li) => li.textContent) };`);
    await t.shot("week-meds-plan-schedule.png", 1100, 760);
    await press("Enter");
    const after = await run(`
      ${P}
      await na.until(async () => (await kindRows("Dose", "dose")).filter((x) => x.line === "planned").length >= 14, 5000);
      await na.open("Apps/Medication log");
      await na.sleep(800);
      const next = big("Next dose");
      await tab("Supply");
      const before = rowsOf("What I have left");
      await add("Picked up a refill", '"Medication B" 60');
      await na.sleep(600);
      return { next, before, supply: rowsOf("What I have left"), planned: (await kindRows("Dose", "dose")).filter((x) => x.line === "planned").length };`);
    await t.shot("week-meds-supply.png", 1280, 900);
    const doctor = await run(`
      ${P}
      await tab("For the doctor");
      await na.sleep(400);
      return { share: big("Taken as planned"), each: rowsOf("Each medication, last 30 days"), missed: rowsOf("Missed doses").length, noted: rowsOf("What I noted"), errors: na.errors() };`);
    await t.shot("week-meds-doctor.png", 1280, 900);
    await run(`${P} await tab("Today");`);
    const left = (rows) => Number(rows.find((x) => x.startsWith("Medication B"))?.split(" | ")[1]);
    expect(r.ran.every(Boolean) && Number(r.today.doses) >= 1 && r.today.list.some((x) => x.includes("Medication A") && x.includes("taken")), r);
    // Each day at 08:00 to two weeks on: today's too, while 08:00 is still to come.
    expect(/planned 1[45] times, \w{3} \w{3} \d+, 08:00 to \w{3} \w{3} \d+, 08:00/.test(r.hint) && r.effects.length === 1 && /^Save med Medication B, line planned to dose in Dose data, 1[45] times$/.test(r.effects[0]), r);
    expect(after.planned >= 14 && after.next?.startsWith("Medication B, "), after);
    expect(left(after.supply) === left(after.before) + 60, after);
    expect(/^\d+%$/.test(doctor.share) && doctor.each.length === 2 && doctor.missed >= 5 && doctor.noted.some((x) => x.includes("late, felt fine")) && doctor.errors === 0, doctor);
    return `today ${r.today.doses} doses; ${r.effects[0]}; ${after.next}; B on hand ${left(after.before)} → ${left(after.supply)}; doctor: ${doctor.share}, ${doctor.each.join(" / ")}`;
  });

  await check("? spend … and ? dose … in Do…: the month by category, the bills planned ahead, and doses by medication", async () => {
    await closeModals();
    const shots = [];
    for (const [name, line] of [["ask-spend-by-category", "? spend by category this month"], ["ask-spend-planned", "? spend planned next 30 days"], ["ask-dose-by-med", "? dose count by med last 30 days"]]) {
      const r = await run(`
        ${CLEAN}
        if (!document.querySelector(".gz-capture-input")) app.commands.executeCommandById("gizmo:capture");
        const input = await na.until(() => document.querySelector(".gz-capture-input"), 3000);
        na.fill(input, ${JSON.stringify(line)});
        await na.until(() => document.querySelector(".gz-ask-answer .gz-panel") && !document.querySelector(".gz-ask-body.is-stale"), 5000);
        await na.sleep(700);
        const answer = document.querySelector(".gz-ask-answer");
        return { hint: document.querySelector(".gz-capture-hint")?.textContent, title: answer?.querySelector(".gz-title")?.textContent, big: answer?.querySelector(".gz-big")?.textContent, error: document.querySelector(".gz-capture-hint")?.classList.contains("gz-error-text") };`);
      await t.shot(`week-${name}.png`, 1100, 800);
      shots.push(r);
    }
    await closeModals();
    expect(shots.every((r) => !r.error && r.title), shots);
    expect(shots[0].title === "Spend: sum of amount by category, this month" && shots[2].title?.startsWith("Dose: count"), shots);
    return shots.map((r) => `${r.title}${r.big ? ` = ${r.big}` : ""}`).join("; ");
  });

  // ---- The same week with Vitals, Trades and Household chores, on their sample rows -------------

  await check("week: Vitals: the health export was read in as Measurement was allowed, steps and failed readings left out; Accept all on its card; a weigh-in and a blood pressure reading on the add line; For the appointment sums up 30 and 90 days", async () => {
    await closeModals();
    const card = `panel("From my health export, not checked yet")?.querySelector(".gz-reconcile")`;
    const before = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Vitals");
      await na.until(() => big("Weight"), 5000);
      const box = await na.until(() => ${card}, 5000);
      await na.sleep(600);
      box?.scrollIntoView({ block: "center" });
      return {
        imported: na.notices.filter((n) => n.startsWith("Imported") && n.includes("into Measurement")), told: na.notices.filter((n) => n.startsWith("Vitals:")),
        latest: ["Weight", "Blood pressure", "Pulse", "Sleep"].map(big), title: box?.querySelector(".gz-title")?.textContent,
        counts: [...(box?.querySelectorAll(".gz-reconcile-count") ?? [])].map((c) => c.textContent), errors: na.errors(),
      };`);
    await t.shot("week-vitals-card.png", 1280, 900);
    // The same card at phone width: each row's words wrap beside its buttons.
    await run(`${P} app.workspace.leftSplit.collapse(); await na.sleep(300); ${card}?.scrollIntoView({ block: "start" }); await na.sleep(300);`);
    await t.shot("week-vitals-card-phone.png", 390, 844, 2);
    await run(`app.workspace.leftSplit.expand(); await na.sleep(300);`);
    const after = await run(`
      ${P}
      const box = ${card};
      if (!box) return { error: "no card" };
      na.button("Accept all", box).click();
      await na.until(() => !${card}, 6000);
      await na.sleep(900);
      const accepted = { weight: big("Weight"), sittings: rowsOf("Blood pressure, each sitting").slice(0, 3) };
      await add("Weighed in", "79.4");
      await add("Took a reading", "sys 128");
      await add("Took a reading", "dia 82");
      await na.sleep(600);
      const logged = { weight: big("Weight"), bp: big("Blood pressure"), recent: rowsOf("Recent").slice(0, 3) };
      await tab("For the appointment");
      await na.sleep(500);
      return { accepted, logged, month: big("Weight, last 30 days"), bp30: big("Blood pressure, last 30 days"), each30: rowsOf("Each measure, last 30 days"), off: rowsOf("Off target, last 90 days").length, noted: rowsOf("What I noted").length, errors: na.errors() };`);
    await t.shot("week-vitals-appointment.png", 1280, 900);
    await run(`${P} await tab("Now");`);
    expect(before.errors === 0 && before.imported.some((n) => /^Imported 31 rows from Health export \d{4}-\d{2}\.csv into Measurement, skipped 12$/.test(n)) && before.told.includes("Vitals: Sleep 6.5 hours"), before);
    expect(JSON.stringify(before.latest) === JSON.stringify(["79.8kg", "125/80", "69bpm", "6.5hours"]) && before.title === "31 rows from a file to check" && before.counts[0] === "24 pair with rows you logged" && before.counts[1] === "7 only in the file", before);
    expect(after.accepted.weight === "79.7kg" && after.accepted.sittings.some((x) => x.endsWith("evening | 141 | 91 | 76")), after);
    // Weight is the newest weigh-in: ours, unless the scale's of this morning is timed later (a run before 07:15).
    const newest = after.logged.recent.find((x) => x.includes(" | weight | "));
    expect(newest && after.logged.weight === `${Number(newest.split(" | ")[2]).toFixed(1)}kg` && after.logged.recent.some((x) => x.includes(" | weight | 79.4 | ")) && after.logged.bp === "128/82", after);
    expect(after.month?.endsWith("kg") && /^\d+\/\d+$/.test(after.bp30) && after.each30.length === 5 && after.off > 0 && after.noted >= 4 && after.errors === 0, after);
    return `${before.imported[0]}; ${before.counts.join(", ")}; accepted, weight ${after.accepted.weight}; logged 79.4 and 128/82; 30 days: ${after.month}, ${after.bp30}`;
  });

  await check("week: Trades: the broker's export read in, its dividend and interest left out; a sell of shares never bought here is flagged, not taken as a short; Accept all fills the tranche; a buy planned on the Plan tab; What if… a buy shows what I would hold, and Discard leaves nothing", async () => {
    await closeModals();
    const card = `panel("From my broker, not checked yet")?.querySelector(".gz-reconcile")`;
    const before = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Trades");
      await na.until(() => big("Cost of what I hold"), 5000);
      const box = await na.until(() => ${card}, 5000);
      await na.sleep(600);
      box?.scrollIntoView({ block: "center" });
      return {
        imported: na.notices.filter((n) => n.startsWith("Imported") && n.includes("into Trade")), told: na.notices.filter((n) => n.startsWith("Trades:")),
        cost: big("Cost of what I hold"), held: rowsOf("What I hold"), over: rowsOf("Sells over what I hold"),
        title: box?.querySelector(".gz-title")?.textContent, counts: [...(box?.querySelectorAll(".gz-reconcile-count") ?? [])].map((c) => c.textContent), errors: na.errors(),
      };`);
    await t.shot("week-trades-card.png", 1280, 900);
    const after = await run(`
      ${P}
      const box = ${card};
      if (!box) return { error: "no card" };
      na.button("Accept all", box).click();
      await na.until(() => !${card}, 6000);
      await na.sleep(900);
      const tranche = (await kindRows("Trade", "trade")).filter((x) => x.line === "planned" && x.matched).length;
      const held = rowsOf("What I hold");
      const over = rowsOf("Sells over what I hold");
      await tab("Plan");
      const still = big("Still to buy");
      const preview = await add("Plan a buy", "QQQ 4 560 @+20d");
      await na.sleep(500);
      return { tranche, held, over, still, preview, stillAfter: big("Still to buy"), next: big("Next tranche"), errors: na.errors() };`);
    await t.shot("week-trades-plan.png", 1280, 900);
    const ahead = await run(`
      ${P}
      await tab("Holdings");
      const qqq = (rows) => Number(rows.find((x) => x.startsWith("QQQ"))?.split(" | ")[1]);
      const live = qqq(rowsOf("What I hold"));
      const now = new Date();
      const when = new Date(now.getTime() + 10 * 60000);
      app.commands.executeCommandById("gizmo:capture");
      const input = await na.until(() => document.querySelector(".gz-capture-input"), 3000);
      na.fill(input, "what if trade QQQ buy 10 560 @" + day(when) + " " + pad(when.getHours()) + ":" + pad(when.getMinutes()));
      await na.sleep(600);
      const hint = document.querySelector(".gz-capture-hint")?.textContent;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const aheadTab = () => app.workspace.getLeavesOfType("gizmo").find((l) => l.view.file?.path === "Apps/Trades.md" && l.view.contentEl.querySelector(".gz-ahead"));
      await na.until(() => aheadTab()?.view.contentEl.querySelector(".gz-ahead")?.innerText.includes("1 what-if row"), 8000);
      app.workspace.setActiveLeaf(aheadTab(), { focus: true });
      await na.sleep(800);
      const shown = [...(aheadTab()?.view.contentEl.querySelectorAll(".gz-panel") ?? [])].find((p) => p.querySelector(".gz-title")?.textContent === "What I hold");
      const rows = [...(shown?.querySelectorAll("tbody tr") ?? [])].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join(" | "));
      return { live, hint, card: aheadTab()?.view.contentEl.querySelector(".gz-ahead")?.innerText.replace(/\\n+/g, " | "), ahead: qqq(rows) };`);
    await t.shot("week-trades-what-if.png", 1280, 900);
    const gone = await run(`
      const aheadTab = () => app.workspace.getLeavesOfType("gizmo").find((l) => l.view.file?.path === "Apps/Trades.md" && l.view.contentEl.querySelector(".gz-ahead"));
      [...(aheadTab()?.view.contentEl.querySelectorAll(".gz-ahead button") ?? [])].find((b) => b.textContent === "Discard")?.click();
      await na.sleep(800);
      const rows = (await na.plugin().dataLayer.ledger.state("Kinds/Trade data.md", na.fm("Kinds/Trade.md"))).lists.get("trade")?.rows ?? [];
      aheadTab()?.detach();
      await na.sleep(300);
      return rows.some((x) => x.symbol === "QQQ" && x.shares === 10 && x.price === 560);`);
    const money = (x) => Number(String(x).replace(/[$,]/g, ""));
    expect(before.errors === 0 && before.imported.some((n) => /^Imported 4 rows from Brokerage \d{4}-\d{2}\.csv into Trade, skipped 2$/.test(n)) && before.told.includes("Trades: Sells over what I hold: MSFT"), before);
    expect(before.cost === "$19,817.57" && before.held[0] === "VTI | 40 | $272.58 | $10,903.17" && before.over.length === 1 && before.over[0].includes("MSFT | 4 | 0"), before);
    expect(before.title === "4 rows from a file to check" && before.counts[0] === "2 pair with rows you logged" && before.counts[1] === "2 only in the file", before);
    expect(after.tranche >= 1 && after.held[0]?.startsWith("VTI | 45 | $277.00") && !after.held.some((x) => x.startsWith("MSFT")) && after.over.length === 1, after);
    expect(after.preview.some((x) => x.startsWith("planned")) && Math.abs(money(after.stillAfter) - money(after.still) - 2240) < 0.005 && after.errors === 0, after);
    expect(ahead.hint?.startsWith("What if, in Trades: ") && ahead.ahead === ahead.live + 10 && !gone, ahead);
    return `${before.imported[0]}; MSFT sell flagged; after Accept all ${after.held[0]}; planned QQQ: still to buy ${after.still} → ${after.stillAfter}; what if: QQQ ${ahead.live} → ${ahead.ahead}`;
  });

  await check("week: Household chores: the week's rota and the overdue turns; a vacuum by Alex settles Sam's turn; last Thursday's bins logged late and the smoke alarms tested settle theirs; the batteries' cost goes to Spend as upkeep", async () => {
    await closeModals();
    const r = await run(`
      ${CLEAN} ${P}
      await na.open("Apps/Household chores");
      await na.until(() => big("Overdue"), 5000);
      const before = { done: Number(big("Done this week")), todo: Number(big("Still to do this week")), overdue: Number(big("Overdue")), late: rowsOf("Overdue turns") };
      const preview = await add("Did a chore", "vacuum Alex");
      await na.sleep(400);
      const vacuumed = { done: Number(big("Done this week")), settled: (await kindRows("Chore", "chore")).filter((x) => x.task === "Vacuum the house" && x.line === "planned" && x.matched).length };
      const ran = [];
      for (const line of ['did "Take the bins out" Sam outside @' + back(6) + " 20:30", "chore smoke Alex upkeep"]) ran.push((await na.plugin().background.capture(line)).ok);
      await na.sleep(900);
      const after = { overdue: Number(big("Overdue")), late: rowsOf("Overdue turns"), who: rowsOf("Who did what this week") };
      return { before, preview, vacuumed, ran, after, errors: na.errors() };`);
    await t.shot("week-household.png", 1280, 900);
    const upkeep = await run(`
      ${P}
      await tab("Upkeep");
      const paid = big("Upkeep paid this year");
      await add("Paid for upkeep", '32.50 "smoke alarm batteries"');
      await na.sleep(500);
      const spend = (await kindRows("Spend", "spend")).filter((x) => x.note === "Upkeep: smoke alarm batteries");
      return { paid, after: big("Upkeep paid this year"), next: big("Next upkeep"), year: rowsOf("Upkeep in the next 12 months").length, last: rowsOf("Last done"), spend: spend.map((x) => [x.amount, x.category]), errors: na.errors() };`);
    await t.shot("week-household-upkeep.png", 1280, 900);
    await run(`${P} await tab("This week");`);
    const money = (x) => Number(String(x).replace(/[$,]/g, ""));
    expect(r.before.late.some((x) => x.includes("Test the smoke alarms | Alex")) && r.before.late.some((x) => x.includes("Take the bins out | Sam")) && r.before.overdue >= 2, r.before);
    expect(r.preview.some((x) => x.includes("Alex")) && r.vacuumed.done === r.before.done + 1 && r.vacuumed.settled >= 1, r);
    expect(r.ran.every(Boolean) && r.after.overdue === r.before.overdue - 2 && !r.after.late.some((x) => x.includes("Take the bins out") || x.includes("smoke alarms")) && r.errors === 0, r);
    expect(Math.abs(money(upkeep.after) - money(upkeep.paid) - 32.5) < 0.005 && JSON.stringify(upkeep.spend) === JSON.stringify([[32.5, "home"]]) && upkeep.year >= 8 && upkeep.last.some((x) => x.startsWith("smoke")) && upkeep.errors === 0, upkeep);
    return `overdue ${r.before.overdue} → ${r.after.overdue}; done this week ${r.before.done} → ${r.vacuumed.done}; upkeep paid ${upkeep.paid} → ${upkeep.after}; next: ${upkeep.next}`;
  });

  await check("on a phone, a number in an editable cell shows whole: Vitals' weights, the trip's costs", async () => {
    const { page } = t;
    // Obsidian's mobile layout pads inputs twice as wide as the desktop's; its class brings that in without reloading.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    try {
      const r = await run(`
        app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
        document.body.classList.add("is-mobile");
        const cut = {};
        for (const app of ["Vitals", "Trip planner", "Budget", "Trades"]) {
          await na.open("Apps/" + app);
          await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 6000);
          await na.sleep(600);
          const inputs = [...na.view().contentEl.querySelectorAll(".gz-table td.gz-num input.gz-edit")].filter((i) => i.value !== "");
          cut[app] = { cells: inputs.length, cut: inputs.filter((i) => i.scrollWidth > i.clientWidth + 1).map((i) => i.value) };
        }
        return cut;`);
      expect(r.Vitals.cells > 0 && Object.values(r).every((a) => a.cut.length === 0), r);
      return Object.entries(r).map(([app, a]) => `${app} ${a.cells} cells`).join(", ");
    } finally {
      await run(`document.body.classList.remove("is-mobile");`);
      await page.send("Emulation.clearDeviceMetricsOverride");
    }
  });

  await check("beside its facts, a headline's figure stays on one line: every gallery app at 1100 px with the file list open", async () => {
    const { page } = t;
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    try {
      const r = await run(`
        const APPS = ${JSON.stringify(APPS)};
        app.workspace.leftSplit.expand(); app.workspace.rightSplit.collapse();
        await na.sleep(300);
        const broken = {};
        for (const name of APPS) {
          await na.open("Apps/" + name);
          await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 6000);
          await na.sleep(600);
          for (const fig of na.view().contentEl.querySelectorAll(".gz-answer .gz-headline .gz-big.gz-fig")) {
            if (fig.getBoundingClientRect().height > parseFloat(getComputedStyle(fig).fontSize) * 1.4) broken[name] = fig.textContent;
          }
        }
        return { broken, pane: na.view().contentEl.clientWidth };`);
      expect(Object.keys(r.broken).length === 0, r);
      return `${APPS.length} apps in a ${r.pane} px pane`;
    } finally {
      await page.send("Emulation.clearDeviceMetricsOverride");
    }
  });

  await check("each ask's dot sits beside its text, on its first line: in the sidebar, and in the app's tab at phone width", async () => {
    const { page } = t;
    // An app of its own with a rhythm due later today, so there is an ask whatever earlier checks answered.
    const later = new Date(Date.now() + 90 * 60_000);
    const by = later.getDate() !== new Date().getDate() ? "23:59" : `${String(later.getHours()).padStart(2, "0")}:${String(later.getMinutes()).padStart(2, "0")}`;
    const APP = `---\napp: Dot check\npanels:\n  - {view: button, label: Watered the plants, save: water, shortcut: watered}\nexpect:\n  - {id: water, every: day, by: "${by}", source: water}\n---\n`;
    const dots = (root) => `[...${root}.querySelectorAll(".gz-asks li")].map((li) => {
      const what = li.querySelector(".gz-asks-what"), d = li.querySelector(".gz-status").getBoundingClientRect(), w = what.getBoundingClientRect();
      return d.right <= w.left && d.top >= w.top - 1 && d.bottom <= w.top + 2 * parseFloat(getComputedStyle(what).fontSize);
    })`;
    try {
      const side = await run(`
        await na.write("Apps/Dot check.md", ${JSON.stringify(APP)});
        await na.sleep(800);
        await na.open("Apps/Dot check");
        const bg = na.plugin().background;
        await bg.tick();
        await na.until(() => bg.asks.list().some((a) => a.app === "Dot check"), 6000);
        app.commands.executeCommandById("gizmo:open-sidebar");
        app.workspace.leftSplit.expand();
        const home = await na.until(() => document.querySelector(".workspace-leaf-content[data-type='gizmo-home'] .gz-home .gz-asks li") && document.querySelector(".workspace-leaf-content[data-type='gizmo-home'] .gz-home"), 4000);
        if (!home) return [];
        await na.sleep(400);
        return ${dots("home")};`);
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      const tab = await run(`
        app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
        await na.open("Apps/Dot check");
        const el = await na.until(() => na.view().contentEl.querySelector(".gz-asks li") && na.view().contentEl, 6000);
        if (!el) return { narrow: false, dots: [] };
        await na.sleep(400);
        return { narrow: !!el.querySelector(".gizmo.gz-narrow"), dots: ${dots("el")} };`);
      expect(side.length > 0 && side.every(Boolean), { side });
      expect(tab.narrow && tab.dots.length > 0 && tab.dots.every(Boolean), tab);
      return `${side.length} in the sidebar, ${tab.dots.length} in the app at 390 px`;
    } finally {
      await page.send("Emulation.clearDeviceMetricsOverride");
      await run(`await na.remove("Apps/Dot check.md"); await na.remove("Apps/Dot check data.md"); await na.plugin().background.tick();`);
    }
  });

  // Screenshots of every gallery app and kind, light and dark at desktop width, and at phone width.
  const shown = [...APPS.map((name) => `Apps/${name}`), ...KINDS.map((name) => `Kinds/${name}`)];
  for (const theme of ["light", "dark"]) {
    await t.theme(theme);
    for (const path of shown) {
      await run(`await na.open("${path}"); await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 6000); await na.sleep(600);`);
      await t.shot(`gallery-${path.split("/")[1].replace(/ /g, "-")}-${theme}.png`, 1280, 900);
    }
  }
  await run(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();`);
  for (const path of shown) {
    await run(`await na.open("${path}"); await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 6000); await na.sleep(600);`);
    await t.shot(`gallery-${path.split("/")[1].replace(/ /g, "-")}-phone.png`, 390, 844, 2);
  }
  // The other tabs of the apps that have them, at phone width, then light and dark at desktop width.
  const TABS = {
    "Medication log": ["Supply", "For the doctor"], "Bills and renewals": ["A year of bills", "Price changes", "Done"], Vitals: ["For the appointment"],
    Trades: ["Plan", "Watch", "Trades"], "Trip planner": ["Itinerary", "Spending", "Weather"], "Household chores": ["Upkeep"],
  };
  const showTab = (name, tab) => run(`await na.open("Apps/${name}"); await na.sleep(400); [...na.view().contentEl.querySelectorAll("button.gz-tab")].find((b) => b.textContent === "${tab}")?.click(); await na.sleep(700);`);
  for (const [name, tabs] of Object.entries(TABS)) for (const tab of tabs) {
    await showTab(name, tab);
    await t.shot(`gallery-${name.replace(/ /g, "-")}-${tab.replace(/ /g, "-")}-phone.png`, 390, 844, 2);
  }
  for (const theme of ["light", "dark"]) {
    await t.theme(theme);
    for (const [name, tabs] of Object.entries(TABS)) for (const tab of tabs) {
      await showTab(name, tab);
      await t.shot(`gallery-${name.replace(/ /g, "-")}-${tab.replace(/ /g, "-")}-${theme}.png`, 1280, 900);
    }
  }
  await run(`await na.openMd("Today.md", "live"); await na.sleep(800);`);
  await t.shot("gallery-Today-phone.png", 390, 844, 2);
  await t.theme("light");
  await run(`await na.openMd("Today.md", "live"); await na.sleep(800);`);
  await t.shot("gallery-Today-light.png", 1280, 900);
}
