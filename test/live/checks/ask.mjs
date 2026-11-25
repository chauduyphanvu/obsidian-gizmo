// The ask line, on the gallery's Spend kind: `?` in Do… draws the answer and the panel it stands
// for, reads only (no grant prompt, nothing written), says what it can't read with what was meant,
// and Keep adds the panel to an app, which then asks to read the kind. Around it, the fixes of the
// same round: a note of several words on the Do… line (first, so the asks count its row), and last
// the Trip planner's day totals over the column they add up, and a row formula that works out to
// nothing.

/** Page code: closes any window an earlier check left open, and accepts the trust dialog. */
const CLEAN = `
  const trust = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins");
  if (trust) { trust.click(); await na.until(() => na.plugin()?.background, 5000); await na.sleep(1500); }
  app.setting?.close();
  for (const m of document.querySelectorAll(".modal-container")) m.querySelector(".modal-close-button")?.click();
  await na.sleep(300);`;

/** Page code: the Do… window's parts, and opening it. */
const DO = `
  const input = () => document.querySelector(".gz-capture-input");
  const hint = () => document.querySelector(".gz-capture-hint");
  const pane = () => document.querySelector(".gz-capture .gz-ask");
  const answer = () => document.querySelector(".gz-ask-answer");
  const yaml = () => document.querySelector(".gz-ask-yaml")?.textContent;
  const chips = () => [...document.querySelectorAll(".gz-capture-chip")].map((c) => c.textContent);
  const askButton = (label) => [...document.querySelectorAll(".gz-ask button")].find((b) => b.textContent === label);
  const spendRows = () => na.fm("Kinds/Spend data.md")?.spend ?? [];
  const logs = () => (app.vault.getFolderByPath("Kinds/Spend data/log")?.children ?? []).map((f) => f.path + ":" + f.stat.size).sort().join(",");
  const openDo = async () => {
    if (!input()) app.commands.executeCommandById("gizmo:capture");
    await na.until(input, 3000);
    input().focus();
  };
  const ask = async (line, ready) => {
    na.fill(input(), line);
    return na.until(ready, 5000);
  };`;

export default async function askLine(t) {
  const { check, run, expect, shot, press, type } = t;

  await check("a note of several words on the Do… line: a kind's note takes the rest of the line when the next word can't be its next field", async () => {
    const r = await run(`
      ${CLEAN} ${DO}
      await openDo();
      const before = spendRows().length;
      na.fill(input(), "spend 14.5 food lunch with friends");
      await na.until(() => document.querySelector(".gz-capture .gz-effects li"), 4000);
      const said = { hint: hint().textContent, effects: [...document.querySelectorAll(".gz-capture .gz-effects li")].map((li) => li.textContent) };
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const row = await na.until(() => spendRows().length === before + 1 && spendRows().at(-1), 5000);
      return { said, row, open: !!input() };`);
    expect(r.row?.note === "lunch with friends" && r.row.amount === 14.5 && r.row.category === "food" && r.row.local == null && !r.row.trip && !r.open, r);
    expect(r.said.hint === "Spend: Add to spend · next, local=… or trip=… by name", r);
    return `saved note “${r.row.note}”; ${r.said.effects.join(" | ")}`;
  });

  await check("? in Do… draws a bar answer and the panel YAML it stands for, live as the line changes, with no grant prompt and nothing written", async () => {
    const r = await run(`
      ${CLEAN} ${DO}
      await openDo();
      const note = await na.read("Kinds/Spend data.md");
      const logsBefore = logs();
      await ask("? spend food per week since sep", () => answer()?.querySelector(".gz-panel.gz-view-bar svg"));
      await na.sleep(600);
      for (const n of document.querySelectorAll(".notice")) n.remove();
      return {
        hint: hint().textContent, error: hint().classList.contains("gz-error-text"), yaml: yaml(),
        title: answer()?.querySelector(".gz-title")?.textContent,
        bars: answer()?.querySelectorAll(".gz-panel.gz-view-bar rect.gz-bar, .gz-panel.gz-view-bar .gz-bar").length,
        allow: [...(answer()?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Allow"),
        errors: na.errors(answer()), wide: !!document.querySelector(".modal.gz-asking"),
        sameNote: (await na.read("Kinds/Spend data.md")) === note, sameLogs: logs() === logsBefore,
        asked: na.plugin().runtime.granted("ask:Kinds/Spend.md") ?? null,
      };`);
    await shot("ask-bar.png", 1100, 900);
    expect(r.hint.startsWith("Asks Spend: reads its rows, saves nothing.") && !r.error && r.wide, r);
    expect(r.title === "Spend: sum of amount per week, food, since Sep 1" && !r.allow && r.errors === 0, r);
    expect(r.yaml.startsWith('- view: bar\n  title: "Spend: sum of amount per week, food, since Sep 1"\n  source: "[[Spend]]"\n  where: {category: food, at: ">= 2026-09-01"}'), r);
    expect(r.sameNote && r.sameLogs && r.asked === null, r);
    return `${r.title}; ${r.bars} bars`;
  });

  await check("a number answer: ? spend this month adds up this month's logged rows", async () => {
    const r = await run(`
      ${DO}
      await ask("? spend this month", () => answer()?.querySelector(".gz-panel.gz-view-number .gz-big"));
      await na.sleep(800);
      const now = new Date();
      const month = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      const expected = spendRows().filter((x) => String(x.at).startsWith(month)).reduce((a, x) => a + Number(x.amount), 0);
      return { big: answer().querySelector(".gz-panel.gz-view-number .gz-big")?.textContent, expected, title: answer().querySelector(".gz-title")?.textContent, yaml: yaml() };`);
    await shot("ask-number.png", 1100, 800);
    expect(Math.abs(Number(r.big.replace(/[$,]/g, "")) - r.expected) < 0.005 && r.title === "Spend: sum of amount, this month", r);
    expect(r.yaml.includes("where: {at: this month}") && r.yaml.includes("view: number"), r);
    return `${r.big} (${r.expected} logged this month)`;
  });

  await check("a word an ask doesn't know is named in red with what was meant; Tab takes it, and Enter saves nothing", async () => {
    const r = await run(`
      ${DO}
      const before = spendRows().length;
      await ask("? spend fod", () => hint().classList.contains("gz-error-text") && chips().includes("food"));
      await na.sleep(300);
      return { hint: hint().textContent, chips: chips(), stale: !!document.querySelector(".gz-ask-body.is-stale"), add: askButton("Add to an app…")?.disabled, before };`);
    await shot("ask-error.png", 1100, 800);
    expect(r.hint === "“fod” isn't a field of Spend, a value its rows hold, or a word an ask knows (did you mean food?)" && r.chips[0] === "food" && r.stale && r.add, r);
    await run(`document.querySelector(".gz-capture-input").focus();`);
    await press("Tab");
    await press("Enter");
    const after = await run(`
      ${DO}
      await na.until(() => answer()?.querySelector(".gz-panel.gz-view-number .gz-big") && !document.querySelector(".gz-ask-body.is-stale"), 4000);
      await na.sleep(500);
      return { line: input()?.value, open: !!input(), rows: spendRows().length, title: answer()?.querySelector(".gz-title")?.textContent };`);
    expect(after.line === "? spend food " && after.open && after.rows === r.before && after.title === "Spend: sum of amount, food", after);
    return `${r.hint} → Tab: “${after.line}”`;
  });

  await check("a bare ? shows the grammar and the kinds; spend … still saves, ? spend … asks", async () => {
    const r = await run(`
      ${DO}
      await ask("?", () => document.querySelector(".gz-ask-help li:not(.gz-off)") && !document.querySelector(".gz-ask-help.gz-off"));
      const help = [...document.querySelectorAll(".gz-ask-help li")].map((li) => li.textContent);
      await ask("spend 3 food tea", () => document.querySelector(".gz-capture .gz-effects li"));
      const capture = { hint: hint().textContent, hidden: pane().classList.contains("gz-off"), wide: !!document.querySelector(".modal.gz-asking") };
      return { help, capture };`);
    // The gallery's six kinds, in the order the vault gives them.
    const kinds = ["spend (amount, category, note, local, trip)", "renewal (what, due, how)", "dose (med, note, refill)", "measurement or measure (what, value, note)", "trade (symbol, side, shares, price, note)", "chore (task, who, area, note)"];
    const listed = r.help.at(-1).replace(/^Kinds: /, "").split("; ");
    expect(r.help.at(-1).startsWith("Kinds: ") && JSON.stringify([...listed].sort()) === JSON.stringify([...kinds].sort()) && r.help[0].startsWith("? and a kind"), r);
    expect(r.capture.hint.startsWith("Spend: Add to spend") && r.capture.hidden && !r.capture.wide, r);
    return r.help.at(-1);
  });

  await check("Keep: Copy YAML and Copy embed copy the panel; Add to an app puts it at the end of the app's panels, and the app asks to read Spend; an app whose panels are one component's is refused", async () => {
    const copied = await run(`
      ${DO}
      await ask("? spend food per week since sep", () => answer()?.querySelector(".gz-panel.gz-view-bar svg") && !document.querySelector(".gz-ask-body.is-stale"));
      await na.sleep(400);
      askButton("Copy YAML").click();
      await na.sleep(200);
      const yamlCopied = await navigator.clipboard.readText();
      askButton("Copy embed").click();
      await na.sleep(200);
      const embedCopied = await navigator.clipboard.readText();
      const shown = yaml();
      askButton("Add to an app…").click();
      await na.until(() => document.querySelector(".prompt-input"), 3000);
      document.querySelector(".prompt-input").focus();
      return { yamlCopied, embedCopied, shown, practice: await na.read("Apps/Practice.md") };`);
    expect(copied.yamlCopied === copied.shown && copied.embedCopied.startsWith("```gizmo\nview: bar\n") && copied.embedCopied.endsWith("\nagg: sum\n```"), copied);
    const mark = await run(`return na.notices.length;`);
    await type("Apps/Practice");
    await press("Enter");
    const practice = await run(`
      ${DO}
      const told = await na.noticesSince(${mark}, "Couldn't add");
      await na.sleep(300);
      return { told, same: (await na.read("Apps/Practice.md")) === ${JSON.stringify(copied.practice)}, open: !!input() };`);
    expect(practice.told.includes("Couldn't add it to Practice: put - use: … inside panels to mix a component with other panels") && practice.same && practice.open, practice);
    await run(`
      ${DO}
      askButton("Add to an app…").click();
      await na.until(() => document.querySelector(".prompt-input"), 3000);
      document.querySelector(".prompt-input").focus();`);
    await type("Apps/Medication log");
    const chosen = await run(`return { typed: document.querySelector(".prompt .prompt-input")?.value, selected: document.querySelector(".prompt .suggestion-item.is-selected")?.textContent };`);
    await press("Enter");
    const kept = await run(`
      ${DO}
      await na.until(() => na.state() === "gizmo:Apps/Medication log.md", 5000);
      await na.settle();
      const text = await na.read("Apps/Medication log.md");
      const allow = await na.until(() => na.button("Allow"), 4000);
      const prompt = allow ? [...allow.closest(".gz-card").querySelectorAll("li")].map((li) => li.textContent) : [];
      return { closed: !input(), text, prompt, notices: na.notices.slice(-3) };`);
    await shot("ask-kept-asks.png", 1100, 800);
    kept.chosen = chosen;
    expect(kept.closed && kept.text.includes('  - view: bar\n    title: "Spend: sum of amount per week, food, since Sep 1"\n    source: "[[Spend]]"\n'), kept);
    // The prompt lists all the app needs; what it didn't ask for before is marked New.
    const fresh = kept.prompt.filter((p) => p.startsWith("New"));
    expect(fresh.length === 1 && fresh[0] === "NewRead the rows of Spend", kept);
    const shown = await run(`
      na.button("Allow").click();
      await na.until(() => !na.button("Allow"), 3000);
      await na.settle();
      const panel = await na.until(() => [...na.view().contentEl.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === "Spend: sum of amount per week, food, since Sep 1"), 5000);
      panel?.scrollIntoView({ block: "center" });
      await na.sleep(600);
      return { found: !!panel, bars: !!panel?.querySelector("svg"), errors: na.errors() };`);
    await shot("ask-kept.png", 1100, 800);
    expect(shown.found && shown.bars && shown.errors === 0, shown);
    return `Practice refused; Medication log asked again, new: ${fresh.join("; ").replace(/^New/, "")}`;
  });

  await check("Trip planner: a day's total sits over the Yen column it adds up, not under Dollars; a rate missing refuses the save with the field named", async () => {
    const r = await run(`
      ${CLEAN}
      const panel = (title) => [...na.view().contentEl.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
      const tab = (name) => [...na.view().contentEl.querySelectorAll("button.gz-tab")].find((b) => b.textContent === name).click();
      await na.open("Apps/Trip planner");
      tab("Spending");
      await na.until(() => panel("Expenses")?.querySelector("tr.gz-ledger-group"), 5000);
      await na.sleep(500);
      const expenses = panel("Expenses");
      const heads = [...expenses.querySelectorAll("tr.gz-ledger-group")].map((tr) => [...tr.children].map((th) => [th.getAttribute("colspan"), th.querySelector(".gz-ledger-total")?.textContent ?? ""]));
      const columns = [...expenses.querySelectorAll("thead th")].map((th) => th.textContent);
      // Where the total and the Yen column end on screen: the same right edge, within the cell padding.
      const total = expenses.querySelector(".gz-ledger-total").getBoundingClientRect();
      const yen = expenses.querySelectorAll("thead th")[1].getBoundingClientRect();
      const dollars = expenses.querySelectorAll("thead th")[2].getBoundingClientRect();
      expenses.scrollIntoView({ block: "center" });
      await na.sleep(400);
      return { heads, columns, totalRight: total.right, yenRight: yen.right, dollarsLeft: dollars.left };`);
    await shot("trip-expenses.png", 1100, 800);
    expect(JSON.stringify(r.columns) === JSON.stringify(["Item", "Yen", "Dollars"]) && JSON.stringify(r.heads[0]) === JSON.stringify([["2", "¥3,000"], ["1", ""]]), r);
    expect(r.totalRight <= r.yenRight + 1 && r.totalRight < r.dollarsLeft, r);
    const refused = await run(`
      const panel = (title) => [...na.view().contentEl.querySelectorAll(".gz-panel")].find((p) => p.querySelector(".gz-title")?.textContent === title);
      const rows = () => na.fm("Kinds/Spend data.md")?.spend?.length ?? 0;
      const file = na.file("Apps/Trip planner.md");
      const original = await app.vault.read(file);
      await app.vault.modify(file, original.replace("rate: 150\\n", ""));
      await na.sleep(1200);
      const before = rows();
      const form = panel("Spent abroad");
      na.fill(form.querySelector(".gz-addline-input"), "Gyoza 900");
      form.querySelector("button.gz-addline-go").click();
      const said = await na.until(() => form.querySelector(".gz-addline-error")?.textContent || form.querySelector(".gz-notice-text")?.textContent, 3000);
      await na.sleep(600);
      const after = rows();
      await app.vault.modify(file, original);
      await na.sleep(800);
      return { said, before, after };`);
    expect(refused.said === "Not saved: amount works out to nothing, since $this.rate has no value" && refused.after === refused.before, refused);
    return `day heading ${JSON.stringify(r.heads[0])}; without a rate: “${refused.said}”`;
  }, { net: ["https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY"] });
}
