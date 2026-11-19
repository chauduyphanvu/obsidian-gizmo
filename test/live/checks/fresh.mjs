// Checks that need apps nobody has opened or allowed yet; they run first.

const PIN_NOTE = `---
app: Keep a note to myself in the status bar
view: text
title: Note to self
text: Water the plants
pin: status
---
`;

export default async function fresh(t) {
  const { check, run, expect } = t;

  await check("Meds before Allow: its command says to open it once and writes nothing", async () => {
    const r = await run(`
      const mark = na.notices.length;
      const daily = await na.read("Daily.md");
      const ok = app.commands.executeCommandById("gizmo:Apps/Meds.md:took-meds");
      const notices = await na.noticesSince(mark, "Open Meds");
      return { ok, notices, data: na.exists("Apps/Meds data.md"), dailySame: (await na.read("Daily.md")) === daily };`);
    expect(r.ok && r.notices.includes("Open Meds once to allow it") && !r.data && r.dailySame, r);
    return r.notices.join(" | ");
  });

  await check("obsidian://gizmo links: an unknown app, an unknown shortcut", async () => {
    const r = await run(`
      const mark = na.notices.length;
      app.workspace.protocolHandler.dispatch({ action: "gizmo", app: "Vitamins", do: "took-meds" });
      await na.noticesSince(mark, "Vitamins");
      app.workspace.protocolHandler.dispatch({ action: "gizmo", app: "Meds", do: "Took meds" });
      return await na.noticesSince(mark, "no shortcut");`);
    expect(r.includes("No app called “Vitamins”") && r.includes("Meds has no shortcut “Took meds”"), r);
    return r.join(" | ");
  });

  await check("first-open prompts list what each app asks for", async () => {
    const want = {
      Library: ["Fetch data from openlibrary.org", "Read notes in Books", "Create notes in Books", "Change properties of notes in Books"],
      Tasks: ["Read notes in Tasks", "Tick tasks in notes in Tasks"],
      Shelf: ["Read any note in the vault", "Change properties of notes anywhere in the vault"],
      Projects: ["Change properties of notes in Projects", "Read notes in Projects"],
      Bank: ["Read Finance/bank.csv"],
    };
    const got = {};
    for (const name of Object.keys(want)) {
      got[name] = (await run(`return (await na.open("Apps/${name}", false)).prompt;`)) ?? [];
    }
    const wrong = Object.keys(want).filter((n) => [...got[n]].sort().join("|") !== [...want[n]].sort().join("|"));
    expect(!wrong.length, { wrong, got });
    return Object.entries(got).map(([n, p]) => `${n}: ${p.length}`).join(", ");
  });

  await check("Today, reading view, Meds not allowed: the block says to open Meds once", async () => {
    const r = await run(`
      await na.openMd("Today.md", "preview");
      await na.sleep(800);
      const [meds, water] = na.embeds();
      return { count: na.embeds().length, meds: na.text(meds), water: na.text(water), buttons: [...meds.querySelectorAll("button")].length };`);
    expect(r.count === 2 && r.meds.includes("Open [[Meds]] once to allow it") && r.buttons === 0 && r.water.includes("Drank a glass of water"), r);
    return r.meds;
  });

  await check("Today: allowing Meds in its tab shows the Took meds button back in Today; it logs", async () => {
    const r = await run(`
      await na.openMd("Today.md", "preview");
      const today = na.leaf();
      const meds = await na.openInTab("Apps/Meds.md");
      na.button("Allow", meds.view.contentEl).click();
      await na.sleep(1000);
      app.workspace.setActiveLeaf(today, { focus: true });
      await na.sleep(800);
      const block = na.embeds(today)[0];
      const shown = { buttons: [...block.querySelectorAll("button")].map((b) => b.textContent), panels: block.querySelectorAll(".gz-panel").length, text: na.text(block) };
      const statusBefore = na.status();
      const mark = na.notices.length;
      na.button("Took meds", block).click();
      const notices = await na.noticesSince(mark, "Logged");
      await na.until(() => na.fm("Apps/Meds data.md")?.doses?.length === 1);
      await na.sleep(800);
      meds.detach();
      return { shown, notices, doses: na.fm("Apps/Meds data.md")?.doses?.length, daily: await na.read("Daily.md"), statusBefore, statusAfter: na.status() };`);
    expect(JSON.stringify(r.shown.buttons) === '["Took meds"]' && r.shown.panels === 1, r.shown);
    expect(r.doses === 1 && /Took meds \d\d:\d\d/.test(r.daily) && r.notices.includes("Logged"), r);
    expect(r.statusBefore.includes("Doses today: 0") && r.statusAfter.includes("Doses today: 1"), r);
    return `button only; doses 1; status ${r.statusAfter.join(", ")}`;
  });

  await check("a pinned app that asks for nothing shows in the status bar only once it was opened, and after a reload", async () => {
    const r = await run(`
      await na.write("Scratch/Note to self.md", ${JSON.stringify(PIN_NOTE)});
      await na.sleep(1500);
      const before = na.status();
      await na.open("Scratch/Note to self");
      const opened = await na.until(() => na.status().find((s) => s.startsWith("Note to self")), 3000);
      await na.openMd("Daily.md", "preview");
      await na.reload();
      const reloaded = await na.until(() => na.status().find((s) => s.startsWith("Note to self")), 5000);
      return { before, opened, reloaded };`);
    expect(!r.before.some((s) => s.startsWith("Note to self")) && r.opened === "Note to self: Water the plants" && r.reloaded === r.opened, r);
    return `${JSON.stringify(r.before)} → ${r.opened} → after reload ${r.reloaded}`;
  });
}
