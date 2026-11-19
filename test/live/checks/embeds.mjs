// note-app blocks in ordinary notes (the Meds block's first allow is in fresh.mjs).

const SHELF_NOTE = "# Reading notes\n\nWhat I am reading, by status.\n\n```note-app\ninputs:\n  status: [done, reading, to read]\npanels:\n  - view: list\n    title: Books $status\n    source: notes\n    from: Books\n    where: {status: $status}\n    item: \"{name}\"\n```\n\nMore text below the block.\n";
const BROKEN = "# Scratch\n\n```note-app\nview: [number\ntitle: oops\n```\n";
const WIDE = "# Steps\n\n```note-app\npanels:\n  - view: bar\n    title: Steps per day\n    source: steps\n    x: day\n    y: n\n  - view: button\n    label: Walked\n    save: walks\n```\n";
// A block's lists live in its note's data note.
const WIDE_DATA = "---\nsteps:\n  - {day: Mon, n: 4000}\n  - {day: Tue, n: 9000}\n  - {day: Wed, n: 7000}\n---\n";

export default async function embeds(t) {
  const { check, run, expect, page } = t;

  await check("Today: Drank a glass of water adds to Today data and Glasses today reads 1 of 8", async () => {
    const r = await run(`
      await na.openMd("Today.md", "preview");
      const before = na.fm("Today data.md")?.water?.length ?? 0;
      const water = () => na.embeds()[1];
      na.button("Drank a glass of water", water()).click();
      await na.until(() => (na.fm("Today data.md")?.water?.length ?? 0) === before + 1, 3000);
      await na.until(() => na.text(water()).includes((before + 1) + "of 8"), 3000);
      return { before, after: na.fm("Today data.md")?.water?.length, text: na.text(water()) };`);
    expect(r.after === r.before + 1 && r.text.includes(`Glasses today | ${r.after}of 8`), r);
    return r.text;
  });

  await check("Today, live preview: a real click on a block's button doesn't put the cursor in the block", async () => {
    const pos = await run(`
      await na.openMd("Today.md", "live");
      const ed = na.view().editor;
      ed.setCursor({ line: 0, ch: 0 });
      await na.sleep(300);
      const b = na.button("Drank a glass of water", na.embeds()[1]);
      b.scrollIntoView({ block: "center" });
      await na.sleep(300);
      const r = b.getBoundingClientRect();
      return { at: [r.x + r.width / 2, r.y + r.height / 2], before: na.fm("Today data.md")?.water?.length ?? 0 };`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x: pos.at[0], y: pos.at[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
    const r = await run(`
      await na.until(() => (na.fm("Today data.md")?.water?.length ?? 0) === ${pos.before} + 1, 3000);
      await na.sleep(500);
      const ed = na.view().editor;
      return { cursor: ed.getCursor(), embeds: na.embeds().length, water: na.fm("Today data.md")?.water?.length, text: na.text(na.embeds()[1]) };`);
    expect(r.water === pos.before + 1 && r.cursor.line === 0 && r.embeds === 2, r);
    return `logged; cursor stays at line ${r.cursor.line}; both blocks drawn`;
  });

  await check("live preview: the cursor going into a block and out keeps its input and its allow", async () => {
    const r = await run(`
      await na.write("Scratch/Shelf note.md", ${JSON.stringify(SHELF_NOTE)});
      await na.openMd("Scratch/Shelf note.md", "live");
      await na.sleep(800);
      const prompt = na.text(na.embeds()[0]);
      na.button("Allow", na.embeds()[0]).click();
      await na.until(() => na.embeds()[0]?.querySelector("select"), 3000);
      na.choose(na.embeds()[0].querySelector("select"), "reading");
      await na.sleep(600);
      const ed = na.view().editor;
      ed.setCursor({ line: 6, ch: 2 });
      ed.focus();
      await na.sleep(800);
      const inside = na.embeds().length;
      ed.setCursor({ line: 16, ch: 0 });
      await na.sleep(1000);
      const block = na.embeds()[0];
      return { prompt, inside, text: na.text(block), value: block.querySelector("select")?.selectedOptions[0]?.textContent, asks: !!na.button("Allow", block) };`);
    expect(r.prompt.includes("Read notes in Books") && r.inside === 0 && r.value === "reading" && !r.asks && r.text.includes("Books reading"), r);
    return `source shown while inside; drawn again with status ${r.value}, not asking`;
  });

  await check("renaming a note whose block was allowed doesn't ask again", async () => {
    const r = await run(`
      await na.openMd("Daily.md", "preview");
      await app.fileManager.renameFile(na.file("Scratch/Shelf note.md"), "Scratch/Shelf notes.md");
      await na.sleep(500);
      await na.openMd("Scratch/Shelf notes.md", "preview");
      await na.sleep(800);
      const block = na.embeds()[0];
      return { text: na.text(block), asks: !!na.button("Allow", block), grants: Object.keys(na.plugin().store.grants).filter((k) => k.startsWith("Scratch/Shelf note")) };`);
    expect(!r.asks && r.text.includes("Books done") && r.grants.length === 1 && r.grants[0].startsWith("Scratch/Shelf notes.md#"), r);
    return `no prompt; grant moved to ${r.grants[0]}`;
  });

  await check("a block that isn't YAML shows an error card with the parser's message", async () => {
    const r = await run(`
      await na.write("Scratch/Broken block.md", ${JSON.stringify(BROKEN)});
      await na.openMd("Scratch/Broken block.md", "preview");
      await na.sleep(800);
      const block = na.embeds()[0];
      return { card: block?.querySelector(".na-card.na-error")?.textContent };`);
    expect(r.card?.startsWith("This block isn't YAML Note Apps can read: ") && r.card.length > 45, r);
    return r.card.slice(0, 90);
  });

  await check("switching between Today and another note 10 times leaves no listeners behind", async () => {
    const r = await run(`
      const dl = na.plugin().dataLayer;
      await na.openMd("Daily.md", "live");
      await na.sleep(500);
      const start = dl.listeners.size;
      const during = [];
      for (let i = 0; i < 10; i++) {
        await na.openMd("Today.md", i % 2 ? "preview" : "live");
        await na.sleep(300);
        during.push(dl.listeners.size);
        await na.openMd("Daily.md", "live");
        await na.sleep(300);
      }
      return { start, during, end: dl.listeners.size };`);
    expect(r.end === r.start && r.during.every((n) => n > r.start), r);
    return `${r.start} → ${r.end} (with Today open: ${[...new Set(r.during)].join("/")})`;
  });

  await check("a block in a wide pane draws its chart wider than 960 px", async () => {
    await run(`
      await na.write("Scratch/Steps data.md", ${JSON.stringify(WIDE_DATA)});
      await na.write("Scratch/Steps.md", ${JSON.stringify(WIDE)});
      app.vault.setConfig("readableLineLength", false);
      app.workspace.leftSplit.collapse();
      app.workspace.rightSplit.collapse();`);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 900, deviceScaleFactor: 1, mobile: false });
    try {
      const r = await run(`
        await na.openMd("Scratch/Steps.md", "preview");
        await na.sleep(1500);
        const block = na.embeds()[0];
        const svg = block.querySelector(".na-view-bar svg");
        return { block: block.clientWidth, svg: svg?.getBoundingClientRect().width, viewBox: svg?.getAttribute("viewBox"), panel: block.querySelector(".na-view-bar").clientWidth };`);
      await t.shot("embed-wide.png", 1700, 900);
      expect(r.block > 1000 && r.svg > 960 && Number(r.viewBox?.split(" ")[2]) > 960, r);
      return `block ${r.block} px, chart ${Math.round(r.svg)} px (viewBox ${r.viewBox})`;
    } finally {
      await page.send("Emulation.clearDeviceMetricsOverride");
      await run(`app.vault.setConfig("readableLineLength", true);`);
    }
  });
}
