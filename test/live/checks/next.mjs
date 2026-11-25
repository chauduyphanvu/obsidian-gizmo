// Next: what needs the person, one ask at a time. A rhythm still open answered with Enter, a planned
// row of a kind whose time passed, a skip that outlives turning the plugin off and on, and the
// status bar's count that opens the window.

/** A time of day an hour and a half from now, as `by` takes it; late in the evening, the day's last minute. */
function laterToday() {
  const now = new Date();
  const t = new Date(now.getTime() + 90 * 60_000);
  if (t.getDate() !== now.getDate()) return "23:59";
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

const rhythmApp = (name, label, shortcut, by) => `---
app: ${name}
panels:
  - view: button
    label: ${label}
    save: done
    shortcut: ${shortcut}
  - view: number
    title: Today
    source: done
    where: {at: today}
    agg: count
expect:
  - {id: daily, every: day, by: "${by}", source: done}
---
`;

const BILL = `---
kind: bill
shortcut: bill
fields:
  amount: number
  memo: text
---
`;

/** Page code: the open modals, in whichever window Obsidian drew them; the Next window's parts. */
const NEXT = `const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);
  const next = () => document.querySelector(".gz-next") ?? activeDocument.querySelector(".gz-next");
  const shown = () => {
    const el = next();
    return el && {
      count: el.querySelector(".gz-next-count")?.textContent,
      text: el.querySelector(".gz-next-text")?.textContent,
      line: el.querySelector(".gz-capture-input")?.value,
      hint: el.querySelector(".gz-capture-hint")?.textContent,
      buttons: [...el.querySelectorAll(".gz-next-buttons button")].map((b) => b.textContent),
      empty: el.querySelector(".gz-next-empty")?.textContent,
      focus: (activeDocument.activeElement === el) ? "window" : activeDocument.activeElement?.className,
    };
  };
  const asks = () => na.plugin().runtime.background.asks.list();`;
/** Page code: closes what an earlier check left open, so it can't take the keys typed next. */
const TRUST = `
  const trust = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins");
  if (trust) { trust.click(); await na.until(() => na.plugin()?.background, 5000); await na.sleep(1500); }
  app.setting?.close();
  await na.sleep(200);`;

export default async function next(t) {
  const { check, run, expect, shot, press, page } = t;
  /** A real key press of a letter, as typing it would send. */
  const letter = async (ch) => {
    const code = `Key${ch.toUpperCase()}`;
    const vk = ch.toUpperCase().charCodeAt(0);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await t.sleep(200);
  };
  const closeAll = async () => {
    await run(TRUST);
    for (let i = 0; i < 5 && (await run(`${NEXT} return modals().length;`)); i++) await press("Escape");
  };
  const by = laterToday();

  await check("Next shows a rhythm whose window is open with its line; Enter logs the row, says so with Undo, and the ask and the status bar's count go", async () => {
    await closeAll();
    const before = await run(`
      ${NEXT}
      // Asks earlier checks left are put off, so this check's own are the queue.
      for (const a of asks()) await na.plugin().runtime.background.skipAsk(a.id);
      await na.write("Apps/Water.md", ${JSON.stringify(rhythmApp("Water", "Drank a glass", "drank", by))});
      await na.sleep(800);
      await na.open("Apps/Water");
      await na.plugin().runtime.background.tick();
      await na.until(() => asks().some((a) => a.app === "Water"), 5000);
      await na.sleep(300);
      const status = na.status();
      document.querySelector(".status-bar .gz-status-asks")?.click();
      await na.until(() => shown()?.hint?.includes("Water"), 4000);
      await na.sleep(300);
      return { status, shown: shown(), queue: asks().map((a) => a.text) };`);
    await shot("next-rhythm.png");
    expect(before.status.includes("1 to do") && JSON.stringify(before.queue) === JSON.stringify([`Drank a glass? by ${by}`]), before);
    expect(before.shown?.text === `Drank a glass? by ${by}` && before.shown.line === "drank" && before.shown.hint === "Water: Drank a glass", before);
    expect(JSON.stringify(before.shown.buttons) === JSON.stringify(["Skip", "Run"]) && before.shown.focus === "window", before);
    await press("Enter");
    const after = await run(`
      ${NEXT}
      const mark = na.notices.length - 3;
      await na.until(() => (na.fm("Apps/Water data.md")?.done ?? []).length === 1, 4000);
      await na.until(() => shown()?.empty, 3000);
      await na.sleep(500);
      return {
        rows: (na.fm("Apps/Water data.md")?.done ?? []).length, shown: shown(), queue: asks().length, status: na.status(),
        notices: na.notices.slice(Math.max(0, mark)).filter((n) => n.includes("Drank") || n.includes("drank")),
      };`);
    await shot("next-empty.png");
    expect(after.rows === 1 && after.shown?.empty === "Nothing needs you." && after.queue === 0, after);
    expect(JSON.stringify(after.notices) === JSON.stringify(["Water: Drank a glass done. Undo"]) && !after.status.some((s) => s.includes("to do")), after);
    await closeAll();
    return `${before.status.find((s) => s.includes("to do"))}; ran “drank”; then ${after.shown.empty}`;
  });

  await check("a planned row of a kind whose time passed asks in Next; It happened makes it a logged row with Undo", async () => {
    await closeAll();
    const planned = await run(`
      ${NEXT}
      await na.write("Kinds/Bill.md", ${JSON.stringify(BILL)});
      await na.sleep(800);
      await na.open("Kinds/Bill");
      // A minute ahead at most, and never across a minute's turn while the line is read.
      if (new Date().getSeconds() >= 55) await na.sleep(6000);
      const at = new Date(Date.now() + 60000);
      const hhmm = String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
      const ran = await na.plugin().runtime.background.capture("bill 80 power @" + hhmm);
      at.setSeconds(0, 0);
      await na.until(() => Date.now() > at.getTime() + 1000, 70000);
      await na.plugin().runtime.background.tick();
      await na.until(() => asks().some((a) => a.app === "Bill"), 5000);
      app.commands.executeCommandById("gizmo:next");
      await na.until(() => shown()?.text, 3000);
      await na.sleep(300);
      return { ok: ran.ok, hhmm, shown: shown(), line: (na.fm("Kinds/Bill data.md")?.bill ?? []).length };`);
    await shot("next-planned.png");
    expect(planned.ok && planned.shown?.text?.startsWith("80 power, planned ") && planned.shown.text.endsWith(`${planned.hhmm}: did it happen?`), planned);
    expect(JSON.stringify(planned.shown.buttons) === JSON.stringify(["Skip", "Dismiss", "It happened"]) && planned.shown.line === undefined, planned);
    // As a phone draws it: a narrow window, with a finger's pointer.
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const touch = await run(`
      ${NEXT}
      await na.sleep(300);
      return { coarse: matchMedia("(pointer: coarse)").matches, heights: [...next().querySelectorAll(".gz-next-buttons button")].map((b) => Math.round(b.getBoundingClientRect().height)) };`);
    await shot("next-planned-phone.png", 390, 760, 2);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await press("Enter");
    const after = await run(`
      ${NEXT}
      await na.until(() => (na.fm("Kinds/Bill data.md")?.bill ?? []).length === 1, 4000);
      await na.until(() => shown()?.empty, 3000);
      await na.sleep(300);
      const fm = na.fm("Kinds/Bill.md");
      const state = await na.plugin().runtime.dataLayer.ledger.state("Kinds/Bill data.md", fm);
      const [entry] = await na.plugin().runtime.activity.list("Kinds/Bill.md");
      return {
        rows: (state.lists.get("bill")?.rows ?? []).map((r) => [r.amount, r.line ?? "logged"]), shown: shown(), entry: entry && [entry.what, entry.actor],
        notice: na.notices.slice(-4).find((n) => n.includes("happened")),
      };`);
    expect(JSON.stringify(after.rows) === JSON.stringify([[80, "logged"]]) && after.shown?.empty === "Nothing needs you.", after);
    expect(JSON.stringify(after.entry) === JSON.stringify(["Marked as happened: 80 power", "you"]) && after.notice === "Bill: Marked as happened: 80 power. Undo", after);
    expect(!touch.coarse || touch.heights.every((h) => h >= 44), touch);
    await closeAll();
    return `${planned.shown.text} → logged; touch buttons ${touch.coarse ? touch.heights.join("/") + " px" : "not emulated"}`;
  });

  await check("s skips an ask until tomorrow, also after the plugin is turned off and on; an s typed in the line stays a letter", async () => {
    await closeAll();
    const open = await run(`
      ${NEXT}
      await na.write("Apps/Stretch.md", ${JSON.stringify(rhythmApp("Stretch", "Stretched", "stretched", by))});
      await na.sleep(800);
      await na.open("Apps/Stretch");
      await na.plugin().runtime.background.tick();
      await na.until(() => asks().some((a) => a.app === "Stretch"), 5000);
      app.commands.executeCommandById("gizmo:next");
      await na.until(() => shown()?.line === "stretched", 3000);
      await na.sleep(300);
      return shown();`);
    expect(open?.text === `Stretched? by ${by}` && open.focus === "window", open);
    // In the line, s is a letter.
    await press("Tab");
    await letter("s");
    const typed = await run(`${NEXT} await na.sleep(300); return { shown: shown(), queue: asks().map((a) => a.app) };`);
    expect(typed.shown?.line === "stretcheds" && typed.queue.includes("Stretch"), typed);
    await press("Escape");
    await run(`${NEXT} app.commands.executeCommandById("gizmo:next"); await na.until(() => shown()?.line === "stretched", 3000); await na.sleep(300);`);
    await letter("s");
    const skipped = await run(`
      ${NEXT}
      await na.until(() => shown()?.empty, 3000);
      await na.sleep(800);
      return { shown: shown(), queue: asks().map((a) => a.app), status: na.status() };`);
    expect(skipped.shown?.empty === "Nothing needs you." && !skipped.queue.includes("Stretch") && !skipped.status.some((s) => s.includes("to do")), skipped);
    await closeAll();
    const reloaded = await run(`
      ${NEXT}
      await na.sleep(1500);
      await na.reload();
      await na.until(() => na.plugin()?.background, 5000);
      await na.sleep(2500);
      await na.plugin().runtime.background.tick();
      await na.sleep(500);
      const file = await app.vault.adapter.read(na.plugin().manifest.dir + "/triggers/" + na.plugin().runtime.device.id + ".json").catch(() => "");
      return { queue: asks().map((a) => a.app), kept: file.includes("skip:rhythm\\\\nApps/Stretch.md"), status: na.status() };`);
    expect(!reloaded.queue.includes("Stretch") && reloaded.kept && !reloaded.status.some((s) => s.includes("to do")), reloaded);
    return `skipped with s; after the plugin was turned off and on, still out (queue: ${reloaded.queue.join(", ") || "empty"})`;
  });

  await check("an app's own tab asks what Next asks of it; Enter there runs the line, says so with Undo, and the ask leaves Next", async () => {
    await closeAll();
    const before = await run(`
      ${NEXT}
      await na.write("Apps/Floss.md", ${JSON.stringify(rhythmApp("Floss", "Flossed", "flossed", by))});
      await na.sleep(800);
      await na.open("Apps/Floss");
      await na.plugin().runtime.background.tick();
      await na.until(() => asks().some((a) => a.app === "Floss"), 5000);
      const el = na.view().contentEl;
      const row = await na.until(() => el.querySelector(".gz-attention .gz-asks li"), 3000);
      row?.focus();
      return {
        title: el.querySelector(".gz-asks .gz-title")?.textContent, text: row?.querySelector(".gz-asks-text")?.textContent,
        line: row?.querySelector(".gz-asks-line")?.textContent, buttons: [...(row?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
        verb: el.querySelector(".gz-verb-state")?.textContent,
      };`);
    await shot("asks-in-tab.png");
    expect(before.title === "Needs you · 1" && before.text === `Flossed? by ${by}` && before.line === "flossed" && JSON.stringify(before.buttons) === '["Skip","Run"]' && before.verb === `Due by ${by}`, before);
    await press("Enter");
    const after = await run(`
      ${NEXT}
      const el = na.view().contentEl;
      await na.until(() => !asks().some((a) => a.app === "Floss"), 5000);
      await na.until(() => !el.querySelector(".gz-asks"), 3000);
      await na.sleep(300);
      return {
        queue: asks().map((a) => a.app), card: !!el.querySelector(".gz-asks"), done: (na.fm("Apps/Floss data.md")?.done ?? []).length,
        said: el.querySelector(".gz-notice-text")?.textContent, undo: !!el.querySelector(".gz-addline-under button.gz-undo"), errors: na.errors(),
        verb: await na.until(() => el.querySelector(".gz-verb-state")?.textContent === "Done today" && "Done today", 3000) || el.querySelector(".gz-verb-state")?.textContent,
      };`);
    expect(!after.queue.includes("Floss") && !after.card && after.done === 1 && after.said && after.undo && after.errors === 0 && after.verb === "Done today", after);
    return `asked “${before.text}” in the tab; Enter ran it: ${after.said}`;
  });
}
