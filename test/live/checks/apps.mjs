// Every fixture app opens; the first checks the smoke run ever had.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=5d&interval=1d";
const METEO = "https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m";
const NOAA = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
/** What each app fetches, so a failure while that API is down is a SKIP. */
export const NET = {
  AAPL: [YAHOO], Portfolio: [YAHOO], Movers: [YAHOO],
  Weather: [METEO], Currency: ["https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR", "https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR&from=2025-01-01&group=week"],
  "Planet Earth": ["https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson", NOAA,
    "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json", METEO],
  "Space weather": [NOAA], "Reading list": ["https://hnrss.org/frontpage", "https://xkcd.com/atom.xml"],
};

/** What each app asked for on its first open, by name; later checks read it. */
export const prompts = {};

/**
 * Page code for a check that opens a note's source: Edit source and an error's link open it in a split
 * beside the app, which stays. TABS takes the main area's tabs; CLOSE_OPENED closes those opened since,
 * so the next check starts in one pane.
 */
export const TABS = `const tabsBefore = []; app.workspace.iterateRootLeaves((l) => tabsBefore.push(l));`;
export const CLOSE_OPENED = `{ const opened = []; app.workspace.iterateRootLeaves((l) => { if (!tabsBefore.includes(l)) opened.push(l); }); for (const l of opened) l.detach(); await na.sleep(300); }`;

export default async function apps(t) {
  const { check, run, expect } = t;
  const appNotes = readdirSync(join(t.vault, "Apps")).filter((f) => f.endsWith(".md") && !f.endsWith(" data.md"));
  const before = Object.fromEntries(appNotes.map((f) => [f, readFileSync(join(t.vault, "Apps", f), "utf8")]));

  for (const f of appNotes) {
    const name = f.replace(/\.md$/, "");
    await check(`opens ${name}`, async () => {
      const r = await run(`const o = await na.open("Apps/${name}"); return { prompt: o.prompt, state: na.state(), errors: na.errors(), text: na.text() };`);
      prompts[name] = r.prompt;
      if (!r.state.startsWith("gizmo:")) throw new Error(`opened as ${r.state}`);
      if (name === "Broken") {
        if (!r.text.includes("keys have problems")) throw new Error("no problems card");
        if (!r.text.includes("[[Loop A]] → [[Loop B]] → [[Loop A]] uses itself")) throw new Error("no cycle message");
      } else if (name === "Describe only") {
        if (!r.text.includes("No panels yet")) throw new Error("no empty-state card");
      } else if (r.errors) {
        throw new Error(`${r.errors} error(s): ${r.text.slice(0, 160)}`);
      }
      return r.text.slice(0, 90);
    }, { net: NET[name] });
  }

  await check("Habits: streak, weekly bars and groups", async () => {
    const r = await run(`
      await na.open("Apps/Habits");
      const panel = (cls) => na.view().contentEl.querySelector(cls);
      const streak = () => panel(".gz-view-number .gz-big")?.textContent;
      const before = streak();
      const bars = panel(".gz-view-bar").querySelectorAll("path.gz-bar").length;
      const slices = panel(".gz-view-pie").querySelectorAll("path.gz-slice").length;
      const groups = [...panel(".gz-view-list").querySelectorAll("li")].map((li) => li.textContent).join(" | ");
      na.button("Stretched").click(); await na.sleep(1200);
      return { before, after: streak(), bars, slices, groups };`);
    if (r.before !== "0days" || r.after !== "1days") throw new Error(JSON.stringify(r));
    if (r.bars !== 3 || r.slices !== 3 || !r.groups.includes("good · 6 | stiff · 2 | sore · 1")) throw new Error(JSON.stringify(r));
    return `streak 0 → 1, ${r.bars} weekly bars, ${r.slices} slices`;
  });

  await check("Habits tabs switch without redrawing", async () => {
    const r = await run(`
      await na.open("Apps/Habits");
      const el = na.view().contentEl;
      const shown = () => [...el.querySelectorAll(".gz-panel")].filter((p) => p.offsetParent !== null).map((p) => p.className.split(" ")[1]);
      const pie = el.querySelector(".gz-view-pie");
      const first = shown();
      [...el.querySelectorAll("button.gz-tab")].find((b) => b.textContent === "Moods").click();
      await na.sleep(200);
      return { tabs: [...el.querySelectorAll("button.gz-tab")].map((b) => b.textContent), first, second: shown(), same: el.querySelector(".gz-view-pie") === pie };`);
    // Composed: the streak (the answer) comes before the button that adds to it, then the open tab.
    const want = { tabs: ["Weeks", "Moods", "Year"], first: ["gz-view-number", "gz-view-button", "gz-view-bar"], second: ["gz-view-number", "gz-view-button", "gz-view-pie", "gz-view-list"], same: true };
    if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(JSON.stringify(r));
    return "Weeks → Moods";
  });

  await check("Weather draws two series from one request", async () => {
    const r = await run(`
      await na.open("Apps/Weather");
      const chart = na.view().contentEl.querySelector(".gz-view-line");
      return { lines: chart.querySelectorAll("path.gz-line").length, legend: chart.querySelector(".gz-legend")?.innerText };`);
    if (r.lines !== 2 || !r.legend?.includes("Temperature") || !r.legend?.includes("Feels like")) throw new Error(JSON.stringify(r));
    return "2 lines and a legend";
  }, { net: NET.Weather });

  await check("Weather: asks for Open-Meteo and Daily; the week reads in words; I went for a walk logs it with its weather and a line in Daily; a note is added", async () => {
    expect(JSON.stringify([...(prompts.Weather ?? [])].sort()) === JSON.stringify(["Add lines to Daily.md", "Fetch data from api.open-meteo.com"]), prompts.Weather);
    const r = await run(`
      await na.open("Apps/Weather");
      const el = na.view().contentEl;
      const panel = (title) => [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
      const days = [...panel("The week ahead").querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td").textContent);
      const skies = [...panel("The week ahead").querySelectorAll("tbody tr")].map((tr) => tr.querySelectorAll("td")[1].textContent);
      const now = panel("Right now").querySelector("li");
      const shown = now.textContent;
      const mark = na.notices.length;
      na.button("I went for a walk", now).click();
      const walk = await na.until(() => na.fm("Apps/Weather data.md")?.walks?.[0], 3000);
      // Said under the panel whose row it was, with Undo, not as a notice.
      const notices = [await na.until(() => el.querySelector(".gz-notice-text")?.textContent, 3000)];
      await na.sleep(600);
      const daily = await na.read("Daily.md");
      const row = panel("My walks").querySelector("tbody tr");
      const cells = [...row.querySelectorAll("td")].slice(0, 2).map((td) => td.textContent);
      na.fill(row.querySelector("input"), "Round the park");
      const note = await na.until(() => na.fm("Apps/Weather data.md")?.walks?.[0]?.note, 3000);
      return { days, skies, shown, walk, notices, line: daily.split("\\n").find((l) => l.startsWith("- Walked in London: ")), cells, note, errors: na.errors() };`);
    const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const skies = ["clear", "partly cloudy", "overcast", "fog", "drizzle", "rain", "snow", "showers", "snow showers", "thunderstorm"];
    expect(r.days.length === 7 && r.days.every((d) => names.includes(d)) && r.skies.every((s) => skies.includes(s)), r);
    expect(r.walk && skies.includes(r.walk.sky) && typeof r.walk.temp === "number" && typeof r.walk.feels === "number" && r.notices.includes("Walk logged"), r);
    expect(r.line === `- Walked in London: ${r.walk.sky}, ${r.walk.temp}°C, feels like ${r.walk.feels}°C, wind ${r.walk.wind} km/h` && r.shown.endsWith("I went for a walk"), r);
    expect(r.cells[0] === "just now" && r.cells[1] === r.walk.sky && r.note === "Round the park" && r.errors === 0, r);
    return `${r.line}; week ${r.days[0]}–${r.days[6]}`;
  }, { net: NET.Weather });

  await check("Portfolio: asks only for Yahoo; picking a stock and a range redraws the Ticker; a buy recorded is held and worth something", async () => {
    expect(JSON.stringify(prompts.Portfolio) === JSON.stringify(["Fetch data from query1.finance.yahoo.com — for [[Ticker]]", "Send the picked holding's symbol to query1.finance.yahoo.com — for [[Ticker]]"]), prompts.Portfolio);
    const r = await run(`
      await na.open("Apps/Portfolio");
      const el = na.view().contentEl;
      const panel = (title) => [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
      const quiet = async () => { await na.sleep(300); await na.until(() => !el.querySelector(".gz-stale, .gz-loading"), 10000); await na.sleep(300); };
      const everything = panel("Everything I hold");
      na.choose(el.querySelector('select[aria-label="symbol"]'), "QQQ");
      await quiet();
      na.choose(el.querySelector('select[aria-label="range"]'), "1y");
      await quiet();
      const shown = {
        price: el.querySelector(".gz-view-number .gz-title")?.textContent,
        chart: el.querySelector(".gz-view-line .gz-title")?.textContent,
        lines: el.querySelectorAll(".gz-view-line path.gz-line").length,
        form: el.querySelector(".gz-view-form .gz-title")?.textContent,
        kept: panel("Everything I hold") === everything,
      };
      // Composed, the form is an add line: the date, then the numbers in the order of their fields.
      const form = el.querySelector(".gz-view-form");
      na.fill(form.querySelector(".gz-addline-input"), "2026-11-10 4 500");
      form.querySelector("button.gz-addline-go").click();
      await na.until(() => na.fm("Apps/Portfolio data.md")?.buys?.length, 3000);
      await quiet();
      const held = panel("What I hold").querySelector("tbody tr");
      const heldText = held?.innerText.replace(/\\s+/g, " ");
      held?.click();
      await quiet();
      return { shown, buys: na.fm("Apps/Portfolio data.md")?.buys, heldText, worth: panel("Worth now")?.querySelector(".gz-big")?.textContent, worthLabel: panel("Worth now")?.querySelector(".gz-label")?.textContent,
        // Written right after What I hold, it is that table's neighbour segment: shown once chosen.
        all: await (async () => {
          [...el.querySelectorAll(".gz-merged-bar button")].find((b) => b.textContent === "Everything I hold")?.click();
          await na.sleep(300);
          return [...panel("Everything I hold").querySelectorAll("tbody tr")].map((tr) => tr.innerText.replace(/\\s+/g, " "));
        })(), errors: na.errors() };`);
    expect(JSON.stringify(r.shown) === JSON.stringify({ price: "QQQ", chart: "QQQ, last 1y", lines: 1, form: "Record a buy of QQQ", kept: true }), r.shown);
    expect(JSON.stringify(r.buys?.map(({ at, ...b }) => b)) === JSON.stringify([{ symbol: "QQQ", date: "2026-11-10", shares: 4, price: 500 }]), r.buys);
    expect(r.heldText === "QQQ 4 $2,000.00" && /^\$\d{1,3}(,\d{3})*\.\d\d$/.test(r.worth ?? "") && r.worthLabel === "4 shares of QQQ at the last close" && r.all.includes("QQQ 4 $2,000.00") && r.errors === 0, r);
    await t.shot("portfolio-desktop.png", 1100, 760, 2);
    return `QQQ over 1y; held ${r.heldText}, worth ${r.worth}`;
  }, { net: NET.Portfolio });

  await check("Appointments: a day in the bar shows that day and keeps a half-typed booking; booking for tomorrow makes a note, pins it and tells me; Done writes the note", async () => {
    const want = ["Change properties of notes in Health", "Create notes in Health", "Read notes in Health"];
    expect(JSON.stringify([...(prompts.Appointments ?? [])].sort()) === JSON.stringify(want), prompts.Appointments);
    const r = await run(`
      await na.open("Apps/Appointments");
      const el = na.view().contentEl;
      const panel = (start) => [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent.startsWith(start));
      const items = (start) => [...panel(start).querySelectorAll("li:not(.gz-ledger-group)")].map((li) => li.textContent);
      // Composed, the form is an add line; half a booking typed in it stays while the day changes.
      const form = panel("Book an appointment");
      const line = form.querySelector(".gz-addline-input");
      na.fill(line, "Blood test");
      na.fill(el.querySelector('.gz-inputs input[type="date"]'), "2027-01-15");
      await na.until(() => panel("On ")?.querySelector(".gz-title").textContent === "On 2027-01-15" && !el.querySelector(".gz-stale"), 3000);
      await na.sleep(300);
      const picked = { title: panel("On ").querySelector(".gz-title").textContent, items: items("On "), typed: form.querySelector(".gz-addline-input").value };
      const d = new Date(); d.setDate(d.getDate() + 1);
      const tomorrow = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      na.fill(line, "Blood test " + tomorrow + ' who="Dr. Kim"');
      const mark = na.notices.length;
      form.querySelector("button.gz-addline-go").click();
      const note = "Health/Blood test " + tomorrow + ".md";
      const fm = await na.until(() => na.fm(note), 3000);
      // Its notify is said under the line, in place of a notice.
      const said = await na.until(() => form.querySelector(".gz-notice-text")?.textContent, 3000);
      const notices = await na.noticesSince(mark, "Next appointment", 5000);
      const pinned = await na.until(() => na.status().find((s) => s === "Next appointment: 1 day"), 3000);
      await na.sleep(500);
      const first = items("Coming up")[0];
      const row = [...panel("All appointments").querySelectorAll("tbody tr:not(.gz-ledger-group)")].find((tr) => tr.querySelector("td").textContent === "Blood test " + tomorrow);
      row.querySelector('input[type="checkbox"]').click();
      const done = await na.until(() => na.fm(note)?.done === true, 3000);
      await na.sleep(800);
      return { picked, tomorrow, fm, said, notices: notices.slice(0), pinned, first, done, after: items("Coming up"), errors: na.errors() };`);
    expect(JSON.stringify(r.picked) === JSON.stringify({ title: "On 2027-01-15", items: ["Eye exam with Dr. Patel"], typed: "Blood test" }), r.picked);
    expect(r.fm?.what === "Blood test" && r.fm?.date === r.tomorrow && r.fm?.who === "Dr. Kim" && r.fm?.at, r.fm);
    expect(r.said === `Booked Blood test on ${r.tomorrow}` && r.notices.includes("Appointments: Next appointment: 1 day") && r.pinned, r);
    expect(r.first === "tomorrow · Blood test with Dr. Kim" && r.done && !r.after.some((i) => i.includes("Blood test")) && r.errors === 0, r);
    return `${r.picked.items[0]} on ${r.picked.title.slice(3)}; booked for ${r.tomorrow}, told and pinned; ticked done`;
  });

  await check("Renewals: asks for nothing; two deadlines added, soonest first; one five days out tells me; ticking it done moves it to Done", async () => {
    expect(prompts.Renewals === undefined, prompts.Renewals);
    const r = await run(`
      await na.open("Apps/Renewals");
      const el = na.view().contentEl;
      const panel = (title) => [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
      const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      const empty = { next: panel("Next deadline").querySelector(".gz-big").textContent, coming: na.text(panel("Coming up")) };
      const form = panel("Add a deadline");
      // Composed, the form is an add line: the words are the deadline, the date is when it's due.
      const add = async (what, due) => {
        na.fill(form.querySelector(".gz-addline-input"), what + " " + due);
        form.querySelector("button.gz-addline-go").click();
        await na.until(() => na.fm("Apps/Renewals data.md")?.deadlines?.some((d) => d.what === what), 3000);
        await na.sleep(500);
      };
      const mark = na.notices.length;
      await add("Passport", day(100));
      await add("Car insurance", day(5));
      const notices = await na.noticesSince(mark, "Renewals: Coming up", 5000);
      const rows = () => [...panel("Coming up").querySelectorAll("tbody tr:not(.gz-ledger-group)")];
      const listed = rows().map((tr) => [tr.querySelector("td").textContent, tr.querySelector('input[type="date"]').value, tr.querySelectorAll("td")[2].textContent]);
      const next = panel("Next deadline").querySelector(".gz-big").textContent;
      rows()[0].querySelector('input[type="checkbox"]').click();
      await na.until(() => na.fm("Apps/Renewals data.md")?.deadlines?.find((d) => d.what === "Car insurance")?.done === true, 3000);
      await na.sleep(800);
      return { empty, notices, listed, next, days: [day(5), day(100)], after: rows().map((tr) => tr.querySelector("td").textContent),
        nextAfter: panel("Next deadline").querySelector(".gz-big").textContent, done: na.text(panel("Done")), errors: na.errors() };`);
    expect(r.empty.next === "—" && r.empty.coming.includes("Nothing logged yet."), r.empty);
    expect(JSON.stringify(r.listed) === JSON.stringify([["Car insurance", r.days[0], "5"], ["Passport", r.days[1], "100"]]) && r.next === "5 days", r);
    expect(r.notices.includes("Renewals: Coming up: Car insurance, Days left 5"), r.notices);
    expect(JSON.stringify(r.after) === '["Passport"]' && r.nextAfter === "100 days" && r.done.includes(`Car insurance, due ${r.days[0]}`) && r.errors === 0, r);
    return `told: ${r.notices.find((n) => n.startsWith("Renewals"))}; done moves it; next ${r.nextAfter}`;
  });

  await check("Currency: asks only for Frankfurter; a typed amount is converted; I sent it logs the transfer with its rate; a note is added; another currency redraws", async () => {
    expect(JSON.stringify(prompts.Currency) === JSON.stringify(["Fetch data from api.frankfurter.dev"]), prompts.Currency);
    await run(`
      await na.open("Apps/Currency");
      await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 8000);
      na.view().contentEl.querySelector('.gz-inputs input[aria-label="amount"]').focus();`);
    await t.type("100");
    await t.press("Enter");
    const r = await run(`
      const el = na.view().contentEl;
      const panel = (start) => [...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent.startsWith(start));
      const item = await na.until(() => panel("Converted")?.querySelector("li"), 8000);
      const shown = item?.textContent;
      const rate = Number(panel("1 USD in EUR").querySelector(".gz-big").textContent);
      const mark = na.notices.length;
      na.button("I sent it", item).click();
      const saved = await na.until(() => na.fm("Apps/Currency data.md")?.transfers?.[0], 3000);
      // Said under the panel whose row it was, with Undo, not as a notice.
      const notices = [await na.until(() => el.querySelector(".gz-notice-text")?.textContent, 3000)];
      await na.sleep(600);
      const row = panel("What I sent").querySelector("tbody tr");
      const cells = [...row.querySelectorAll("td")].slice(0, 6).map((td) => td.textContent);
      na.fill(row.querySelector("input"), "December rent");
      const note = await na.until(() => na.fm("Apps/Currency data.md")?.transfers?.[0]?.note, 3000);
      na.choose(el.querySelector('select[aria-label="want"]'), "GBP");
      await na.sleep(300);
      await na.until(() => !el.querySelector(".gz-stale, .gz-loading"), 8000);
      await na.sleep(300);
      return { shown, rate, saved, notices, cells, note, titles: [...el.querySelectorAll(".gz-panel .gz-title")].map((t) => t.textContent),
        after: panel("Converted")?.querySelector("li")?.textContent, lines: el.querySelectorAll(".gz-view-line path.gz-line").length, errors: na.errors() };`);
    const got = Math.round(100 * r.rate * 100) / 100;
    expect(r.shown === `100.00 USD is ${got.toFixed(2)} EUR at ${r.rate.toFixed(4)}I sent it`, r);
    expect(r.saved?.sent === 100 && r.saved.from === "USD" && r.saved.to === "EUR" && r.saved.got === got && /^\d{4}-\d\d-\d\d$/.test(r.saved.date) && r.notices.includes(`Logged 100 USD → ${got} EUR`), r);
    expect(r.cells[1] === "100.00" && r.cells[3] === got.toFixed(2) && r.note === "December rent", r);
    expect(r.titles.includes("1 USD in GBP") && r.titles.includes("USD in GBP, week by week since 2025") && /^100\.00 USD is [\d.,]+ GBP at /.test(r.after ?? "") && r.lines === 1 && r.errors === 0, r);
    return `${r.shown.replace("I sent it", "")}; logged; USD → GBP: ${r.after?.replace("I sent it", "")}`;
  }, { net: NET.Currency });

  await check("AAPL: a whole note from one component, its price pinned to the status bar", async () => {
    const r = await run(`
      await na.open("Apps/AAPL");
      const el = na.view().contentEl;
      const pinned = await na.until(() => na.status().find((s) => s.startsWith("AAPL: $")), 5000);
      return { description: el.querySelector(".gz-description")?.textContent, title: el.querySelector(".gz-view-number .gz-title")?.textContent,
        form: el.querySelector(".gz-view-form .gz-title")?.textContent, pinned, errors: na.errors() };`);
    expect(r.description === "Follow one stock, record what I buy of it, and see what my shares are worth" && r.title === "AAPL" && r.form === "Record a buy of AAPL" && r.pinned && !r.errors, r);
    expect(JSON.stringify(prompts.AAPL) === JSON.stringify(["Fetch data from query1.finance.yahoo.com — for [[Ticker]]", "Send the picked holding's symbol to query1.finance.yahoo.com — for [[Ticker]]"]), prompts.AAPL);
    return `description and panels from [[Ticker]]; status ${r.pinned}`;
  }, { net: NET.AAPL });

  // The fresh checks may have logged a dose already.
  const doses = () => run(`return na.fm("Apps/Meds data.md")?.doses?.length ?? 0;`);
  const medsBefore = await doses();
  await check("Meds button logs twice", async () => {
    const r = await run(`
      const lines = ((await na.read("Daily.md")).match(/Took meds/g) ?? []).length;
      await na.open("Apps/Meds");
      na.view().contentEl.querySelector("button.gz-button").click(); await na.sleep(800);
      na.view().contentEl.querySelector("button.gz-button").click(); await na.sleep(1200);
      return { text: na.text(), lines, after: ((await na.read("Daily.md")).match(/Took meds/g) ?? []).length };`);
    if (!r.text.includes(`Doses today | ${medsBefore + 2}`)) throw new Error(r.text);
    if (r.after !== r.lines + 2) throw new Error(JSON.stringify(r));
    return `count ${medsBefore} → ${medsBefore + 2}, two more lines in Daily`;
  });

  await check("Weight form saves a row", async () => {
    const r = await run(`
      await na.open("Apps/Weight");
      // Composed, the form is an add line.
      na.fill(na.view().contentEl.querySelector(".gz-addline-input"), "79.8");
      na.view().contentEl.querySelector(".gz-addline-go").click(); await na.sleep(1500);
      return na.text();`);
    if (!r.includes("Latest | 79.8")) throw new Error(r.slice(0, 200));
    return "latest 79.8";
  });

  await check("Packing checklist ticks", async () => {
    const r = await run(`
      await na.open("Apps/Packing");
      na.view().contentEl.querySelectorAll(".gz-checklist input")[0].click(); await na.sleep(800);
      na.view().contentEl.querySelectorAll(".gz-checklist input")[2].click(); await na.sleep(1000);
      return na.text();`);
    if (!r.includes("2/5")) throw new Error(r.slice(0, 120));
    return "2/5";
  });

  await check("Focus timer finishes and appends", async () => {
    const r = await run(`
      await na.open("Apps/Focus");
      na.button("Start").click(); await na.sleep(5000);
      return await na.read("Daily.md");`);
    if (!r.includes("Focus block done")) throw new Error(r);
    return "line added";
  });

  await check("typed form input survives a data change", async () => {
    const r = await run(`
      await na.open("Apps/Weight");
      const input = na.view().contentEl.querySelector(".gz-addline-input");
      na.fill(input, "77");
      const data = app.vault.getFileByPath("Apps/Weight data.md") ?? app.vault.getFileByPath("Apps/Weight.md");
      await app.fileManager.processFrontMatter(data, (fm) => { fm.weights = [...(fm.weights ?? []), { weight: 78, at: "2026-11-18T08:00" }]; });
      await na.sleep(1500);
      return na.view().contentEl.querySelector(".gz-addline-input")?.value;`);
    if (r !== "77") throw new Error(`input is now "${r}"`);
    return "kept 77";
  });

  await check("notes panel follows edits to the notes it reads", async () => {
    const r = await run(`
      await na.open("Apps/Appointments");
      await app.fileManager.processFrontMatter(app.vault.getFileByPath("Health/Dentist.md"), (fm) => { fm.date = "2026-12-20"; });
      await na.sleep(1500);
      const row = [...na.view().contentEl.querySelectorAll(".gz-view-table tbody tr:not(.gz-ledger-group)")].find((tr) => tr.querySelector("td").textContent === "Dentist");
      return row?.querySelector('input[type="date"]')?.value;`);
    if (r !== "2026-12-20") throw new Error(String(r));
    return "updated without reopening";
  });

  await check("navigation", async () => {
    const r = await run(`
      ${TABS}
      const out = [];
      await na.open("Daily"); out.push(na.state());
      await na.open("Apps/Portfolio"); out.push(na.state());
      app.commands.executeCommandById("app:go-back"); await na.sleep(800); out.push(na.state());
      await na.open("Apps/Packing");
      [...na.view().containerEl.querySelectorAll(".view-action")].find((a) => a.getAttribute("aria-label") === "Edit source").click();
      await na.sleep(800); out.push(na.state());
      app.commands.executeCommandById("gizmo:open-as-app"); await na.sleep(800); out.push(na.state());
      ${CLOSE_OPENED}
      return out;`);
    const want = ["markdown:Daily.md", "gizmo:Apps/Portfolio.md", "markdown:Daily.md", "markdown:Apps/Packing.md", "gizmo:Apps/Packing.md"];
    if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(JSON.stringify(r));
    return "links, back, Edit source, Open as app";
  });

  await check("plugin off and on keeps tabs", async () => {
    const r = await run(`
      await na.open("Apps/Weather");
      await app.plugins.disablePlugin("gizmo"); await na.sleep(800);
      const off = na.state();
      await app.plugins.enablePlugin("gizmo"); await na.sleep(1500);
      return [off, na.state(), na.text().slice(0, 60)];`);
    if (r[0] !== "markdown:Apps/Weather.md" || r[1] !== "gizmo:Apps/Weather.md" || !r[2].includes("London weather")) {
      throw new Error(JSON.stringify(r));
    }
    return "markdown while off, app again when on";
  });

  await check("app notes are never rewritten", async () => {
    const changed = appNotes.filter((f) => readFileSync(join(t.vault, "Apps", f), "utf8") !== before[f]);
    if (changed.length) throw new Error(`rewritten: ${changed.join(", ")}`);
    return `${appNotes.length} unchanged`;
  });

  await check("recorded data lives in data notes", async () => {
    const r = await run(`return { meds: na.fm("Apps/Meds data.md")?.doses?.length, weight: na.fm("Apps/Weight data.md")?.weights?.length, packing: na.fm("Apps/Packing data.md")?.packed };`);
    if (r.meds !== medsBefore + 2 || !(r.weight >= 6) || r.packing?.length !== 2) throw new Error(JSON.stringify(r));
    return JSON.stringify(r);
  });

  await check("renaming an app moves its data note", async () => {
    const r = await run(`
      await na.open("Apps/Meds");
      await app.fileManager.renameFile(app.vault.getFileByPath("Apps/Meds.md"), "Apps/Medication.md");
      await na.sleep(1200);
      const shown = na.state() + " " + na.text().slice(0, 30);
      const moved = na.fm("Apps/Medication data.md")?.doses?.length;
      const left = !!app.vault.getFileByPath("Apps/Meds data.md");
      await app.fileManager.renameFile(app.vault.getFileByPath("Apps/Medication.md"), "Apps/Meds.md");
      await na.sleep(1200);
      return { shown, moved, left, back: na.fm("Apps/Meds data.md")?.doses?.length };`);
    const n = medsBefore + 2;
    // The app's tab shows its title, the note's new name, above what it's for.
    if (!r.shown.startsWith("gizmo:Apps/Medication.md Medication | Log when") || r.moved !== n || r.left || r.back !== n) {
      throw new Error(JSON.stringify(r));
    }
    return "followed both renames";
  });

  await check("an app still draws after the steps above", async () => {
    const r = await run(`await na.open("Apps/Weather"); return na.text().slice(0, 60);`);
    if (!r.includes("London weather")) throw new Error(r);
    return "Weather";
  }, { net: NET.Weather });

  await check("a component opens as an app that shows how to use it", async () => {
    const r = await run(`
      await na.open("Components/Ticker");
      const el = na.view().contentEl;
      return { state: na.state(), usage: el.querySelector(".gz-example")?.textContent, text: na.text(), panels: el.querySelectorAll(".gz-panel").length };`);
    const usage = 'panels:\n  - use: "[[Ticker]]"\n    with: {symbol: …, range: 6mo}';
    if (r.state !== "gizmo:Components/Ticker.md" || r.usage !== usage || !r.text.includes("Give every param a default") || r.panels) {
      throw new Error(JSON.stringify(r));
    }
    return "usage shown, no preview without a symbol";
  });

  await check("editing a component asks again, naming it", async () => {
    const original = await run(`return await na.read("Components/Ticker.md");`);
    const r = await run(`
      await na.open("Apps/Portfolio");
      await app.fileManager.processFrontMatter(app.vault.getFileByPath("Components/Ticker.md"), (fm) => {
        fm.panels = [...fm.panels, { view: "text", text: "news", source: "https://news.example.org/v1/$symbol" }];
      });
      await na.sleep(1500);
      return [...na.view().contentEl.querySelectorAll(".gz-card li")].map((li) => li.textContent);`);
    // Put the component back, so later checks see Portfolio as it was allowed.
    await run(`await na.write("Components/Ticker.md", ${JSON.stringify(original)}); await na.sleep(500);`);
    expect(r.includes("NewFetch data from news.example.org — for [[Ticker]]") && r.includes("Fetch data from query1.finance.yahoo.com — for [[Ticker]]"), r);
    return "prompt names [[Ticker]], marks the new host";
  });

  await t.shot("weather-desktop.png", 1100, 760, 2);
  await run(`await na.open("Apps/Habits");`);
  await t.shot("habits-desktop.png", 1100, 760, 2);
  await run(`app.workspace.leftSplit.collapse(); await na.open("Apps/Weight");`);
  await t.shot("weight-phone.png", 420, 900, 2);
}
