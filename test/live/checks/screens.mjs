// Screenshots of every fixture app and of the new views, light and dark, and at phone width; and
// a check that nothing makes the pane scroll sideways (a table or a board scrolls inside itself).
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** In the page: how far the active view's content is wider than the view, and which panels are. */
const OVERFLOW = `(() => {
  const ce = na.view().contentEl;
  const wide = [...ce.querySelectorAll(".gz-panel, .gz-lens, .gz-embed")].filter((p) => p.getBoundingClientRect().right > ce.getBoundingClientRect().right + 1);
  return { over: ce.scrollWidth - ce.clientWidth, wide: wide.map((p) => p.className.split(" ").slice(0, 2).join(".")) };
})()`;

export default async function screens(t) {
  const { check, run, expect, page } = t;
  const apps = readdirSync(join(t.vault, "Apps")).filter((f) => f.endsWith(".md") && !f.endsWith(" data.md")).map((f) => f.replace(/\.md$/, ""));
  const name = (s) => s.replace(/[ /]/g, "-");
  const open = (path) => run(`await na.open(${JSON.stringify(path)}); await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 6000); await na.sleep(500);`);

  await check("no fixture app makes its pane scroll sideways, at 1100 px or at phone width", async () => {
    const bad = [];
    for (const [width, height] of [[1100, 760], [390, 844]]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      try {
        await run(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();`);
        for (const app of apps) {
          await open(`Apps/${app}`);
          const r = await run(`return ${OVERFLOW};`);
          if (r.over > 1 || r.wide.length) bad.push(`${app} at ${width}: ${r.over} px ${r.wide.join(", ")}`);
        }
      } finally {
        await page.send("Emulation.clearDeviceMetricsOverride");
      }
    }
    expect(!bad.length, bad);
    return `${apps.length} apps at 1100 and 390 px`;
  });

  // Each app, and the new views where they live, in both themes.
  const views = [
    ["Today-reading", `await na.openMd("Today.md", "preview");`],
    ["Today-live", `await na.openMd("Today.md", "live");`],
    ["Dune-lens-live", `await na.openMd("Books/Dune.md", "live");`],
    ["Dune-lens-reading", `await na.openMd("Books/Dune.md", "preview");`],
    ["Habits-year", `await na.open("Apps/Habits"); [...na.view().contentEl.querySelectorAll("button.gz-tab")].find((b) => b.textContent === "Year").click();`],
    ["Projects-picked", `await na.open("Apps/Projects"); if (!na.view().contentEl.querySelector(".gz-tl-bar.gz-selected")) na.view().contentEl.querySelector(".gz-tl-bar")?.click();`],
    ["Planet-Earth-inspector", `await na.open("Apps/Planet Earth"); if (!na.view().contentEl.querySelector(".gz-inspector")) na.menuItem("Inspect data"); await na.sleep(2000);`],
    ["Plants-cards", `await na.open("Scratch/Plants");`],
    ["Journal-calendar", `await na.open("Scratch/Journal"); if (!na.view().contentEl.querySelector(".gz-cal-day.gz-selected")) na.view().contentEl.querySelector('.gz-cal-day[data-date$="-09"]')?.click();`],
  ];
  await run(`app.workspace.leftSplit.expand();`);
  for (const theme of ["light", "dark"]) {
    await t.theme(theme);
    for (const app of apps) {
      await open(`Apps/${app}`);
      await t.shot(`vault-${name(app)}-${theme}.png`);
    }
    for (const [label, body] of views) {
      await run(`${body} await na.sleep(800);`);
      await t.shot(`view-${label}-${theme}.png`);
    }
  }
  await run(`app.workspace.leftSplit.collapse();`);
  for (const [label, body] of views) {
    await run(`${body} await na.sleep(800);`);
    await t.shot(`view-${label}-phone.png`, 390, 844, 2);
  }
  await t.theme("dark");
  await run(`app.workspace.leftSplit.expand();`);
}
