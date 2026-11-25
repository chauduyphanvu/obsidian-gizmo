// Ahead (What if…): a budget over a kind, with a limit alert. A what-if line from Do… pushes the
// month over and the card names the day; the real data note and the app outside Ahead stay as they
// are; Keep leaves planned rows, and a second Keep adds none; Discard leaves nothing.

const KIND = `---
kind: cost
shortcut: cost
fields:
  amount: number
  category: [food, home, travel]
  memo: text
---
`;
const ALLOWANCE = `---
app: What I may spend this month
panels:
  - view: number
    title: Spent this month
    source: "[[Cost]]"
    field: amount
    agg: sum
    where: {at: this month}
    alert: "> 1000"
  - view: form
    title: Spent
    save: "[[Cost]]"
    label: Add
  - view: table
    title: Costs
    source: "[[Cost]]"
    columns: [amount, category, memo]
---
`;

/** Page code: the Allowance tabs, the live one and the one shown ahead, and what each shows. */
const TABS = `const tabs = () => app.workspace.getLeavesOfType("gizmo").filter((l) => l.view.file?.path === "Apps/Allowance.md");
  const aheadTab = () => tabs().find((l) => l.view.contentEl.querySelector(".gz-ahead"));
  const liveTab = () => tabs().find((l) => !l.view.contentEl.querySelector(".gz-ahead, .gz-past") && l.view.contentEl.querySelector(".gz-panel"));
  const big = (l) => l?.view.contentEl.querySelector(".gz-panel.gz-view-number .gz-big")?.textContent;
  const card = () => aheadTab()?.view.contentEl.querySelector(".gz-ahead");
  const cardText = () => card()?.innerText.replace(/\\n+/g, " | ");
  const cardButton = (label) => [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
  const device = () => na.plugin().runtime.device.id;
  // branchName("Apps/Allowance.md"): the note's name and a hash of its path.
  const branch = () => "Kinds/Cost data/log/" + device() + ".Allowance-bc41c897.branch";
  const readRaw = async (p) => (await app.vault.adapter.exists(p)) ? app.vault.adapter.read(p) : undefined;
  const liveRows = async () => (await na.plugin().runtime.dataLayer.ledger.state("Kinds/Cost data.md", na.fm("Kinds/Cost.md"))).lists.get("cost")?.rows.map((r) => ({ ...r })) ?? [];`;

/** A day this month a few days on (its last day at the latest), at 20:00, and the words for it on a line. */
const SOON = `const soon = (() => {
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const d = new Date(now.getFullYear(), now.getMonth(), Math.min(now.getDate() + 3, last), 20, 0);
    const t = d > now ? d : new Date(now.getTime() + 10 * 60000);
    const pad = (n) => String(n).padStart(2, "0");
    return { t: t.getTime(), words: t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + " " + pad(t.getHours()) + ":" + pad(t.getMinutes()),
      day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getDay()] + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getMonth()] + " " + t.getDate() };
  })();`;

const TRUST = `
  const trust = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins");
  if (trust) { trust.click(); await na.until(() => na.plugin()?.background, 5000); await na.sleep(1500); }
  app.setting?.close();
  for (const m of document.querySelectorAll(".modal-container")) m.querySelector(".modal-close-button")?.click();
  await na.sleep(200);`;

export default async function ahead(t) {
  const { check, run, expect, shot, press } = t;

  await check("a what-if line from Do… opens the budget ahead: the month goes over, the card names the day the limit is crossed, and nothing real changes", async () => {
    const r = await run(`
      ${TRUST} ${TABS} ${SOON}
      await na.write("Kinds/Cost.md", ${JSON.stringify(KIND)});
      await na.write("Apps/Allowance.md", ${JSON.stringify(ALLOWANCE)});
      await na.sleep(800);
      await na.open("Kinds/Cost");
      await na.open("Apps/Allowance");
      await na.plugin().runtime.background.capture("cost 600 home rent");
      await na.until(() => big(liveTab()) === "600", 4000);
      await na.until(() => (na.fm("Kinds/Cost data.md")?.cost ?? []).length === 1, 4000);
      await na.sleep(400);
      const noteBefore = await na.read("Kinds/Cost data.md");
      const logsBefore = app.vault.getFolderByPath("Kinds/Cost data/log").children.map((f) => f.path).sort();
      // The real row's notice is taken away, so the screenshot shows only what the what-if says.
      for (const n of document.querySelectorAll(".notice")) n.remove();
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:capture");
      await na.until(() => document.querySelector(".gz-capture-input"), 3000);
      const input = document.querySelector(".gz-capture-input");
      na.fill(input, "what if cost 500 travel flight @" + soon.words);
      await na.sleep(500);
      const hint = document.querySelector(".gz-capture-hint")?.textContent;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await na.until(() => big(aheadTab()) === "1,100", 6000);
      await na.until(() => cardText()?.includes("On the way there"), 4000);
      const told = await na.noticesSince(mark, "as a what-if");
      await na.sleep(800);
      app.workspace.setActiveLeaf(aheadTab(), { focus: true });
      await na.sleep(300);
      return {
        hint, soon, told, live: big(liveTab()), ahead: big(aheadTab()), card: cardText(),
        rail: aheadTab()?.view.contentEl.querySelector(".gz-rail-label")?.textContent,
        marks: aheadTab()?.view.contentEl.querySelectorAll(".gz-rail-mark").length,
        sameNote: (await na.read("Kinds/Cost data.md")) === noteBefore,
        logs: app.vault.getFolderByPath("Kinds/Cost data/log").children.map((f) => f.path).sort(), logsBefore,
        branch: await readRaw(branch()), rows: await liveRows(), errors: na.errors(aheadTab()?.view.contentEl),
        activity: (await na.plugin().runtime.activity.list("Apps/Allowance.md")).length,
      };`);
    await shot("ahead-what-if.png");
    expect(r.hint?.startsWith("What if, in Allowance: ") && r.hint.endsWith("Nothing real changes until Keep."), r);
    expect(r.live === "600" && r.ahead === "1,100" && r.errors === 0, r);
    expect(JSON.stringify(r.told) === JSON.stringify([`Added “cost 500 travel flight @${r.soon.words}” as a what-if; nothing real changed`]), r);
    expect(r.card.includes(`cost: 500 · travel · flight · ${r.soon.day}`) && r.card.includes(`“Spent this month” (> 1000) would go on ${r.soon.day}`), r);
    expect(r.rail?.startsWith("What if, as of ") && r.marks === 1, r);
    expect(r.sameNote && r.rows.length === 1 && r.rows[0].amount === 600 && r.activity === 0, r);
    // The only new file is the branch, beside the logs it isn't one of.
    expect(r.logs.filter((p) => !r.logsBefore.includes(p)).every((p) => p.endsWith(".branch")) && r.branch?.includes('"amount":500'), r);
    return `ahead ${r.ahead}, live ${r.live}; ${r.card.match(/“Spent this month”[^|]*/)?.[0]}`;
  });

  await check("Keep leaves the what-if as a planned row of the kind, in the activity; a second Keep from the same what-if adds none", async () => {
    const r = await run(`
      ${TABS} ${SOON}
      const saved = await readRaw(branch());
      cardButton("Keep as planned").click();
      await na.until(() => cardText()?.includes("Kept 1 row as planned."), 4000);
      await na.until(async () => (await liveRows()).length === 2, 4000);
      await na.sleep(800);
      const first = { card: cardText(), rows: await liveRows(), branch: await readRaw(branch()), live: big(liveTab()), ahead: big(aheadTab()),
        note: (na.fm("Kinds/Cost data.md")?.cost ?? []).map((x) => x.amount), activity: (await na.plugin().runtime.activity.list("Apps/Allowance.md")).map((e) => e.what) };
      // As if the branch hadn't been emptied (a Keep cut short, or one retried): Keep again, from What if…
      await app.vault.adapter.write(branch(), saved);
      na.plugin().runtime.dataLayer.fileChanged(branch());
      app.workspace.setActiveLeaf(aheadTab(), { focus: true });
      na.menuItem("What if…");
      await na.until(() => cardButton("Keep as planned"), 5000);
      await na.sleep(500);
      cardButton("Keep as planned").click();
      await na.until(() => cardText()?.includes("kept already"), 4000);
      await na.sleep(500);
      return { first, card: cardText(), rows: await liveRows(), branch: await readRaw(branch()) };`);
    await shot("ahead-kept.png");
    const planned = (rows) => rows.filter((x) => x.line === "planned");
    expect(r.first.card.includes("Kept 1 row as planned.") && r.first.branch === "" && r.first.live === "600" && r.first.ahead === "1,100", r);
    expect(planned(r.first.rows).length === 1 && planned(r.first.rows)[0].amount === 500 && JSON.stringify(r.first.note) === "[600]", r);
    expect(r.first.activity.includes("Kept a what-if row as planned"), r);
    expect(r.card.includes("These rows were kept already; nothing was added.") && planned(r.rows).length === 1 && r.rows.length === 2 && r.branch === "", r);
    return `${planned(r.rows).length} planned row after two Keeps`;
  });

  await check("a what-if added on the add line counts at once, and Discard leaves nothing of it; Back to now shows the app as it is", async () => {
    const r = await run(`
      ${TABS} ${SOON}
      const el = aheadTab().view.contentEl;
      na.fill(el.querySelector(".gz-addline-input"), "200 food dinner @" + soon.words);
      el.querySelector(".gz-addline-go").click();
      await na.until(() => big(aheadTab()) === "1,300", 4000);
      await na.sleep(500);
      const added = { ahead: big(aheadTab()), said: el.querySelector(".gz-notice-text")?.textContent, branch: await readRaw(branch()) };
      cardButton("Discard").click();
      await na.until(() => big(aheadTab()) === "1,100", 4000);
      await na.sleep(500);
      const after = { ahead: big(aheadTab()), card: cardText(), branch: await readRaw(branch()), rows: await liveRows() };
      return { added, after };`);
    await shot("ahead-discarded.png");
    expect(r.added.ahead === "1,300" && r.added.said?.startsWith("Added 200 to cost as a what-if for ") && r.added.said.endsWith("; nothing real changed") && r.added.branch.includes('"amount":200'), r);
    expect(r.after.ahead === "1,100" && r.after.branch === "" && r.after.card.includes("Discarded the what-if rows.") && r.after.card.includes("No what-if rows yet"), r);
    expect(r.after.rows.length === 2, r);
    await press("Escape");
    const back = await run(`
      ${TABS}
      const l = app.workspace.getLeavesOfType("gizmo").find((x) => x.view.file?.path === "Apps/Allowance.md" && x === app.workspace.getMostRecentLeaf());
      await na.sleep(800);
      return { card: !!l?.view.contentEl.querySelector(".gz-ahead"), big: big(l) };`);
    expect(!back.card && back.big === "600", back);
    return `discarded; back to now shows ${back.big}`;
  });
}
