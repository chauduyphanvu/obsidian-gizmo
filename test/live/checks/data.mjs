// Core data: chains, formulas, block errors.
import { NET } from "./apps.mjs";

const LOOP = `---
app: A loop of blocks
data:
  a:
    source: b
  b:
    source: a
panels:
  - view: number
    title: Count
    source: a
---
`;

const TYPO = `---
app: Weekly totals, with a typo in a formula
data:
  spend:
    source: spend
panels:
  - view: number
    title: Total
    source: spend
    field: amount
    agg: sum
  - view: table
    title: Rows
    source: spend
    compute:
      x: "foo(amount)"
spend:
  - {amount: 4, at: 2026-11-01T09:00}
  - {amount: 6, at: 2026-11-02T09:00}
---
`;

export default async function data(t) {
  const { check, run, expect } = t;

  await check("Movers: a signed % value, ~60 bars with some negative, a 5-row table", async () => {
    const r = await run(`
      await na.open("Apps/Movers");
      const el = na.view().contentEl;
      const bars = [...el.querySelectorAll(".na-view-bar path.na-bar")];
      // A bar is drawn from the zero line: down (a larger y) for a negative value.
      const negative = bars.filter((b) => { const m = b.getAttribute("d").match(/^M[\\d.]+,([\\d.]+)V([\\d.]+)/); return m && Number(m[2]) > Number(m[1]); }).length;
      return { errors: na.errors(), last: el.querySelector(".na-view-number .na-big")?.textContent, bars: bars.length, negative, rows: el.querySelectorAll(".na-view-table tbody tr").length };`);
    expect(r.errors === 0 && /^-?\d+\.\d\d%$/.test(r.last) && r.bars >= 55 && r.bars <= 70 && r.negative > 0 && r.negative < r.bars && r.rows === 5, r);
    return `last ${r.last}, ${r.bars} bars (${r.negative} negative), ${r.rows} rows`;
  }, { net: NET.Movers });

  await check("Movers: choosing AAPL reloads every panel from exactly one new request", async () => {
    const r = await run(`
      await na.open("Apps/Movers");
      const el = na.view().contentEl;
      const host = na.plugin().dataLayer.host;
      const fetch = host.fetch;
      const urls = [];
      host.fetch = (url, ...rest) => { urls.push(url); return fetch.call(host, url, ...rest); };
      try {
        na.choose(el.querySelector('select[aria-label="symbol"]'), "2");
        await na.sleep(300);
        await na.until(() => !el.querySelector(".na-stale, .na-loading"), 8000);
        await na.sleep(500);
      } finally {
        host.fetch = fetch;
      }
      return { urls, title: el.querySelector(".na-view-number .na-title")?.textContent, stale: el.querySelectorAll(".na-stale").length, errors: na.errors() };`);
    expect(r.urls.length === 1 && r.urls[0].includes("/chart/AAPL?") && r.title === "AAPL, last session" && r.stale === 0 && r.errors === 0, r);
    return `${r.urls.length} request: ${r.urls[0]}`;
  }, { net: NET.Movers });

  await check("blocks that read each other: the problems card names the loop", async () => {
    const r = await run(`
      await na.write("Scratch/Loop.md", ${JSON.stringify(LOOP)});
      await na.sleep(800);
      await na.open("Scratch/Loop");
      return na.text();`);
    expect(r.includes("This app's keys have problems") && r.includes("data.a → data.b → data.a use each other"), r);
    return "data.a → data.b → data.a use each other";
  });

  await check("a compute typo is a problem on its panel, and the other panels still draw", async () => {
    const r = await run(`
      await na.write("Scratch/Typo.md", ${JSON.stringify(TYPO)});
      await na.sleep(800);
      await na.open("Scratch/Typo");
      const el = na.view().contentEl;
      return { problems: [...el.querySelectorAll(".na-card.na-error li")].map((li) => li.textContent), total: el.querySelector(".na-view-number .na-big")?.textContent, panels: el.querySelectorAll(".na-panel").length };`);
    expect(r.problems.includes('panel 2: compute.x: unknown function "foo"') && r.total === "10", r);
    return `${r.problems.join("; ")}; Total still ${r.total}`;
  });
}
