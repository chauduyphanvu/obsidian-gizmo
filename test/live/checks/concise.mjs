// Decisions (the Decision journal written short), Bets (the same app as a kit, for another folder)
// and the Decision review lens. Runs before `apps`, so both apps' first-open prompts are seen; it
// scores every due decision, so no alert is left on for the checks after it.

/** In the page: the panel of the active app titled so. */
const PANEL = `const panel = (title) => [...na.view().contentEl.querySelectorAll(".na-panel")].find((p) => p.querySelector(".na-title")?.textContent === title);
const tab = async (name) => { [...na.view().contentEl.querySelectorAll("button.na-tab")].find((b) => b.textContent === name).click(); await na.sleep(400); };
const field = (form, label) => [...form.querySelectorAll("label.na-field")].find((l) => l.querySelector("span").textContent === label).querySelector("input, select, textarea");
const day = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");`;

/** In the page: for each dropdown in an element, its longest choice's text width and the room it has for text. */
const ROOM = `(root) => [...root.querySelectorAll("select")].map((s) => {
  const cs = getComputedStyle(s);
  const probe = document.body.createSpan();
  Object.assign(probe.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre", fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing });
  const widest = Math.max(...[...s.options].map((o) => { probe.textContent = o.textContent; return probe.getBoundingClientRect().width; }));
  probe.remove();
  return { choices: [...s.options].map((o) => o.textContent).join("/"), widest: Math.ceil(widest), room: Math.floor(s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) };
})`;

export default async function concise(t) {
  const { check, run, expect, page } = t;
  const DUE = "Switch to the cheaper phone plan";

  await check("Decisions opens with no problems, asks to read, create and change notes in Decisions, and pins its count", async () => {
    const r = await run(`
      const { prompt } = await na.open("Apps/Decisions", false);
      const asked = { prompt, errors: na.errors() };
      na.button("Allow").click();
      await na.until(() => !na.button("Allow") && na.view().contentEl.querySelector(".na-panel"), 5000);
      await na.settle();
      const status = await na.until(() => na.status().find((s) => s.startsWith("Ready to score")), 5000);
      ${PANEL}
      return { ...asked, after: na.errors(), tabs: [...na.view().contentEl.querySelectorAll("button.na-tab")].map((b) => b.textContent), status, right: panel("Right so far")?.querySelector(".na-big")?.textContent };`);
    expect(r.errors === 0 && [...(r.prompt ?? [])].sort().join("|") === "Change properties of notes in Decisions|Create notes in Decisions|Read notes in Decisions", r);
    expect(r.after === 0 && r.tabs.join("|") === "Score|Waiting|Track record" && r.status === "Ready to score: 1" && r.right === "57%", r);
    return `${r.prompt.join(", ")}; status "${r.status}"; right so far ${r.right}`;
  });

  await check("the dropdowns in the edited columns show their longest choice whole, at 1100 px and at phone width", async () => {
    const out = {};
    for (const [width, height] of [[1100, 760], [390, 844]]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      try {
        out[width] = await run(`
          ${PANEL}
          await na.sleep(500);
          return (${ROOM})(panel("How did these turn out?"));`);
      } finally {
        await page.send("Emulation.clearDeviceMetricsOverride");
      }
    }
    await t.shot("concise-Decisions-score-dropdown.png");
    const all = [...out[1100], ...out[390]];
    expect(all.length === 2 && all.every((s) => s.room >= s.widest), out);
    return all.map((s) => `${s.choices}: text ${s.widest} px in ${s.room} px`).join("; ");
  });

  await check("scoring the due decision from its dropdown saves outcome and what I learned, and the status bar count goes to 0", async () => {
    const r = await run(`
      ${PANEL}
      const path = "Decisions/${DUE}.md";
      const row = () => [...panel("How did these turn out?").querySelectorAll("tbody tr")].find((tr) => tr.querySelector("td")?.textContent === "${DUE}");
      const shown = [...panel("How did these turn out?").querySelectorAll("th")].map((th) => th.textContent);
      const learned = row().querySelector("input.na-edit");
      learned.focus();
      na.fill(learned, "The basement has signal after all");
      await na.until(() => na.fm(path)?.learned, 3000);
      await na.sleep(500);
      na.choose(row().querySelector("select.na-edit"), "right");
      await na.until(() => na.fm(path)?.outcome === "right", 3000);
      // Should the clock have moved past another review day, that one is scored too.
      for (let i = 0; i < 10; i++) {
        const select = panel("How did these turn out?")?.querySelector("tbody select.na-edit");
        if (!select) break;
        na.choose(select, "right");
        await na.sleep(800);
      }
      const status = await na.until(() => na.status().find((s) => s === "Ready to score: 0"), 5000);
      return { shown, fm: na.fm(path), status, right: panel("Right so far")?.querySelector(".na-big")?.textContent, empty: panel("How did these turn out?")?.querySelector(".na-empty")?.textContent };`);
    expect(r.shown.join("|") === "Decision|I expected|% sure|Due|It went|What I learned", r);
    expect(r.fm?.outcome === "right" && r.fm.learned === "The basement has signal after all" && r.fm.confidence === 80 && r.status === "Ready to score: 0" && r.empty === "Nothing here yet.", r);
    return `outcome ${r.fm.outcome}, learned saved; status "${r.status}"; right so far ${r.right}`;
  });

  await check("the form writes a decision note: confidence a number, outcome open, made today", async () => {
    const r = await run(`
      ${PANEL}
      const form = panel("A decision I'm making").querySelector("form");
      const labels = [...form.querySelectorAll(".na-field > span")].map((s) => s.textContent);
      na.fill(field(form, "Decision"), "Walk to work in winter");
      na.fill(field(form, "I expected"), "I keep it up through January");
      na.choose(field(form, "% sure"), "70");
      na.fill(field(form, "Due"), "2027-06-01");
      const mark = na.notices.length;
      na.button("Write it down", form).click();
      const path = "Decisions/Walk to work in winter.md";
      const fm = await na.until(() => na.fm(path)?.made && na.fm(path), 5000);
      return { labels, fm, today: day(new Date()), notices: await na.noticesSince(mark, "Written down") };`);
    expect(r.labels.join("|") === "Decision|I expected|% sure|Due", r);
    expect(r.fm && r.fm.confidence === 70 && r.fm.outcome === "open" && r.fm.made === r.today && r.fm.review === "2027-06-01" && r.fm.expect === "I keep it up through January", r);
    expect(r.notices.includes("Written down. Come back on 2027-06-01 to score it."), r);
    return `${JSON.stringify(r.fm)}`;
  });

  await check("picking a bar on the Waiting timeline shows what I expected under it, with an Open link to the note", async () => {
    const r = await run(`
      ${PANEL}
      await tab("Waiting");
      const line = panel("Still waiting to find out");
      const labels = [...line.querySelectorAll(".na-tl-label")].map((l) => l.textContent);
      const row = [...line.querySelectorAll(".na-tl-row")].find((r) => r.querySelector(".na-tl-label").textContent === "Start running three mornings a week");
      row.querySelector(".na-tl-bar").click();
      await na.sleep(400);
      const detail = line.querySelector(".na-detail");
      const shown = { text: detail?.querySelector(".na-detail-text")?.textContent, link: detail?.querySelector("a")?.textContent };
      return { labels, shown };`);
    await t.shot("concise-Decisions-waiting-picked.png");
    const opened = await run(`
      ${PANEL}
      panel("Still waiting to find out").querySelector(".na-detail a").click();
      await na.until(() => app.workspace.getActiveFile()?.path === "Decisions/Start running three mornings a week.md", 3000);
      await na.sleep(800);
      return { file: app.workspace.getActiveFile()?.path, type: na.view().getViewType(), lens: na.view().contentEl.querySelector(".na-lens .na-lens-name")?.textContent };`);
    expect(r.labels.includes("Start running three mornings a week") && r.labels.includes("Walk to work in winter") && !r.labels.includes(DUE), r);
    expect(r.shown.text === "Start running three mornings a week. I expected: I'm still doing it in February (60% sure). I'll know by 2027-02-09." && r.shown.link === "Open", r);
    expect(opened.file === "Decisions/Start running three mornings a week.md" && opened.type === "markdown" && opened.lens === "Decision review", opened);
    return `"${r.shown.text}"; Open → ${opened.file} (${opened.type}, lens ${opened.lens})`;
  });

  await check("the Decision review lens on a decision note asks to change Decisions and saves how it went", async () => {
    const r = await run(`
      const path = "Decisions/Walk to work in winter.md";
      await na.openMd(path, "live");
      await na.sleep(800);
      const lens = () => na.view().contentEl.querySelector(".na-lens");
      const prompt = [...(lens()?.querySelectorAll(".na-card li") ?? [])].map((li) => li.textContent);
      na.button("Allow", lens())?.click();
      const select = await na.until(() => lens().querySelector(".na-view-form select"), 3000);
      const before = lens().querySelector(".na-view-text .na-text")?.textContent;
      na.choose(select, "wrong");
      await na.until(() => na.fm(path)?.outcome === "wrong", 3000);
      await na.sleep(800);
      return { prompt, before, after: lens().querySelector(".na-view-text .na-text")?.textContent, outcome: na.fm(path)?.outcome, lenses: na.view().contentEl.querySelectorAll(".na-lens").length };`);
    expect(r.prompt.join("|") === "Change properties of notes in Decisions" && r.lenses === 1, r);
    expect(r.before === "I expect: I keep it up through January (70% sure). Due 2027-06-01." && r.outcome === "wrong" && r.after === "I expected: I keep it up through January (70% sure). It went wrong.", r);
    return `"${r.before}" → "${r.after}"`;
  });

  await check("Bets, three lines that use the kit, asks for Bets naming the kit, and runs on Bets", async () => {
    const r = await run(`
      const { prompt } = await na.open("Apps/Bets", false);
      const asked = { prompt, errors: na.errors() };
      na.button("Allow").click();
      await na.until(() => !na.button("Allow") && na.view().contentEl.querySelector(".na-panel"), 5000);
      await na.settle();
      ${PANEL}
      const status = await na.until(() => na.status().find((s) => s.startsWith("Bets to score")), 5000);
      await tab("Waiting");
      return { ...asked, after: na.errors(), status, right: panel("Right so far")?.querySelector(".na-big")?.textContent,
        waiting: [...panel("Still waiting to find out").querySelectorAll(".na-tl-label")].map((l) => l.textContent),
        decide: na.commands().filter((c) => c.endsWith(":decide")) };`);
    const want = ["Create notes in Bets — for [[Decision kit]]", "Change properties of notes in Bets — for [[Decision kit]]", "Read notes in Bets — for [[Decision kit]]"];
    expect(r.errors === 0 && [...(r.prompt ?? [])].sort().join("|") === [...want].sort().join("|"), r);
    expect(r.after === 0 && r.status === "Bets to score: 0" && r.right === "100%", r);
    expect(r.waiting.join("|") === "The corner bakery is still open in 2030|The bridge opens before summer 2028", r);
    expect(r.decide.join("|") === "note-apps:Apps/Bets.md:decide|note-apps:Apps/Decisions.md:decide", r);
    return `${r.prompt.join(", ")}; status "${r.status}"`;
  });

  const dark = await run(`return document.body.classList.contains("theme-dark");`);
  const pick = `${PANEL} await tab("Waiting"); const line = panel("Still waiting to find out"); if (!line.querySelector(".na-tl-bar.na-selected")) line.querySelector(".na-tl-bar")?.click(); await na.sleep(400);`;
  const views = [
    ["Decisions", `await na.open("Apps/Decisions");`],
    ["Decisions-waiting", `await na.open("Apps/Decisions"); ${pick}`],
    ["Decisions-track-record", `await na.open("Apps/Decisions"); ${PANEL} await tab("Track record"); panel("Scored").scrollIntoView();`],
    ["Bets", `await na.open("Apps/Bets"); ${PANEL} await tab("Score");`],
    ["Decision-lens", `await na.openMd("Decisions/Walk to work in winter.md", "live");`],
  ];
  for (const theme of ["light", "dark"]) {
    await t.theme(theme);
    for (const [label, body] of views) {
      await run(`${body} await na.sleep(800);`);
      await t.shot(`concise-${label}-${theme}.png`);
    }
  }
  await run(`app.workspace.leftSplit.collapse();`);
  for (const [label, body] of views) {
    await run(`${body} await na.sleep(800);`);
    await t.shot(`concise-${label}-phone.png`, 390, 844, 2);
  }
  await run(`app.workspace.leftSplit.expand();`);
  await t.theme(dark ? "dark" : "light");
}
