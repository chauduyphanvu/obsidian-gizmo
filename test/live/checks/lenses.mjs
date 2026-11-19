// Lenses: Components/Reading progress shows above every note in Books.

const LONG = `---
status: reading
page: 10
pages: 300
---
${Array.from({ length: 160 }, (_, i) => `Line ${i + 1} of my notes on this long book.`).join("\n\n")}
`;

/** In the page: the lens elements in the active view, and in the whole window. */
const LENSES = `({ view: na.view().contentEl.querySelectorAll(".gz-lens").length, all: document.querySelectorAll(".gz-lens").length })`;

export default async function lenses(t) {
  const { check, run, expect } = t;

  await check("Dune, editing view: one lens above the editor; it asks to change Books; page 100 is saved and drawn; reading view still one lens; Middlemarch doesn't ask", async () => {
    const r = await run(`
      await na.openMd("Books/Dune.md", "live");
      await na.sleep(800);
      const ce = na.view().contentEl;
      const lens = () => na.view().contentEl.querySelector(".gz-lens");
      const first = { ...${LENSES}, top: ce.firstElementChild?.classList.contains("gz-lens"), name: lens()?.querySelector(".gz-lens-name")?.textContent, prompt: [...(lens()?.querySelectorAll(".gz-card li") ?? [])].map((li) => li.textContent) };
      na.button("Allow", lens()).click();
      await na.until(() => lens().querySelector(".gz-view-form input"), 3000);
      const input = lens().querySelector('.gz-view-form input[type="number"]');
      input.focus();
      na.fill(input, "100");
      await na.until(() => na.fm("Books/Dune.md")?.page === 100, 3000);
      await na.sleep(800);
      const saved = { page: na.fm("Books/Dune.md")?.page, bar: na.text(lens().querySelector(".gz-view-progress")), focused: document.activeElement === input, loading: na.text(lens()).includes("Loading…") };
      await na.openMd("Books/Dune.md", "preview");
      await na.sleep(800);
      const reading = ${LENSES};
      await na.openMd("Books/Middlemarch.md", "live");
      await na.sleep(800);
      const middlemarch = { ...${LENSES}, asks: !!na.button("Allow", lens()), bar: na.text(lens()?.querySelector(".gz-view-progress") ?? document.body).slice(0, 40) };
      return { first, saved, reading, middlemarch };`);
    expect(r.first.view === 1 && r.first.all === 1 && r.first.top && r.first.name === "Reading progress" && JSON.stringify(r.first.prompt) === '["Change properties of notes in Books"]', r.first);
    expect(r.saved.page === 100 && r.saved.bar.includes("100/ 412 pages"), r.saved);
    expect(r.saved.focused, { note: "the page field should keep focus after its value is saved", ...r.saved });
    expect(!r.saved.loading, { note: "the form shows a stale Loading… line", ...r.saved });
    expect(r.reading.view === 1 && r.reading.all === 1 && r.middlemarch.view === 1 && !r.middlemarch.asks && r.middlemarch.bar.includes("880"), r);
    return `one lens; page 100 → ${r.saved.bar}; reading view 1 lens; Middlemarch shows it without asking`;
  });

  await check("folding the lens keeps it folded on other books; Library, Daily and the component show none; turning the plugin off removes it", async () => {
    const r = await run(`
      await na.openMd("Books/Dune.md", "live");
      await na.sleep(600);
      const lens = () => na.view().contentEl.querySelector(".gz-lens");
      lens().querySelector(".gz-lens-toggle").click();
      await na.sleep(300);
      const folded = { cls: lens().querySelector(".gz-lens-item").className, panels: lens().querySelectorAll(".gz-panel").length };
      await na.openMd("Books/Piranesi.md", "live");
      await na.sleep(600);
      const other = { cls: lens()?.querySelector(".gz-lens-item")?.className, panels: lens()?.querySelectorAll(".gz-panel").length };
      lens().querySelector(".gz-lens-toggle").click();
      await na.sleep(500);
      const unfolded = lens().querySelectorAll(".gz-panel").length;
      const places = {};
      for (const p of ["Apps/Library.md", "Daily.md", "Components/Reading progress.md"]) {
        await app.workspace.openLinkText(p, "", false);
        await na.sleep(800);
        places[p] = document.querySelectorAll(".gz-lens").length;
      }
      await na.openMd("Components/Reading progress.md", "source");
      await na.sleep(500);
      places.componentSource = document.querySelectorAll(".gz-lens").length;
      await na.openMd("Books/Dune.md", "live");
      await na.sleep(800);
      const before = document.querySelectorAll(".gz-lens").length;
      await app.plugins.disablePlugin("gizmo");
      await na.sleep(800);
      const off = document.querySelectorAll(".gz-lens").length;
      await app.plugins.enablePlugin("gizmo");
      await na.sleep(1500);
      return { folded, other, unfolded, places, before, off, on: document.querySelectorAll(".gz-lens").length };`);
    expect(/is-folded/.test(r.folded.cls) && r.folded.panels === 0 && /is-folded/.test(r.other.cls ?? "") && r.other.panels === 0 && r.unfolded > 0, r);
    expect(Object.values(r.places).every((n) => n === 0) && r.before === 1 && r.off === 0 && r.on === 1, r);
    return `folded on Dune and Piranesi; none on ${Object.keys(r.places).join(", ")}; off removes it`;
  });

  await check("under a lens the editor and the reading view still fill the pane and scroll", async () => {
    const r = await run(`
      await na.write("Books/Long read.md", ${JSON.stringify(LONG)});
      const out = {};
      for (const mode of ["live", "preview"]) {
        await na.openMd("Books/Long read.md", mode);
        await na.sleep(1000);
        const ce = na.view().contentEl;
        const lens = ce.querySelector(".gz-lens");
        const pane = ce.querySelector(mode === "live" ? ".markdown-source-view" : ".markdown-reading-view");
        const scroller = ce.querySelector(mode === "live" ? ".cm-scroller" : ".markdown-preview-view");
        scroller.scrollTop = 400;
        await na.sleep(300);
        const box = ce.getBoundingClientRect(), p = pane.getBoundingClientRect(), l = lens.getBoundingClientRect();
        out[mode] = { lens: Math.round(l.height), paneTop: Math.round(p.top - l.bottom), paneBottom: Math.round(box.bottom - p.bottom), paneHeight: Math.round(p.height), scrolled: scroller.scrollTop, scrollable: scroller.scrollHeight > scroller.clientHeight };
      }
      await na.openMd("Daily.md", "preview");
      await na.remove("Books/Long read.md");
      return out;`);
    for (const mode of ["live", "preview"]) {
      const m = r[mode];
      expect(m && m.lens > 0 && Math.abs(m.paneTop) <= 2 && Math.abs(m.paneBottom) <= 2 && m.paneHeight > 200 && m.scrollable && m.scrolled >= 390, r);
    }
    return `live: lens ${r.live.lens} px, editor ${r.live.paneHeight} px scrolled to ${r.live.scrolled}; reading: ${r.preview.paneHeight} px scrolled to ${r.preview.scrolled}`;
  });
}
