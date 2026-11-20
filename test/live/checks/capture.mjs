// The capture line: Gizmo: Do…, ;; lines in a note, and capture links. window.open is never used here.

const SPEND = `---
app: Log what I spend
panels:
  - view: form
    title: Spent something
    alias: spend
    fields: {amount: number, category: [food, home], note: text}
    save: spend
    label: Add
  - view: number
    title: Spent
    source: spend
    field: amount
    agg: sum
---
`;

/** Page code: the open modals, in whichever window Obsidian drew them. */
const MODALS = `const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);`;
/** Page code: closes any window an earlier check left open, so it can't take the keys typed next. */
const TRUST = `
  const trust = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins");
  // Trusting turns the plugins on again: wait until Gizmo is back before using its commands.
  if (trust) { trust.click(); await na.until(() => na.plugin()?.background, 5000); await na.sleep(1500); }
  // Trusting also opens Obsidian's settings.
  app.setting?.close();
  await na.sleep(200);`;
/** Page code: opens Do… and gives its input, trying again while the command isn't there yet. */
const OPEN_DO = `const doInput = () => document.querySelector(".gz-capture-input") ?? activeDocument.querySelector(".gz-capture-input");
  app.commands.executeCommandById("gizmo:capture");
  let input = await na.until(doInput, 2000);
  if (!input) {
    app.commands.executeCommandById("gizmo:capture");
    input = await na.until(doInput, 3000);
  }
  input.focus();`;
/** Page code: how many rows Spend has saved. */
const ROWS = `const rows = () => na.fm("Apps/Spend data.md")?.spend?.length ?? 0;`;
/** Page code: what the editor's suggestion popup offers now, if it is open. */
const POP = `const pop = () => { const s = app.workspace.editorSuggest.currentSuggest; return s?.isOpen ? [...s.suggestEl.querySelectorAll(".suggestion-item")].map((i) => i.textContent) : []; };`;

export default async function capture(t) {
  const { check, run, expect, shot, type, press } = t;
  /** Closes any window an earlier check left open, so it can't take the keys typed next; Escape closes the top one. */
  const closeAll = async () => {
    await run(TRUST);
    for (let i = 0; i < 5 && (await run(`${MODALS} return modals().length;`)); i++) await press("Escape");
  };

  await check("Do… previews a line, Enter saves it, and the notice's Undo takes it out again", async () => {
    await closeAll();
    await run(`
      await na.write("Apps/Spend.md", ${JSON.stringify(SPEND)});
      await na.sleep(800);
      await na.open("Apps/Spend");
      ${OPEN_DO}`);
    await type("spend 14.5 food lunch with Sam");
    const preview = await run(`
      await na.until(() => [...document.querySelectorAll(".gz-capture .gz-effects li")].some((li) => li.textContent.includes("14.5")), 3000);
      return {
        hint: document.querySelector(".gz-capture-hint")?.textContent,
        effects: [...document.querySelectorAll(".gz-capture .gz-effects li")].map((li) => li.textContent),
        saved: na.fm("Apps/Spend data.md")?.spend,
      };`);
    await shot("capture-do.png");
    expect(preview.hint === "Spend: Spent something" && preview.effects.some((l) => l.includes("lunch with Sam")) && preview.saved === undefined, preview);
    await press("Enter");
    const r = await run(`
      const mark = na.notices.length;
      await na.until(() => na.fm("Apps/Spend data.md")?.spend?.length === 1, 3000);
      const row = na.fm("Apps/Spend data.md")?.spend?.[0];
      const open = !!document.querySelector(".gz-capture-input");
      const undo = await na.until(() => [...document.querySelectorAll(".notice a")].find((a) => a.textContent === "Undo"), 3000);
      const notice = undo?.closest(".notice")?.textContent;
      undo?.click();
      await na.until(() => na.fm("Apps/Spend data.md")?.spend?.length === 0, 3000);
      return { row, open, notice, after: na.fm("Apps/Spend data.md")?.spend };`);
    expect(r.row?.amount === 14.5 && r.row.category === "food" && r.row.note === "lunch with Sam" && !r.open, r);
    expect(r.notice?.startsWith("Ran “spend 14.5 food lunch with Sam”.") && Array.isArray(r.after) && r.after.length === 0, r);
    return r.notice;
  });

  await check("in Do…, Tab completes a name; a wrong value shows why in red and Enter saves nothing", async () => {
    await closeAll();
    await run(`
      ${OPEN_DO}`);
    await type("sp");
    await run(`await na.until(() => [...document.querySelectorAll(".gz-capture-chip")].some((c) => c.textContent === "spend"), 3000);`);
    await press("Tab");
    const completed = await run(`await na.sleep(300); return document.querySelector(".gz-capture-input").value;`);
    await type("lots");
    const wrong = await run(`
      await na.until(() => document.querySelector(".gz-capture-hint.gz-error-text"), 3000);
      return document.querySelector(".gz-capture-hint")?.textContent;`);
    await shot("capture-error.png");
    await press("Enter");
    const r = await run(`
      await na.sleep(500);
      const still = !!document.querySelector(".gz-capture-input");
      return { still, saved: na.fm("Apps/Spend data.md")?.spend?.length ?? 0 };`);
    await closeAll();
    // Test 1 undid its row, so Spend holds none.
    expect(completed === "spend ", completed);
    expect(wrong === "amount must be a number, not “lots” · amount: a number", wrong);
    expect(r.still && r.saved === 0, r);
    return completed;
  });

  await check("a ;; line in a note offers to run, runs on Enter, and becomes a receipt whose link opens the change", async () => {
    await closeAll();
    await run(`
      await na.write("Capture test.md", "Shopping today\\n\\n");
      await na.sleep(400);
      await na.openMd("Capture test.md", "source");
      const editor = na.view().editor;
      editor.focus();
      editor.setCursor({ line: 2, ch: 0 });`);
    await type(";; spend 3 home bus");
    const offered = await run(`
      ${POP}
      return await na.until(() => pop().find((s) => s.includes("Run in Spend")), 3000);`);
    await shot("capture-line.png");
    await press("Enter");
    const r = await run(`
      const text = await na.until(() => {
        const t = na.view().editor.getValue();
        return t.includes("✓ spend 3 home bus · Spend") ? t : undefined;
      }, 4000);
      const id = text?.match(/activity=([^)]+)\\)/)?.[1];
      ${MODALS}
      app.workspace.protocolHandler.dispatch({ action: "gizmo", activity: decodeURIComponent(id ?? "") });
      const modal = await na.until(() => modals().find((m) => m.querySelector(".gz-activity-focus")), 3000);
      const focused = modal?.querySelector(".gz-activity-focus")?.textContent;
      modal?.querySelector(".modal-close-button")?.click();
      return { text, focused, saved: na.fm("Apps/Spend data.md")?.spend };`);
    expect(offered?.includes("Run in Spend: Spent something") && offered.includes("3"), offered);
    const last = r.saved?.at(-1);
    expect(last?.amount === 3 && last.category === "home" && last.note === "bus", r);
    expect(r.text?.split("\n")[2].startsWith("✓ spend 3 home bus · Spend · ") && r.focused?.includes("Spent something"), r);
    return r.text.split("\n")[2];
  });

  await check("a ;; line that doesn't start with a shortcut's name, or sits in a code block, offers nothing and Enter adds a line", async () => {
    await closeAll();
    await run(`
      await na.write("Capture test 2.md", "\\\`\\\`\\\`lisp\\n\\n\\\`\\\`\\\`\\n\\n");
      await na.sleep(400);
      await na.openMd("Capture test 2.md", "source");
      const editor = na.view().editor;
      editor.focus();
      editor.setCursor({ line: 1, ch: 0 });`);
    const before = await run(`${ROWS} return rows();`);
    await type(";; spend 2 food");
    const inCode = await run(`await na.sleep(800); ${POP} return pop().length;`);
    await run(`const e = na.view().editor; e.setCursor({ line: e.lineCount() - 1, ch: 0 }); e.focus(); await na.sleep(200);`);
    await type(";; a note to self");
    const plain = await run(`await na.sleep(800); ${POP} return pop().length;`);
    await press("Enter");
    const r = await run(`await na.sleep(300); ${ROWS} const e = na.view().editor; return { text: e.getValue(), cursor: e.getCursor().line, saved: rows() };`);
    expect(inCode === 0 && plain === 0, { inCode, plain });
    // Enter on the plain line made a new line under it, and nothing was saved.
    expect(r.text.endsWith(";; a note to self\n") && r.saved === before, { ...r, before });
    return r.text;
  });

  await check("a capture link without a key asks first and Cancel saves nothing; one with a key made for its name runs", async () => {
    await closeAll();
    const r = await run(`
      ${MODALS}
      ${ROWS}
      const before = rows();
      app.workspace.protocolHandler.dispatch({ action: "gizmo", line: "spend 9 food" });
      const ask = await na.until(() => modals().find((m) => m.innerText.includes("A link asks to run")), 3000);
      const title = ask?.querySelector(".modal-title")?.textContent;
      const effects = ask ? [...ask.querySelectorAll(".gz-effects li")].map((li) => li.textContent) : [];
      if (ask) na.button("Cancel", ask).click();
      await na.sleep(500);
      const afterCancel = rows() - before;
      const key = await na.plugin().newCaptureKey([na.plugin().background.captureIndex().names.get("spend")]);
      app.workspace.protocolHandler.dispatch({ action: "gizmo", key, line: "spend 11 food" });
      await na.until(() => rows() === before + 1, 3000);
      const asked = modals().some((m) => m.innerText.includes("A link asks to run"));
      return { title, effects, afterCancel, after: rows() - before, asked };`);
    // A link names a form by its button, as every link's window does.
    expect(r.title === "A link asks to run “Add” in Spend" && r.effects.some((l) => l.includes("9")), r);
    expect(r.afterCancel === 0 && r.after === 1 && !r.asked, r);
    return r.title;
  });

  await check("a checklist's shortcut ticks an item from a capture line", async () => {
    const r = await run(`
      await na.open("Apps/Packing");
      const result = await na.plugin().background.capture("pack rain");
      await na.until(() => na.fm("Apps/Packing data.md")?.packed?.includes("Rain jacket"), 3000);
      return { ok: result.ok, packed: na.fm("Apps/Packing data.md")?.packed };`);
    expect(r.ok && r.packed?.includes("Rain jacket"), r);
    return r.packed.join(", ");
  });
}
