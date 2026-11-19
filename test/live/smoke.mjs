// Live smoke test in an isolated Obsidian. Run `npm run build` first.
//   node test/live/smoke.mjs <empty work dir>
// Copies test/vault into the work dir, installs the built plugin, starts a separate Obsidian
// (user data in the work dir, CDP on CDP_PORT, default 9334), exercises every fixture app,
// takes screenshots, quits that instance and prints PASS/FAIL per check.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect } from "./cdp.mjs";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) {
  throw new Error("pass an empty or missing work directory");
}
const port = process.env.CDP_PORT ?? "9334";
const vault = join(work, "vault");
const userData = join(work, "userdata");
const pluginDir = join(vault, ".obsidian/plugins/note-apps");

mkdirSync(pluginDir, { recursive: true });
mkdirSync(userData, { recursive: true });
cpSync(join(repo, "test/vault"), vault, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, f), join(pluginDir, f));
writeFileSync(join(vault, ".obsidian/community-plugins.json"), '["note-apps"]');
writeFileSync(join(userData, "obsidian.json"), JSON.stringify({
  vaults: { c3d4e5f607182930: { path: vault, ts: Date.now(), open: true } },
}));
const appNotes = readdirSync(join(vault, "Apps")).filter((f) => f.endsWith(".md") && !f.endsWith(" data.md"));
const before = Object.fromEntries(appNotes.map((f) => [f, readFileSync(join(vault, "Apps", f), "utf8")]));

// The window sits in the background, where Chromium would otherwise slow timers to about one
// wake-up a minute after five minutes and stretch every wait in this script.
spawn("open", ["-g", "-n", "-a", "Obsidian", "--args", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`,
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Stops only the instance this run launched, found by its own user-data dir. */
const quit = () => {
  const pids = spawnSync("pgrep", ["-f", `user-data-dir=${userData}`]).stdout.toString().trim().split("\n").filter(Boolean);
  if (pids.length) spawnSync("kill", pids);
};
let page;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(1000);
  page = await connect(port, vault).catch(() => undefined);
}
if (!page) {
  quit();
  throw new Error(`the test Obsidian did not come up on port ${port} (is another instance using it?)`);
}

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message.split("\n")[0] });
  }
};
const run = (body) => page.evaluate(`(async () => { const na = window.__na; ${body} })()`);
/** A screenshot of the app. Obsidian's first-open "trust the author" dialog can arrive at any
 * point; plugins are already on, so it's accepted first. */
const shot = async (name, width, height) => {
  await run(`[...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins")?.click(); await na.sleep(300);`);
  await page.shot(join(work, name), width, height);
};

try {
  await page.evaluate(`(async () => {
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if (!app.plugins.plugins["note-apps"]) await app.plugins.enablePluginAndSave("note-apps");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const leaf = () => app.workspace.getMostRecentLeaf();
    const view = () => leaf().view;
    const settle = async () => {
      if (view().getViewType() !== "note-app") return sleep(300);
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const el = view().contentEl;
        if (el.querySelector(".note-app") && !el.querySelector(".na-loading")) break;
      }
      await sleep(200);
    };
    window.__na = {
      sleep, leaf, view, settle,
      text: () => view().contentEl.innerText.replace(/\\n+/g, " | "),
      errors: () => view().contentEl.querySelectorAll(".na-panel.na-error, .na-card.na-error").length,
      state: () => view().getViewType() + ":" + view().file?.path,
      open: async (path) => {
        await app.workspace.openLinkText(path, "", false);
        await settle();
        const allow = [...view().contentEl.querySelectorAll("button")].find((b) => b.textContent === "Allow");
        if (allow) {
          allow.click();
          for (let i = 0; i < 50 && [...view().contentEl.querySelectorAll("button")].some((b) => b.textContent === "Allow"); i++) await sleep(100);
          await settle();
        }
      },
      button: (label) => [...view().contentEl.querySelectorAll("button")].find((b) => b.textContent === label),
      read: (path) => app.vault.read(app.vault.getFileByPath(path)),
      fm: (path) => { const f = app.vault.getFileByPath(path); return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined; },
    };
    await sleep(1000);
  })()`);

  for (const f of appNotes) {
    const name = f.replace(/\.md$/, "");
    await check(`opens ${name}`, async () => {
      const r = await run(`await na.open("Apps/${name}"); return { state: na.state(), errors: na.errors(), text: na.text() };`);
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
    });
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
    const want = { tabs: ["Weeks", "Moods"], first: ["na-view-button", "na-view-number", "na-view-bar"], second: ["na-view-button", "na-view-number", "na-view-pie", "na-view-list"], same: true };
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
  });

  await check("Stocks: a choice redraws its panels and keeps typed text", async () => {
    const r = await run(`
      await na.open("Apps/Stocks");
      const el = na.view().contentEl;
      const input = el.querySelector(".na-form input");
      input.value = "watch";
      const select = el.querySelector('select[aria-label="symbol"]');
      select.value = "1";
      select.dispatchEvent(new Event("change"));
      for (let i = 0; i < 50 && el.querySelector(".na-stale, .na-loading"); i++) await na.sleep(100);
      await na.sleep(300);
      return {
        title: el.querySelector(".na-view-number .na-title")?.textContent,
        typed: el.querySelector(".na-form input")?.value,
        chart: el.querySelector(".na-view-line .na-title")?.textContent,
        lines: el.querySelectorAll(".na-view-line path.na-line").length,
        errors: na.errors(),
      };`);
    if (r.title !== "QQQ" || r.typed !== "watch" || r.chart !== "QQQ, last 6mo" || r.lines !== 1 || r.errors) throw new Error(JSON.stringify(r));
    return "SPY → QQQ, typed text kept";
  });

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

  await check("Watchlist: Ticker twice, in tabs, sharing an input", async () => {
    const r = await run(`
      await na.open("Apps/Watchlist");
      const el = na.view().contentEl;
      const titles = (cls) => [...el.querySelectorAll(cls + " .na-title")].map((t) => t.textContent);
      const before = titles(".na-view-number");
      const select = el.querySelector('select[aria-label="range"]');
      select.value = "1";
      select.dispatchEvent(new Event("change"));
      for (let i = 0; i < 50 && el.querySelector(".na-stale, .na-loading"); i++) await na.sleep(100);
      await na.sleep(300);
      return { tabs: [...el.querySelectorAll("button.na-tab")].map((b) => b.textContent), before, charts: titles(".na-view-line"), errors: na.errors() };`);
    const want = { tabs: ["Index", "Apple"], before: ["SPY", "AAPL"], charts: ["SPY, last 1y", "AAPL, last 1y"], errors: 0 };
    if (JSON.stringify(r) !== JSON.stringify(want)) throw new Error(JSON.stringify(r));
    await shot("watchlist-desktop.png", 1100, 760);
    return "2 uses, range 6mo → 1y";
  });

  await check("AAPL: a whole note from one component", async () => {
    const r = await run(`
      await na.open("Apps/AAPL");
      const el = na.view().contentEl;
      return { description: el.querySelector(".na-description")?.textContent, title: el.querySelector(".na-view-number .na-title")?.textContent, errors: na.errors() };`);
    if (r.description !== "Price and chart for one stock" || r.title !== "AAPL" || r.errors) throw new Error(JSON.stringify(r));
    return "description and panels from [[Ticker]]";
  });

  await check("Meds button logs twice", async () => {
    const r = await run(`
      await na.open("Apps/Meds");
      na.view().contentEl.querySelector("button.na-button").click(); await na.sleep(800);
      na.view().contentEl.querySelector("button.na-button").click(); await na.sleep(1200);
      return { text: na.text(), daily: await na.read("Daily.md") };`);
    if (!r.text.includes("Doses today | 2")) throw new Error(r.text);
    if ((r.daily.match(/Took meds/g) ?? []).length !== 2) throw new Error(r.daily);
    return "count 2, two lines in Daily";
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
      await na.open("Apps/SPY"); out.push(na.state());
      app.commands.executeCommandById("app:go-back"); await na.sleep(800); out.push(na.state());
      await na.open("Apps/Packing");
      [...na.view().containerEl.querySelectorAll(".view-action")].find((a) => a.getAttribute("aria-label") === "Edit source").click();
      await na.sleep(800); out.push(na.state());
      app.commands.executeCommandById("note-apps:open-as-app"); await na.sleep(800); out.push(na.state());
      return out;`);
    const want = ["markdown:Daily.md", "note-app:Apps/SPY.md", "markdown:Daily.md", "markdown:Apps/Packing.md", "note-app:Apps/Packing.md"];
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
    const changed = appNotes.filter((f) => readFileSync(join(vault, "Apps", f), "utf8") !== before[f]);
    if (changed.length) throw new Error(`rewritten: ${changed.join(", ")}`);
    return `${appNotes.length} unchanged`;
  });

  await check("recorded data lives in data notes", async () => {
    const r = await run(`return { meds: na.fm("Apps/Meds data.md")?.doses?.length, weight: na.fm("Apps/Weight data.md")?.weights?.length, packing: na.fm("Apps/Packing data.md")?.packed };`);
    if (r.meds !== 2 || !(r.weight >= 6) || r.packing?.length !== 2) throw new Error(JSON.stringify(r));
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
    if (!r.shown.startsWith("note-app:Apps/Medication.md Log when") || r.moved !== 2 || r.left || r.back !== 2) {
      throw new Error(JSON.stringify(r));
    }
    return "followed both renames";
  });

  await check("an app still draws after the steps above", async () => {
    const r = await run(`await na.open("Apps/Weather"); return na.text().slice(0, 60);`);
    if (!r.includes("London weather")) throw new Error(r);
    return "Weather";
  });
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
    const r = await run(`
      await na.open("Apps/Watchlist");
      await app.fileManager.processFrontMatter(app.vault.getFileByPath("Components/Ticker.md"), (fm) => {
        fm.panels = [...fm.panels, { view: "text", text: "news", source: "https://news.example.org/v1/$symbol" }];
      });
      await na.sleep(1500);
      return [...na.view().contentEl.querySelectorAll(".na-card li")].map((li) => li.textContent);`);
    if (!r.includes("NewFetch data from news.example.org — for [[Ticker]]") || !r.includes("Fetch data from query1.finance.yahoo.com — for [[Ticker]]")) {
      throw new Error(JSON.stringify(r));
    }
    return "prompt names [[Ticker]], marks the new host";
  });

  await shot("weather-desktop.png", 1100, 760);
  await run(`await na.open("Apps/Habits");`);
  await shot("habits-desktop.png", 1100, 760);
  await run(`await na.open("Apps/Stocks"); await na.sleep(1500);`);
  await shot("stocks-desktop.png", 1100, 760);
  await run(`app.workspace.leftSplit.collapse(); await na.open("Apps/Weight");`);
  await shot("weight-phone.png", 420, 900);
  await run(`await na.open("Apps/Habits");`);
  await shot("habits-phone.png", 420, 900);
} finally {
  page.close();
  quit();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed; screenshots in ${work}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
