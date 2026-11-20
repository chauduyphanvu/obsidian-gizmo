// Background: commands, links, status bar, record, disk cache, alerts.
import { NET } from "./apps.mjs";

const SHORTCUT = `---
app: Log a cup of coffee from anywhere
view: button
label: Had a coffee
save: coffees
notify: Coffee logged
shortcut: coffee
---
`;

export default async function background(t) {
  const { check, run, expect, page } = t;

  await check("Meds: its command from a markdown tab logs a dose, a line in Daily and the status bar, and stays on that tab", async () => {
    const r = await run(`
      await na.openMd("Daily.md", "preview");
      const doses = () => na.fm("Apps/Meds data.md")?.doses?.length ?? 0;
      const before = { doses: doses(), lines: ((await na.read("Daily.md")).match(/Took meds/g) ?? []).length, status: na.status().find((s) => s.startsWith("Doses today")) };
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:Apps/Meds.md:took-meds");
      const notices = await na.noticesSince(mark, "Logged");
      await na.until(() => doses() === before.doses + 1, 3000);
      const status = await na.until(() => na.status().find((s) => s.startsWith("Doses today") && s !== before.status), 3000);
      return { before, notices, doses: doses(), lines: ((await na.read("Daily.md")).match(/Took meds/g) ?? []).length, status, state: na.state() };`);
    const n = Number(r.before.status?.split(": ")[1]);
    expect(Number.isInteger(n) && r.doses === r.before.doses + 1 && r.lines === r.before.lines + 1 && r.status === `Doses today: ${n + 1}` && r.notices.includes("Logged") && r.state === "markdown:Daily.md", r);
    return `${r.before.status} → ${r.status}; still on Daily`;
  });

  await check("Space weather: one recorded Kp row, the NOAA answer cached on disk, Kp now in the status bar", async () => {
    const r = await run(`
      const log = await na.until(() => na.fm("Apps/Space weather data.md")?.kp_log, 5000);
      const dir = ".obsidian/plugins/gizmo/cache";
      const files = (await app.vault.adapter.exists(dir)) ? (await app.vault.adapter.list(dir)).files.filter((f) => f.endsWith(".json")) : [];
      let noaa = false;
      for (const f of files) if ((await app.vault.adapter.read(f)).includes("services.swpc.noaa.gov/json/planetary_k_index_1m.json")) noaa = true;
      return { log, files: files.length, noaa, status: na.status().find((s) => s.startsWith("Kp now")) };`);
    expect(r.log?.length === 1 && r.log[0].at && typeof r.log[0].estimated_kp === "number", r);
    expect(r.noaa && /^Kp now: \d+\.\d\d$/.test(r.status ?? ""), r);
    return `kp_log ${JSON.stringify(r.log[0])}; ${r.files} cache files; ${r.status}`;
  }, { net: NET["Space weather"] });

  await check("a link runs Space weather's saw-aurora: a sighting saved and its notice", async () => {
    const r = await run(`
      const count = () => na.fm("Apps/Space weather data.md")?.sightings?.length ?? 0;
      const before = count();
      const mark = na.notices.length;
      // The link as "Copy link to an app shortcut" gives it, key and all.
      const url = new URL(na.plugin().background.shortcutLinks().find((l) => l.app === "Space weather" && l.shortcut === "saw-aurora").link);
      app.workspace.protocolHandler.dispatch({ action: url.host, ...Object.fromEntries(url.searchParams) });
      const notices = await na.noticesSince(mark, "Sighting saved");
      await na.until(() => count() === before + 1, 3000);
      return { before, after: count(), notices };`);
    expect(r.after === r.before + 1 && r.notices.includes("Sighting saved"), r);
    return `sightings ${r.before} → ${r.after}`;
  });

  await check("an alert that turns true gives one notice and shows in Attention with a link; set back, Attention is clear", async () => {
    const r = await run(`
      const file = na.file("Apps/Space weather.md");
      const original = await app.vault.read(file);
      const mark = na.notices.length;
      await app.vault.modify(file, original.replace('alert: ">= 5"', 'alert: ">= 0"'));
      const notices = await na.noticesSince(mark, "Space weather: Kp now", 8000);
      await na.open("Apps/Attention");
      const panel = () => na.view().contentEl.querySelector(".gz-view-alerts");
      const listed = await na.until(() => panel() && na.text(panel()).includes("Kp now") && { text: na.text(panel()), links: [...panel().querySelectorAll("a")].map((a) => a.textContent) }, 5000);
      await app.vault.modify(file, original);
      const cleared = await na.until(() => na.text(panel()).includes("Nothing needs attention.") && na.text(panel()), 8000);
      return { notices: notices.filter((n) => n.startsWith("Space weather")), listed, cleared };`);
    expect(r.notices.length === 1 && /^Space weather: Kp now \d+\.\d\d$/.test(r.notices[0]), r);
    expect(r.listed && r.listed.links.some((l) => l.includes("Space weather")) && r.cleared, r);
    return `${r.notices[0]}; listed with a link; then "${r.cleared}"`;
  }, { net: NET["Space weather"] });

  await check("clicking a status bar item opens its app; turning the plugin off takes the items and app commands away", async () => {
    const r = await run(`
      await na.openMd("Daily.md", "preview");
      const item = [...document.querySelectorAll(".status-bar .gz-status")].find((e) => e.textContent.startsWith("Doses today"));
      item.click();
      await na.sleep(1000);
      const opened = na.state();
      await app.plugins.disablePlugin("gizmo");
      await na.sleep(800);
      const off = { status: document.querySelectorAll(".gz-status").length, commands: Object.keys(app.commands.commands).filter((id) => id.startsWith("gizmo:")) };
      await app.plugins.enablePlugin("gizmo");
      await na.until(() => na.status().length > 0, 5000);
      return { opened, off, on: { status: na.status().length, commands: na.commands().length } };`);
    expect(r.opened === "gizmo:Apps/Meds.md" && r.off.status === 0 && r.off.commands.length === 0 && r.on.status > 0 && r.on.commands > 1, r);
    return `opened ${r.opened}; off: no items, no commands; on again: ${r.on.status} items, ${r.on.commands} commands`;
  });

  await check("with the network failing, Weather paints every forecast panel from its disk copy, marked as of, and keeps the mark through a resize", async () => {
    // The stub stays in place across the resize below; the last step puts the real fetch back.
    const r = await run(`
      await na.open("Apps/Weather");
      const host = na.plugin().dataLayer.host;
      window.__naFetch = host.fetch;
      host.fetch = async () => ({ status: 503, text: "Service Unavailable", contentType: "text/plain" });
      [...na.view().containerEl.querySelectorAll(".view-action")].find((a) => a.getAttribute("aria-label") === "Reload data").click();
      const el = na.view().contentEl;
      // Every panel that reads the forecast; the walks are in the data note, not on the web.
      const panels = () => [...el.querySelectorAll(".gz-panel")].filter((p) => p.querySelector(".gz-title")?.textContent !== "My walks");
      await na.until(() => panels().every((p) => p.hasAttribute("data-asof")), 8000);
      return { marked: panels().map((p) => p.getAttribute("data-asof")), errors: el.querySelectorAll(".gz-error").length };`);
    let after;
    try {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 800, deviceScaleFactor: 1, mobile: false });
      after = await run(`
        await na.sleep(1200);
        const el = na.view().contentEl;
        const web = [...el.querySelectorAll(".gz-panel")].filter((p) => p.querySelector(".gz-title")?.textContent !== "My walks");
        return { width: el.clientWidth, marked: web.map((p) => p.getAttribute("data-asof")), lines: el.querySelectorAll(".gz-view-line path.gz-line").length, errors: el.querySelectorAll(".gz-error").length };`);
    } finally {
      await page.send("Emulation.clearDeviceMetricsOverride");
      await run(`if (window.__naFetch) na.plugin().dataLayer.host.fetch = window.__naFetch; delete window.__naFetch;`);
    }
    expect(r.marked.length === 5 && r.marked.every((m) => m?.startsWith("as of")) && r.errors === 0, r);
    expect(after.marked.every((m) => m?.startsWith("as of")) && after.lines === 2 && after.errors === 0, after);
    return `${r.marked[0]} on all ${r.marked.length}; at ${after.width} px still marked`;
  }, { net: NET.Weather });

  await check("a new app with a shortcut gets a command; renaming it moves the command; taking the shortcut out removes it", async () => {
    const r = await run(`
      await na.write("Scratch/Coffee.md", ${JSON.stringify(SHORTCUT)});
      const added = await na.until(() => na.commands().find((c) => c.includes("Coffee")), 3000);
      await app.fileManager.renameFile(na.file("Scratch/Coffee.md"), "Scratch/Coffee log.md");
      const renamed = await na.until(() => na.commands().find((c) => c.includes("Coffee log")), 3000);
      const old = !(await na.until(() => !na.commands().includes("gizmo:Scratch/Coffee.md:coffee"), 3000));
      const name = app.commands.commands[renamed]?.name;
      const text = await na.read("Scratch/Coffee log.md");
      await na.write("Scratch/Coffee log.md", text.replace("shortcut: coffee\\n", ""));
      const gone = await na.until(() => !na.commands().some((c) => c.includes("Coffee")), 3000);
      return { added, renamed, old, name, gone: !!gone, left: na.commands().filter((c) => c.includes("Coffee")) };`);
    expect(r.added === "gizmo:Scratch/Coffee.md:coffee" && r.renamed === "gizmo:Scratch/Coffee log.md:coffee" && !r.old && r.gone, r);
    return `${r.added} → ${r.renamed} (“${r.name}”) → gone`;
  });
}
