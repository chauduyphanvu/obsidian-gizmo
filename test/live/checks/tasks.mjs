// Tasks and Bases.

export default async function tasks(t) {
  const { check, run, expect } = t;

  await check("Tasks: Open lists the 8 open tasks, none from Website.md's code block", async () => {
    const r = await run(`
      await na.open("Apps/Tasks");
      const rows = [...na.view().contentEl.querySelectorAll(".gz-view-table tbody tr")].map((tr) => tr.textContent);
      const box = na.view().contentEl.querySelector('.gz-view-table tbody input[type="checkbox"]').getBoundingClientRect();
      return { rows, errors: na.errors(), box: [box.width, box.height] };`);
    expect(r.rows.length === 8 && !r.rows.some((x) => x.includes("Add analytics") || x.includes("newsletter")) && r.errors === 0, r);
    // A done box squashed to a sliver can't be seen or hit.
    expect(r.box[0] >= 12 && r.box[0] === r.box[1], { box: r.box });
    return `${r.rows.length} rows; done boxes ${r.box.join("×")} px`;
  });

  await check("Tasks: ticking a task changes only that line; it moves from Open to Done; unticking restores the file", async () => {
    const r = await run(`
      await na.open("Apps/Tasks");
      const el = na.view().contentEl;
      const original = await na.read("Tasks/Tax return.md");
      const row = () => [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.includes("Download bank statements"));
      row().querySelector('input[type="checkbox"]').click();
      const ticked = await na.until(async () => { const t = await na.read("Tasks/Tax return.md"); return t !== original && t; }, 3000);
      await na.until(() => !row(), 3000);
      const done = na.text([...el.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === "Done"));
      const openAfter = el.querySelectorAll(".gz-view-table tbody tr").length;
      // The Done list has no checkboxes: the line is put back through the vault, and the row returns to Open.
      const doneRow = await na.read("Tasks/Tax return.md");
      await app.vault.modify(app.vault.getFileByPath("Tasks/Tax return.md"), doneRow.replace("2. [x] Download", "2. [ ] Download"));
      await na.until(() => row(), 3000);
      const restored = (await na.read("Tasks/Tax return.md")) === original;
      return { original, ticked, done, openAfter, restored };`);
    const want = r.original.replace("2. [ ] Download bank statements 📅 2026-11-19", "2. [x] Download bank statements 📅 2026-11-19");
    expect(r.ticked === want, { got: r.ticked, want });
    expect(/Download bank statements[^|]* · Tax return/.test(r.done) && r.openAfter === 7 && r.restored, r);
    return "line 2 ticked, every other byte the same; Open 7, in Done";
  });

  await check("Tasks: a task added to a note's body shows within a second", async () => {
    const r = await run(`
      await na.open("Apps/Tasks");
      const el = na.view().contentEl;
      await app.vault.process(app.vault.getFileByPath("Tasks/Garden shed.md"), (text) => text.replace(/\\n?$/, "\\n") + "- [ ] Paint the shed\\n");
      const start = Date.now();
      const shown = await na.until(() => [...el.querySelectorAll(".gz-view-table tbody tr")].some((tr) => tr.textContent.includes("Paint the shed")), 3000);
      return { shown: !!shown, ms: Date.now() - start };`);
    expect(r.shown && r.ms <= 1500, r);
    return `shown after ${r.ms} ms`;
  });

  await check("Tasks: a line inserted above a task just before it is ticked: the right line is ticked", async () => {
    const r = await run(`
      await na.open("Apps/Tasks");
      const el = na.view().contentEl;
      const file = app.vault.getFileByPath("Tasks/Garden shed.md");
      const box = [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.includes("Order timber")).querySelector('input[type="checkbox"]');
      await app.vault.process(file, (text) => text.replace("- [ ] Order timber", "- [ ] Ring the timber yard first\\n- [ ] Order timber"));
      box.click();
      await na.until(async () => (await na.read("Tasks/Garden shed.md")).includes("- [x] Order timber"), 3000);
      return await na.read("Tasks/Garden shed.md");`);
    expect(r.includes("- [x] Order timber") && r.includes("- [ ] Ring the timber yard first"), r);
    return "Order timber ticked, the new line left alone";
  });

  await check("Shelf: 4 books; setting Dune to reading writes status: reading and By status follows", async () => {
    const r = await run(`
      await na.open("Apps/Shelf");
      const el = na.view().contentEl;
      const rows = el.querySelectorAll(".gz-view-table tbody tr").length;
      const byStatus = () => na.text(el.querySelector(".gz-view-list"));
      const before = byStatus();
      const select = [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.startsWith("Dune")).querySelector("select");
      select.focus();
      na.choose(select, "reading");
      const written = await na.until(() => na.fm("Books/Dune.md")?.status === "reading", 3000);
      const after = await na.until(() => byStatus().includes("reading · 1") && byStatus(), 3000);
      return { rows, before, written: !!written, after, focused: document.activeElement === select };`);
    expect(r.rows === 4 && r.written && r.after && r.before.includes("done · 4") && r.after.includes("done · 3"), r);
    return `4 rows; ${r.after}`;
  });

  await check("Books.base: a filter added to the base narrows Shelf to the reading book", async () => {
    const r = await run(`
      await na.open("Apps/Shelf");
      const el = na.view().contentEl;
      const base = app.vault.getFileByPath("Books.base");
      const original = await app.vault.read(base);
      await app.vault.modify(base, original.replace('    - \\'file.ext == "md"\\'', '    - \\'file.ext == "md"\\'\\n    - \\'status == "reading"\\''));
      const rows = () => [...el.querySelectorAll(".gz-view-table tbody tr")].map((tr) => tr.textContent);
      const narrowed = await na.until(() => rows().length === 1 && rows(), 3000);
      await app.vault.modify(base, original);
      await app.fileManager.processFrontMatter(app.vault.getFileByPath("Books/Dune.md"), (fm) => { fm.status = "done"; });
      const back = await na.until(() => rows().length === 4, 3000);
      return { narrowed, back: !!back, base: original };`);
    expect(r.narrowed && r.narrowed[0].startsWith("Dune") && r.back, r);
    return `${r.narrowed[0]}; back to 4`;
  });
}
