// A kind's lines: rows read from a bank file (attested), the card that pairs them with what was
// logged, and rows planned for a time still to come.

const KIND = `---
kind: purchase
shortcut: purchase
fields:
  amount: number
  category: [food, home, travel]
  memo: text
import:
  bank: {folder: Inbox/Bank, amount: "-Amount", at: Posted Date, memo: Description}
match: {amount: exact, at: 2d}
---
`;
const APP = `---
app: What I bought, from the purchase kind
panels:
  - view: number
    title: Spent
    source: "[[Purchase]]"
    field: amount
    agg: sum
  - view: number
    title: Planned
    source: "[[Purchase]]"
    lines: planned
    field: amount
    agg: sum
---
`;

/** Page code: the purchase kind's rows on every line, as the ledger folds them. */
const ROWS = `const rows = async () => {
    const fm = na.fm("Kinds/Purchase.md");
    const state = await na.plugin().dataLayer.ledger.state("Kinds/Purchase data.md", fm);
    return (state.lists.get("purchase")?.rows ?? []).map((r) => ({ ...r }));
  };`;
/** Page code: a day n days from now as a US bank writes it, and a bank export of three rows. */
const BANK = `const us = (n) => { const d = new Date(Date.now() + n * 86400000); return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear(); };
  const csv = (lines) => ["Posted Date,Description,Amount", ...lines, ""].join("\\n");`;
/** Page code: types a line into the open app's add line; with go, saves it. */
const ADD = `const add = async (line, go = true) => {
    const el = na.view().contentEl;
    na.fill(el.querySelector(".gz-addline-input"), line);
    if (go) el.querySelector(".gz-addline-go").click();
  };`;

export default async function lines(t) {
  const { check, run, expect, shot } = t;

  await check("a kind with an import folder asks to read it; Import rows into a kind reads a bank file, and the card counts what pairs", async () => {
    const r = await run(`
      ${ROWS} ${BANK} ${ADD}
      await na.write("Kinds/Purchase.md", ${JSON.stringify(KIND)});
      await na.write("Apps/Purchases.md", ${JSON.stringify(APP)});
      await na.sleep(800);
      const { prompt } = await na.open("Kinds/Purchase");
      await add("14.5 food lunch @yday");
      await na.until(async () => (await rows()).length === 1, 3000);
      await add("60 food groceries @yday");
      await na.until(async () => (await rows()).length === 2, 3000);
      await na.write("Downloads/bank-nov.csv", csv([us(-1) + ",CORNER CAFE,-14.50", us(-1) + ",CITY POWER,-82.10", us(-2) + ",BOOKSHOP,-23.00"]));
      await na.sleep(500);
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:import-rows");
      const input = await na.until(() => document.querySelector(".prompt .prompt-input"), 3000);
      const placeholder = input?.placeholder;
      na.fill(input, "bank-nov");
      const pick = await na.until(() => document.querySelector(".prompt .suggestion-item.is-selected"), 3000);
      const picked = pick?.textContent;
      pick?.click();
      const said = await na.noticesSince(mark, "Imported", 5000);
      await na.until(() => na.view().contentEl.querySelector(".gz-reconcile"), 4000);
      await na.sleep(400);
      const card = na.view().contentEl.querySelector(".gz-reconcile");
      return {
        prompt, placeholder, picked, said, errors: na.errors(),
        title: card?.querySelector(".gz-title")?.textContent,
        counts: [...(card?.querySelectorAll(".gz-reconcile-count") ?? [])].map((c) => c.textContent),
        listed: [...(card?.querySelectorAll("li .gz-reconcile-row") ?? [])].map((c) => c.textContent),
        lines: (await rows()).map((row) => row.line ?? "logged"),
        note: (na.fm("Kinds/Purchase data.md")?.purchase ?? []).length,
      };`);
    await shot("lines-reconcile.png");
    expect(JSON.stringify(r.prompt) === JSON.stringify(["Read notes in Inbox/Bank"]), r);
    expect(r.placeholder === "A file to read into Purchase as bank" && r.picked === "Downloads/bank-nov.csv", r);
    expect(r.said.some((n) => n.startsWith("Imported 3 rows from bank-nov.csv into Purchase")), r);
    expect(r.title === "3 rows from a file to check" && r.errors === 0, r);
    expect(JSON.stringify(r.counts) === JSON.stringify(["1 pair with rows you logged", "2 only in the file", "1 only logged", "0 logged twice"]), r);
    expect(JSON.stringify(r.lines) === JSON.stringify(["logged", "logged", "attested", "attested", "attested"]) && r.note === 2, r);
    return r.counts.join(", ");
  });

  await check("the rows to check are worked from the keyboard: x sets one aside and keeps the focus in the list; ⌘Z puts it back", async () => {
    await run(`
      await na.open("Kinds/Purchase");
      const el = na.view().contentEl;
      const row = await na.until(() => [...el.querySelectorAll(".gz-reconcile li")].find((li) => li.textContent.includes("BOOKSHOP")), 4000);
      row.focus();`);
    await t.press("x");
    const r = await run(`
      const el = na.view().contentEl;
      await na.until(() => !el.querySelector(".gz-reconcile")?.textContent.includes("BOOKSHOP"), 4000);
      await na.sleep(400);
      const active = document.activeElement;
      return {
        listed: [...el.querySelectorAll(".gz-reconcile li .gz-reconcile-row")].map((c) => c.textContent),
        inQueue: !!active?.closest(".gz-reconcile .gz-queue"), focused: active?.querySelector(".gz-reconcile-row")?.textContent,
        inAttention: !!el.querySelector(".gz-body > .gz-attention > .gz-reconcile"),
        said: el.querySelector(".gz-notice-text")?.textContent,
      };`);
    await shot("lines-reconcile-queue.png");
    expect(r.listed.length === 2 && r.inQueue && r.inAttention && r.said === "Set aside a row from a file", r);
    await t.press("z", 4);
    const back = await run(`
      const el = na.view().contentEl;
      await na.until(() => el.querySelector(".gz-reconcile")?.textContent.includes("BOOKSHOP"), 4000);
      return { n: el.querySelectorAll(".gz-reconcile li").length };`);
    expect(back.n === 3, back);
    return `set aside with x, focus on ${r.focused}; ⌘Z brought it back`;
  });

  await check("an app's total is the same after the import until the rows are accepted; Accept all accepts them in one entry", async () => {
    const r = await run(`
      ${ROWS}
      await na.open("Apps/Purchases");
      await na.sleep(600);
      const before = na.text();
      await na.open("Kinds/Purchase");
      na.button("Accept all", na.view().contentEl.querySelector(".gz-reconcile"))?.click();
      await na.until(() => !na.view().contentEl.querySelector(".gz-reconcile"), 4000);
      await na.sleep(600);
      const kindView = na.text();
      const all = await rows();
      const [entry] = await na.plugin().activity.list("Kinds/Purchase.md");
      await na.open("Apps/Purchases");
      await na.sleep(800);
      return {
        before, after: na.text(), kindView,
        lines: all.map((row) => [row.memo, row.line ?? "logged", row.matched ? "paired" : ""]),
        entry: entry && [entry.what, entry.changes.length],
        note: (na.fm("Kinds/Purchase data.md")?.purchase ?? []).length,
      };`);
    await shot("lines-accepted.png");
    expect(r.before.includes("Spent | 74.5"), r);
    expect(r.after.includes("Spent | 180"), r);
    // The 2 rows only in the file are taken as logged and keep which import row each was: two changes each.
    expect(JSON.stringify(r.entry) === JSON.stringify(["Accepted 3 rows from a file", 5]), r);
    expect(r.lines.filter(([, line]) => line === "logged").length === 4 && r.lines.some(([memo, line, p]) => memo === "CORNER CAFE" && line === "attested" && p === "paired"), r);
    expect(r.note === 4, r);
    return r.after;
  });

  await check("a future time on a kind's add line says planned and plans the row; Do… plans one a month", async () => {
    const r = await run(`
      ${ROWS} ${ADD}
      await na.open("Kinds/Purchase");
      await add("1200 home rent @+10d", false);
      await na.sleep(300);
      const preview = [...na.view().contentEl.querySelectorAll(".gz-pv")].map((p) => p.textContent);
      return { preview };`);
    await shot("lines-planned-preview.png");
    const r2 = await run(`
      ${ROWS}
      const el = na.view().contentEl;
      el.querySelector(".gz-addline-go").click();
      await na.until(async () => (await rows()).some((row) => row.line === "planned"), 3000);
      await na.sleep(400);
      const said = el.querySelector(".gz-notice .gz-notice-text")?.textContent;
      const d = new Date(Date.now() + 75 * 86400000);
      const until = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const preview = await na.plugin().background.previewLine("purchase 900 travel flight @every month until " + until);
      const ran = await na.plugin().background.capture("purchase 900 travel flight @every month until " + until);
      await na.until(async () => (await rows()).filter((row) => row.line === "planned").length >= 3, 3000);
      await na.open("Apps/Purchases");
      await na.sleep(800);
      return {
        said, ok: ran.ok, plan: preview.parsed.plan?.length,
        planned: (await rows()).filter((row) => row.line === "planned").map((row) => row.amount),
        app: na.text(), note: (na.fm("Kinds/Purchase data.md")?.purchase ?? []).length,
      };`);
    await shot("lines-planned.png");
    expect(r.preview.some((p) => p.startsWith("planned")), r);
    expect(r2.said?.startsWith("Planned 1,200 in purchase for "), r2);
    expect(r2.ok && r2.plan === 2 && JSON.stringify(r2.planned) === JSON.stringify([1200, 900, 900]), r2);
    expect(r2.app.includes("Spent | 180") && r2.app.includes("Planned | 3,000") && r2.note === 4, r2);
    return `${r.preview.at(-1)}; ${r2.said}`;
  });

  await check("a new file in the import folder is read in by itself; a row an earlier file had, and the same file again, add nothing", async () => {
    const r = await run(`
      ${ROWS} ${BANK}
      await na.open("Kinds/Purchase");
      const mark = na.notices.length;
      await na.write("Inbox/Bank/bank-dec.csv", csv([us(-1) + ",CORNER CAFE,-14.50", us(0) + ",TRAIN,-7.25"]));
      const said = await na.noticesSince(mark, "Imported", 6000);
      await na.until(() => na.view().contentEl.querySelector(".gz-reconcile"), 4000);
      await na.sleep(400);
      const title = na.view().contentEl.querySelector(".gz-reconcile .gz-title")?.textContent;
      const count = (await rows()).length;
      await na.write("Inbox/Bank/bank-dec.csv", csv([us(-1) + ",CORNER CAFE,-14.50", us(0) + ",TRAIN,-7.25"]) + "\\n");
      await na.sleep(1500);
      return { said, title, count, again: (await rows()).length };`);
    await shot("lines-folder.png");
    expect(r.said.some((n) => n === "Imported 1 row from bank-dec.csv into Purchase; 1 row already imported"), r);
    expect(r.title === "1 row from a file to check" && r.count === r.again, r);
    return r.title;
  });
}
