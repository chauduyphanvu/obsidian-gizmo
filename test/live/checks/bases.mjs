// Gizmo views in Obsidian Bases: Bases/Projects.base shows the Projects notes on a Gizmo board and calendar.

const BASE = "Bases/Projects.base";

/** In the page: switches the open base to one of its views, by name, through its views menu. */
const VIEW = `async (name) => {
  const button = () => na.view().contentEl.querySelector(".bases-toolbar-views-menu .text-icon-button");
  if (button().textContent.trim() === name) return;
  button().click();
  const item = await na.until(() => [...document.querySelectorAll(".menu.bases-toolbar-views-menu .suggestion-item")].find((e) => e.innerText.trim() === name), 3000);
  if (!item) throw new Error("no view " + name + " in the base's views menu");
  item.click();
  await na.until(() => button().textContent.trim() === name, 3000);
  await na.sleep(500);
}`;

/** In the page: each board column's card texts, by column name. */
const COLUMNS = `() => Object.fromEntries([...na.view().contentEl.querySelectorAll(".gz-bases .gz-board-col")]
  .map((c) => [c.getAttribute("aria-label"), [...c.querySelectorAll(".gz-board-text")].map((e) => e.textContent)]))`;

/** In the page: the Projects notes' names by the status each has now (another check may have moved one). */
const STATUSES = `() => app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Projects/"))
  .reduce((by, f) => { const s = na.fm(f.path)?.status; (by[s] ??= []).push(f.basename); return by; }, {})`;

export default async function bases(t) {
  const { check, run, expect } = t;
  const open = (view) => run(`
    await app.workspace.openLinkText("${BASE}", "", false);
    await na.until(() => na.view().getViewType() === "bases" && na.view().contentEl.querySelector(".bases-toolbar-views-menu"), 5000);
    await (${VIEW})(${JSON.stringify(view)});`);

  await check("Projects.base, Gizmo board: a card per project, under the status its note has", async () => {
    await open("Board");
    const r = await run(`
      const columns = await na.until(() => { const c = (${COLUMNS})(); return Object.values(c).flat().length === 5 && c; }, 5000);
      const statuses = (${STATUSES})();
      return { state: na.state(), columns, statuses, errors: na.errors() };`);
    const wrong = Object.entries(r.statuses ?? {}).filter(([s, names]) => (
      names.some((n) => !(r.columns?.[s] ?? []).some((c) => c.startsWith(`${n} · due`)))
    ));
    expect(r.state === `bases:${BASE}` && r.columns && !wrong.length && !r.errors, { wrong, ...r });
    return Object.entries(r.columns).map(([s, cards]) => `${s} ${cards.length}`).join(", ");
  });

  await check("Projects.base: a card dragged to another column sets its note's status, Activity keeps it, and Undo puts it back", async () => {
    const pos = await run(`
      // Obsidian's first-open "trust the author" dialog would take the mouse; plugins are already on.
      [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins")?.click();
      await na.sleep(300);
      const el = na.view().contentEl;
      const card = [...el.querySelectorAll(".gz-bases .gz-board-card")].find((c) => c.textContent.startsWith("Learn Rust"));
      const from = card.closest(".gz-board-col");
      const to = [...el.querySelectorAll(".gz-bases .gz-board-col")].find((c) => c !== from);
      card.scrollIntoView({ block: "center" });
      await na.sleep(200);
      const a = card.querySelector(".gz-board-text").getBoundingClientRect(), b = to.getBoundingClientRect();
      return { from: from.getAttribute("aria-label"), to: to.getAttribute("aria-label"), at: [a.x + 6, a.y + a.height / 2], drop: [b.x + b.width / 2, b.y + b.height - 12] };`);
    const dragged = await t.drag(pos.at, pos.drop);
    const r = await run(`
      const columns = ${COLUMNS};
      const status = () => na.fm("Projects/Learn Rust.md")?.status;
      const moved = await na.until(() => status() === ${JSON.stringify(pos.to)} && columns()[${JSON.stringify(pos.to)}]?.some((c) => c.startsWith("Learn Rust")), 3000);
      const [entry] = await na.plugin().runtime.activity.list("${BASE}");
      const result = entry ? await na.plugin().runtime.undo(entry) : undefined;
      const back = await na.until(() => status() === ${JSON.stringify(pos.from)} && columns()[${JSON.stringify(pos.from)}]?.some((c) => c.startsWith("Learn Rust")), 3000);
      return { moved: !!moved, entry: entry && { actor: entry.actor, what: entry.what, changes: entry.changes }, result, back: !!back, status: status() };`);
    const change = r.entry?.changes?.[0];
    expect(dragged && r.moved, { note: "the drag should move Learn Rust's card and set its status", dragged, ...pos, ...r });
    expect(r.entry?.actor === "you" && r.entry.what === "Board" && change?.kind === "property" && change.path === "Projects/Learn Rust.md"
      && change.field === "status" && change.from === pos.from && change.to === pos.to, r);
    expect(r.result?.undone === 1 && r.back, r);
    return `${pos.from} → ${pos.to}, logged as ${r.entry.what}; undone, back in ${r.status}`;
  });

  await check("Projects.base, Gizmo calendar: each project counted on the day it is due", async () => {
    await open("Due dates");
    const r = await run(`
      const el = () => na.view().contentEl.querySelector(".gz-bases");
      const target = na.fm("Projects/Garden beds.md").due;
      // From whatever month it opens on, step to the one Garden beds is due in.
      for (let i = 0; i < 36 && !el().querySelector('[data-date="' + target + '"]'); i++) {
        const first = el().querySelector("[data-date]").getAttribute("data-date");
        el().querySelector(first > target ? ".gz-cal-prev" : ".gz-cal-next").click();
        await na.sleep(50);
      }
      const shown = Object.fromEntries([...el().querySelectorAll(".gz-cal-day[data-date]")]
        .filter((d) => d.querySelector(".gz-cal-val")).map((d) => [d.getAttribute("data-date"), d.querySelector(".gz-cal-val").textContent]));
      const due = {};
      for (const f of app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Projects/"))) {
        const d = na.fm(f.path).due;
        if (el().querySelector('[data-date="' + d + '"]')) due[d] = String(Number(due[d] ?? 0) + 1);
      }
      return { month: el().querySelector(".gz-cal-title").textContent, shown, due, errors: na.errors() };`);
    const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    expect(Object.keys(r.due).length && same(r.shown, r.due) && !r.errors, r);
    return `${r.month}: ${Object.entries(r.shown).map(([d, n]) => `${d} ${n}`).join(", ")}`;
  });

  await check("a Gizmo view whose options aren't finished says what it needs", async () => {
    const r = await run(`
      await na.write("Scratch/Unfinished.base", 'filters:\\n  and:\\n    - file.inFolder("Projects")\\nviews:\\n  - type: gizmo-board\\n    name: Unfinished\\n');
      await na.sleep(500);
      await app.workspace.openLinkText("Scratch/Unfinished.base", "", false);
      const panel = await na.until(() => na.view().contentEl.querySelector(".gz-bases .gz-panel.gz-error"), 5000);
      const text = panel && na.text(panel);
      await na.remove("Scratch/Unfinished.base");
      return { text };`);
    expect(r.text === "Gizmo board | board needs group (the field its columns come from)", r);
    return r.text;
  });

  for (const theme of ["light", "dark"]) {
    await t.theme(theme);
    for (const view of ["Board", "Due dates"]) {
      await open(view);
      await t.shot(`bases-${view.replace(/ /g, "-")}-${theme}.png`);
    }
  }
}
