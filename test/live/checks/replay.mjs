// Replay: an app as it was (As of, See it then) and backtests. Rows are saved a moment apart, so
// "the past" is a few seconds ago.

const steps = (alert) => `---
app: Count my steps
panels:
  - view: form
    title: Log
    fields: {n: number}
    save: steps
    label: Add
  - view: number
    title: Total
    source: steps
    field: n
    agg: sum
    alert: "${alert}"
---
`;

/** Page code: the open app's panels by title, and adding a row through its form. */
const PANEL = `
  const el = () => na.view().contentEl;
  const panel = (title) => [...el().querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
  const total = () => panel("Total")?.querySelector(".gz-big")?.textContent;
  const add = async (n) => {
    const form = panel("Log");
    na.fill(form.querySelector("input"), String(n));
    na.button("Add", form).click();
    await na.until(() => na.fm("Apps/Steps data.md")?.steps?.some((r) => r.n === n), 3000);
    await na.sleep(400);
  };`;
const MODALS = `const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);`;

export default async function replay(t) {
  const { check, run, expect, shot, press } = t;
  const closeAll = async () => {
    for (let i = 0; i < 5 && (await run(`${MODALS} return modals().length;`)); i++) await press("Escape");
  };

  await check("As of shows the total as it was, says so and can't be saved to; Back to now shows it live; See it then opens the first change beside it", async () => {
    await closeAll();
    const r = await run(`
      await na.write("Apps/Steps.md", ${JSON.stringify(steps("> 10"))});
      await na.sleep(800);
      await na.open("Apps/Steps");
      ${PANEL}
      await add(1);
      await add(4);
      const between = Date.now();
      await na.sleep(300);
      await add(7);
      const live = total();
      na.view().showAt(between);
      await na.until(() => el().querySelector(".gz-past") && total() === "5", 3000);
      const past = { total: total(), banner: el().querySelector(".gz-past")?.textContent };
      const mark = na.notices.length;
      const form = panel("Log");
      na.fill(form.querySelector("input"), "100");
      na.button("Add", form).click();
      const refused = await na.noticesSince(mark, "nothing can be changed", 3000);
      await na.sleep(500);
      const rows = na.fm("Apps/Steps data.md")?.steps?.length;
      na.button("Back to now", el()).click();
      await na.until(() => !el().querySelector(".gz-past") && total() === "12", 3000);
      const back = total();
      // The app's activity, oldest change last: its See it then opens a new tab.
      const leaves = app.workspace.getLeavesOfType("gizmo").length;
      app.commands.executeCommandById("gizmo:show-activity");
      ${MODALS}
      const modal = await na.until(() => modals().find((m) => m.querySelectorAll(".gz-activity-then").length >= 3), 3000);
      const buttons = [...modal.querySelectorAll(".gz-activity-then")];
      buttons.at(-1).click();
      await na.until(() => app.workspace.getLeavesOfType("gizmo").length === leaves + 1 && na.view().contentEl.querySelector(".gz-past"), 3000);
      await na.sleep(500);
      const then = { total: total(), banner: !!el().querySelector(".gz-past"), tabs: app.workspace.getLeavesOfType("gizmo").length - leaves };
      return { live, past, refused, rows, back, then };`);
    await shot("replay-then.png");
    await run(`na.view().leaf.detach(); await na.sleep(300);`);
    expect(r.live === "12" && r.past.total === "5" && /^As of .*: read only\.Back to now$/.test(r.past.banner), r);
    expect(r.refused?.some((n) => n.includes("This is the app as it was")) && r.rows === 3 && r.back === "12", r);
    expect(r.then.total === "1" && r.then.banner && r.then.tabs === 1, r);
    return `as of then ${r.past.total}, now ${r.back}; first change ${r.then.total}`;
  });

  await check("Backtest this change: the alert moved from > 10 to > 4 fires at the second row instead of the third; Backtest this app counts one", async () => {
    await closeAll();
    const r = await run(`
      await na.open("Apps/Steps");
      await na.sleep(300);
      await na.write("Apps/Steps.md", ${JSON.stringify(steps("> 4"))});
      await na.until(() => app.metadataCache.getCache("Apps/Steps.md")?.frontmatter?.panels?.[1]?.alert === "> 4", 3000);
      await na.sleep(300);
      // The tab's menu as Obsidian builds it, through a stand-in: a menu Obsidian shows closes at once
      // in a window without focus, which these runs never take.
      const items = {};
      const itemOf = () => {
        let title;
        const item = new Proxy({}, { get: (_, k) => (k === "setTitle" ? (x) => { title = x; return item; } : k === "onClick" ? (f) => { items[title] = f; return item; } : () => item) });
        return item;
      };
      const menu = new Proxy({}, { get: (_, k) => (k === "addItem" ? (cb) => { cb(itemOf()); return menu; } : () => menu) });
      na.view().onPaneMenu(menu, "more-options");
      const item = items["Backtest this change"];
      if (!item) return { menu: Object.keys(items) };
      item();
      ${MODALS}
      const done = () => modals().find((m) => m.querySelector(".gz-backtest h4"));
      const modal = await na.until(done, 8000);
      const change = modal && { title: modal.querySelector(".modal-title")?.textContent, text: [...modal.querySelectorAll(".gz-backtest p, .gz-backtest h4, .gz-backtest li")].map((e) => e.textContent), ticks: modal.querySelectorAll(".gz-backtest-fire").length };
      return change;`);
    await shot("replay-backtest.png");
    await closeAll();
    const has = (lines, s) => lines?.some((l) => l.includes(s));
    expect(r?.title === "Backtest this change to Steps" && has(r.text, "Before the change it would have fired once; after, once."), r);
    expect(has(r.text, "Added by the change (1)") && has(r.text, "Lost by the change (1)") && r.ticks === 2, r);
    const alone = await run(`
      app.commands.executeCommandById("gizmo:backtest-app");
      ${MODALS}
      const modal = await na.until(() => modals().find((m) => m.querySelector(".gz-backtest h4")), 8000);
      return modal ? [...modal.querySelectorAll(".gz-backtest p, .gz-backtest h4")].map((e) => e.textContent) : { modals: modals().map((m) => m.textContent), active: app.workspace.getActiveFile()?.path };`);
    await closeAll();
    expect(has(alone, "It would have fired once.") && has(alone, "When it fired (1)"), alone);
    return r.text.find((l) => l.startsWith("Before"));
  });
}
