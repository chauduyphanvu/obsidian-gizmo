// Every fixture app opens; the first checks the smoke run ever had.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=5d&interval=1d";
const METEO = "https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m";
const NOAA = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
/** What each app fetches, so a failure while that API is down is a SKIP. */
export const NET = {
  AAPL: [YAHOO], Portfolio: [YAHOO], Movers: [YAHOO],
  Weather: [METEO], "USD-EUR": ["https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR"],
  "Planet Earth": ["https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson", NOAA,
    "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json", METEO,
    "https://archive-api.open-meteo.com/v1/archive?latitude=39.95&longitude=-75.17&start_date=2025-11-01&end_date=2025-11-02&daily=temperature_2m_max"],
  "Space weather": [NOAA], "Reading list": ["https://hnrss.org/frontpage", "https://xkcd.com/atom.xml"],
};

/** What each app asked for on its first open, by name; later checks read it. */
export const prompts = {};

export default async function apps(t) {
  const { check, run, expect } = t;
  const appNotes = readdirSync(join(t.vault, "Apps")).filter((f) => f.endsWith(".md") && !f.endsWith(" data.md"));
  const before = Object.fromEntries(appNotes.map((f) => [f, readFileSync(join(t.vault, "Apps", f), "utf8")]));

  for (const f of appNotes) {
    const name = f.replace(/\.md$/, "");
    await check(`opens ${name}`, async () => {
      const r = await run(`const o = await na.open("Apps/${name}"); return { prompt: o.prompt, state: na.state(), errors: na.errors(), text: na.text() };`);
      prompts[name] = r.prompt;
      if (!r.state.startsWith("note-app:")) throw new Error(`opened as ${r.state}`);
      if (name === "Broken") {
        if (!r.text.includes("keys have problems")) throw new Error("no problems card");
        if (!r.text.includes("[[Loop A]] → [[Loop B]] → [[Loop A]] uses itself")) throw new Error("no cycle message");
      } else if (name === "Describe only") {
        if (!r.text.includes("No app keys yet")) throw new Error("no empty-state card");
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
      const streak = () => panel(".na-view-number .na-big")?.textContent;
      const before = streak();
      const bars = panel(".na-view-bar").querySelectorAll("path.na-bar").length;
      const slices = panel(".na-view-pie").querySelectorAll("path.na-slice").length;
      const groups = [...panel(".na-view-list").querySelectorAll("li")].map((li) => li.textContent).join(" | ");
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
      const shown = () => [...el.querySelectorAll(".na-panel")].filter((p) => p.offsetParent !== null).map((p) => p.className.split(" ")[1]);
      const pie = el.querySelector(".na-view-pie");
      const first = shown();
      [...el.querySelectorAll("button.na-tab")].find((b) => b.textContent === "Moods").click();
      await na.sleep(200);
      return { tabs: [...el.querySelectorAll("button.na-tab")].map((b) => b.textContent), first, second: shown(), same: el.querySelector(".na-view-pie") === pie };`);
    const want = { tabs: ["Weeks", "Moods", "Year"], first: ["na-view-button", "na-view-number", "na-view-bar"], second: ["na-view-button", "na-view-number", "na-view-pie", "na-view-list"], same: true };
    if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(JSON.stringify(r));
    return "Weeks → Moods";
  });

  await check("Weather draws two series from one request", async () => {
    const r = await run(`
      await na.open("Apps/Weather");
      const chart = na.view().contentEl.querySelector(".na-view-line");
      return { lines: chart.querySelectorAll("path.na-line").length, legend: chart.querySelector(".na-legend")?.innerText };`);
    if (r.lines !== 2 || !r.legend?.includes("apparent_temperature")) throw new Error(JSON.stringify(r));
    return "2 lines and a legend";
  }, { net: NET.Weather });

  await check("Portfolio: asks only for Yahoo; picking a stock and a range redraws the Ticker; a buy recorded is held and worth something", async () => {
    expect(JSON.stringify(prompts.Portfolio) === JSON.stringify(["Fetch data from query1.finance.yahoo.com — for [[Ticker]]"]), prompts.Portfolio);
    const r = await run(`
      await na.open("Apps/Portfolio");
      const el = na.view().contentEl;
      const panel = (title) => [...el.querySelectorAll(".na-panel")].find((p) => p.querySelector(".na-title")?.textContent === title);
      const quiet = async () => { await na.sleep(300); await na.until(() => !el.querySelector(".na-stale, .na-loading"), 10000); await na.sleep(300); };
      const everything = panel("Everything I hold");
      na.choose(el.querySelector('select[aria-label="symbol"]'), "QQQ");
      await quiet();
      na.choose(el.querySelector('select[aria-label="range"]'), "1y");
      await quiet();
      const shown = {
        price: el.querySelector(".na-view-number .na-title")?.textContent,
        chart: el.querySelector(".na-view-line .na-title")?.textContent,
        lines: el.querySelectorAll(".na-view-line path.na-line").length,
        form: el.querySelector(".na-view-form .na-title")?.textContent,
        kept: panel("Everything I hold") === everything,
      };
      const form = el.querySelector(".na-view-form");
      const [date, shares, price] = form.querySelectorAll("input");
      na.fill(date, "2026-11-10"); na.fill(shares, "4"); na.fill(price, "500");
      na.button("Record", form).click();
      await na.until(() => na.fm("Apps/Portfolio data.md")?.buys?.length, 3000);
      await quiet();
      const held = panel("What I hold").querySelector("tbody tr");
      const heldText = held?.innerText.replace(/\\s+/g, " ");
      held?.click();
      await quiet();
      return { shown, buys: na.fm("Apps/Portfolio data.md")?.buys, heldText, worth: panel("QQQ is worth")?.querySelector(".na-big")?.textContent,
        all: [...panel("Everything I hold").querySelectorAll("tbody tr")].map((tr) => tr.innerText.replace(/\\s+/g, " ")), errors: na.errors() };`);
    expect(JSON.stringify(r.shown) === JSON.stringify({ price: "QQQ", chart: "QQQ, last 1y", lines: 1, form: "Record a buy of QQQ", kept: true }), r.shown);
    expect(JSON.stringify(r.buys?.map(({ at, ...b }) => b)) === JSON.stringify([{ symbol: "QQQ", date: "2026-11-10", shares: 4, price: 500 }]), r.buys);
    expect(r.heldText === "QQQ 4 $2,000.00" && /^\$\d{1,3}(,\d{3})*\.\d\d$/.test(r.worth ?? "") && r.all.includes("QQQ 4 $2,000.00") && r.errors === 0, r);
    await t.shot("portfolio-desktop.png", 1100, 760, 2);
    return `QQQ over 1y; held ${r.heldText}, worth ${r.worth}`;
  }, { net: NET.Portfolio });

  await check("Day: the date bar picks the notes", async () => {
    const r = await run(`
      await na.open("Apps/Day");
      const el = na.view().contentEl;
      const date = el.querySelector('.na-inputs input[type="date"]');
      date.value = "2027-01-15";
      date.dispatchEvent(new Event("change"));
      await na.sleep(800);
      return { title: el.querySelector(".na-view-list .na-title")?.textContent, items: [...el.querySelectorAll(".na-view-list li")].map((li) => li.textContent) };`);
    if (r.title !== "On 2027-01-15" || JSON.stringify(r.items) !== JSON.stringify(["Eye exam (Dr. Patel)"])) throw new Error(JSON.stringify(r));
    return "2027-01-15 → Eye exam";
  });

  await check("AAPL: a whole note from one component, its price pinned to the status bar", async () => {
    const r = await run(`
      await na.open("Apps/AAPL");
      const el = na.view().contentEl;
      const pinned = await na.until(() => na.status().find((s) => s.startsWith("AAPL: $")), 5000);
      return { description: el.querySelector(".na-description")?.textContent, title: el.querySelector(".na-view-number .na-title")?.textContent,
        form: el.querySelector(".na-view-form .na-title")?.textContent, pinned, errors: na.errors() };`);
    expect(r.description === "Follow one stock, record what I buy of it, and see what my shares are worth" && r.title === "AAPL" && r.form === "Record a buy of AAPL" && r.pinned && !r.errors, r);
    expect(JSON.stringify(prompts.AAPL) === JSON.stringify(["Fetch data from query1.finance.yahoo.com — for [[Ticker]]"]), prompts.AAPL);
    return `description and panels from [[Ticker]]; status ${r.pinned}`;
  }, { net: NET.AAPL });

  // The fresh checks may have logged a dose already.
  const doses = () => run(`return na.fm("Apps/Meds data.md")?.doses?.length ?? 0;`);
  const medsBefore = await doses();
  await check("Meds button logs twice", async () => {
    const r = await run(`
      const lines = ((await na.read("Daily.md")).match(/Took meds/g) ?? []).length;
      await na.open("Apps/Meds");
      na.view().contentEl.querySelector("button.na-button").click(); await na.sleep(800);
      na.view().contentEl.querySelector("button.na-button").click(); await na.sleep(1200);
      return { text: na.text(), lines, after: ((await na.read("Daily.md")).match(/Took meds/g) ?? []).length };`);
    if (!r.text.includes(`Doses today | ${medsBefore + 2}`)) throw new Error(r.text);
    if (r.after !== r.lines + 2) throw new Error(JSON.stringify(r));
    return `count ${medsBefore} → ${medsBefore + 2}, two more lines in Daily`;
  });

  await check("Weight form saves a row", async () => {
    const r = await run(`
      await na.open("Apps/Weight");
      const input = na.view().contentEl.querySelector(".na-form input");
      input.value = "79.8";
      na.view().contentEl.querySelector(".na-form button").click(); await na.sleep(1500);
      return na.text();`);
    if (!r.includes("Latest | 79.8")) throw new Error(r.slice(0, 200));
    return "latest 79.8";
  });

  await check("Packing checklist ticks", async () => {
    const r = await run(`
      await na.open("Apps/Packing");
      na.view().contentEl.querySelectorAll(".na-checklist input")[0].click(); await na.sleep(800);
      na.view().contentEl.querySelectorAll(".na-checklist input")[2].click(); await na.sleep(1000);
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
      const input = na.view().contentEl.querySelector(".na-form input");
      input.value = "77";
      const data = app.vault.getFileByPath("Apps/Weight data.md") ?? app.vault.getFileByPath("Apps/Weight.md");
      await app.fileManager.processFrontMatter(data, (fm) => { fm.weights = [...(fm.weights ?? []), { weight: 78, at: "2026-11-18T08:00" }]; });
      await na.sleep(1500);
      return na.view().contentEl.querySelector(".na-form input")?.value;`);
    if (r !== "77") throw new Error(`input is now "${r}"`);
    return "kept 77";
  });

  await check("notes panel follows edits to the notes it reads", async () => {
    const r = await run(`
      await na.open("Apps/Appointments");
      await app.fileManager.processFrontMatter(app.vault.getFileByPath("Health/Dentist.md"), (fm) => { fm.date = "2026-12-20"; });
      await na.sleep(1500);
      return na.text();`);
    if (!r.includes("2026-12-20")) throw new Error(r.slice(0, 160));
    return "updated without reopening";
  });

  await check("navigation", async () => {
    const r = await run(`
      const out = [];
      await na.open("Daily"); out.push(na.state());
      await na.open("Apps/Portfolio"); out.push(na.state());
      app.commands.executeCommandById("app:go-back"); await na.sleep(800); out.push(na.state());
      await na.open("Apps/Packing");
      [...na.view().containerEl.querySelectorAll(".view-action")].find((a) => a.getAttribute("aria-label") === "Edit source").click();
      await na.sleep(800); out.push(na.state());
      app.commands.executeCommandById("note-apps:open-as-app"); await na.sleep(800); out.push(na.state());
      return out;`);
    const want = ["markdown:Daily.md", "note-app:Apps/Portfolio.md", "markdown:Daily.md", "markdown:Apps/Packing.md", "note-app:Apps/Packing.md"];
    if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(JSON.stringify(r));
    return "links, back, Edit source, Open as app";
  });

  await check("plugin off and on keeps tabs", async () => {
    const r = await run(`
      await na.open("Apps/Weather");
      await app.plugins.disablePlugin("note-apps"); await na.sleep(800);
      const off = na.state();
      await app.plugins.enablePlugin("note-apps"); await na.sleep(1500);
      return [off, na.state(), na.text().slice(0, 60)];`);
    if (r[0] !== "markdown:Apps/Weather.md" || r[1] !== "note-app:Apps/Weather.md" || !r[2].includes("London weather")) {
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
      const shown = na.state() + " " + na.text().slice(0, 20);
      const moved = na.fm("Apps/Medication data.md")?.doses?.length;
      const left = !!app.vault.getFileByPath("Apps/Meds data.md");
      await app.fileManager.renameFile(app.vault.getFileByPath("Apps/Medication.md"), "Apps/Meds.md");
      await na.sleep(1200);
      return { shown, moved, left, back: na.fm("Apps/Meds data.md")?.doses?.length };`);
    const n = medsBefore + 2;
    if (!r.shown.startsWith("note-app:Apps/Medication.md Log when") || r.moved !== n || r.left || r.back !== n) {
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
      return { state: na.state(), usage: el.querySelector(".na-example")?.textContent, text: na.text(), panels: el.querySelectorAll(".na-panel").length };`);
    const usage = 'panels:\n  - use: "[[Ticker]]"\n    with: {symbol: …, range: 6mo}';
    if (r.state !== "note-app:Components/Ticker.md" || r.usage !== usage || !r.text.includes("Give every param a default") || r.panels) {
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
      return [...na.view().contentEl.querySelectorAll(".na-card li")].map((li) => li.textContent);`);
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
