// Replay: an app as it was (As of, See it then, the time rail) and backtests. Rows are saved a
// moment apart, so "the past" is a few seconds ago.

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
/** Page code, after PANEL: the open app's time rail under its title, and whether it shows the past. */
const RAIL = `
  const rail = () => el().querySelector(".gz-header > .gz-rail-slot > .gz-rail");
  const railText = (sel) => rail()?.querySelector(sel)?.textContent;
  const past = () => !!el().querySelector(".gz-past") && !!rail()?.classList.contains("is-past");
  const current = () => !el().querySelector(".gz-past") && !!rail() && !rail().classList.contains("is-past");`;

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

  await check("the time rail: each saved row is a tick; [ shows the app before the latest one, Back to now and Escape show it now; [ typed in a field is typed; no rail on the grid", async () => {
    await closeAll();
    /** A real key press, as Obsidian's keymap hears it. */
    const key = async (k) => {
      const [code, vk] = k === "[" ? ["BracketLeft", 219] : ["BracketRight", 221];
      await t.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await t.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await t.sleep(150);
    };
    const before = await run(`
      ${PANEL} ${RAIL}
      if ((na.fm("Apps/Steps data.md")?.steps?.length ?? 0) < 2) {
        await na.write("Apps/Steps.md", ${JSON.stringify(steps("> 10"))});
        await na.sleep(800);
        await na.open("Apps/Steps");
        await add(2);
        await add(3);
      } else await na.open("Apps/Steps");
      await na.until(() => rail()?.querySelectorAll(".gz-rail-tick").length >= 2 && total(), 5000);
      app.workspace.setActiveLeaf(na.leaf(), { focus: true });
      if (document.activeElement?.matches("input, textarea, select")) document.activeElement.blur();
      return {
        ticks: rail()?.querySelectorAll(".gz-rail-tick").length, label: railText(".gz-rail-label"), meta: railText(".gz-rail-meta"),
        underTitle: rail()?.parentElement.previousElementSibling?.classList.contains("gz-head"), current: current(), total: total(),
        rows: na.fm("Apps/Steps data.md")?.steps?.map((r) => r.n),
      };`);
    expect(before.ticks >= 2 && before.label === "Now" && before.current && before.underTitle && /^\d+ changes in 30 days\[\]$/.test(before.meta), before);

    await key("[");
    const stepped = await run(`
      ${PANEL} ${RAIL}
      await na.until(() => past() && total(), 4000);
      return { past: past(), total: total(), label: railText(".gz-rail-label"), meta: railText(".gz-rail-meta"), later: rail()?.querySelectorAll(".gz-rail-tick.is-later").length };`);
    const allButLast = String(before.rows.slice(0, -1).reduce((s, n) => s + n, 0));
    expect(stepped.past && stepped.total === allButLast && /^As of Today, /.test(stepped.label) && stepped.later === 1 && stepped.meta === "1 later change hiddenBack to now", { before, stepped });
    await shot("rail-past.png");

    const back = await run(`
      ${PANEL} ${RAIL}
      rail().querySelector("button.gz-rail-now").click();
      await na.until(() => current() && total() === ${JSON.stringify(before.total)}, 4000);
      return { current: current(), total: total(), label: railText(".gz-rail-label") };`);
    expect(back.current && back.total === before.total && back.label === "Now", back);

    await key("[");
    await run(`${PANEL} ${RAIL} await na.until(() => past(), 4000);`);
    await t.press("Escape");
    const escaped = await run(`${PANEL} ${RAIL} await na.until(() => current(), 4000); return { current: current(), total: total() };`);
    expect(escaped.current && escaped.total === before.total, escaped);

    await run(`
      ${PANEL}
      const input = panel("Log").querySelector("input");
      input.addEventListener("keydown", (e) => { window.__railKey = { stopped: e.defaultPrevented }; }, { once: true });
      input.focus();`);
    await key("[");
    await t.sleep(600);
    const typed = await run(`
      ${PANEL} ${RAIL}
      const r = { heard: window.__railKey, current: current() };
      panel("Log").querySelector("input").blur();
      return r;`);
    expect(typed.heard && !typed.heard.stopped && typed.current, typed);

    const grid = await run(`
      ${PANEL} ${RAIL}
      const note = await na.read("Apps/Steps.md");
      await na.write("Apps/Steps.md", note.replace("app: Count my steps\\n", "app: Count my steps\\nlayout: grid\\n"));
      await na.until(() => el().querySelector(".gz-grid") && total(), 4000);
      const shown = !!el().querySelector(".gz-rail");
      document.activeElement?.blur();
      return { note, grid: !!el().querySelector(".gz-grid"), shown };`);
    await key("[");
    await t.sleep(600);
    const restored = await run(`
      ${PANEL} ${RAIL}
      const stayed = !el().querySelector(".gz-past");
      await na.write("Apps/Steps.md", ${JSON.stringify(grid.note)});
      await na.until(() => rail() && !el().querySelector(".gz-grid"), 4000);
      return { stayed, rail: !!rail(), ticks: rail()?.querySelectorAll(".gz-rail-tick").length };`);
    expect(grid.grid && !grid.shown && restored.stayed && restored.rail && restored.ticks === before.ticks, { grid, restored });
    return `${before.ticks} ticks; [ showed ${stepped.total} for ${before.total}; ${stepped.label}`;
  });
}
