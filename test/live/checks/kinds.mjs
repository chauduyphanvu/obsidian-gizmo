// Kinds: rows that belong to the vault. A kind note, two apps that read it, and a list made into a kind.

const KIND = `---
kind: outlay
shortcut: outlay
fields:
  amount: number
  category: [food, home, travel]
  memo: text
---
`;
const BUDGET = `---
app: What I spend, from the outlay kind
panels:
  - view: form
    title: Spent
    save: "[[Outlay]]"
    label: Add
  - view: number
    title: Total
    source: "[[Outlay]]"
    field: amount
    agg: sum
---
`;
const TRIP = `---
app: What the trip cost, from the outlay kind
panels:
  - view: table
    title: Travel
    source: "[[Outlay]]"
    where: {category: travel}
    columns: [amount, memo]
---
`;
const ROUNDS = `---
app: Rounds I ran
panels:
  - view: form
    title: Ran
    fields: {km: number, where: text}
    save: rounds
    label: Add
  - view: table
    title: Rounds
    source: rounds
---
`;

/** Page code: the rows the outlay kind keeps, as its data note holds them. */
const KEPT = `const kept = () => na.fm("Kinds/Outlay data.md")?.outlay ?? [];`;
/** Page code: types a line into the open app's add line and saves it. */
const ADD = `const add = async (line) => {
    const el = na.view().contentEl;
    na.fill(el.querySelector(".gz-addline-input"), line);
    el.querySelector(".gz-addline-go").click();
  };`;

const SEALED = `---
kind: reading
fields:
  value: number
seal: true
---
`;

export default async function kinds(t) {
  const { check, run, expect, shot } = t;

  await check("a kind note opens as an app without asking, and its add line keeps a row beside it", async () => {
    const r = await run(`
      ${KEPT} ${ADD}
      await na.write("Kinds/Outlay.md", ${JSON.stringify(KIND)});
      await na.sleep(800);
      const { prompt } = await na.open("Kinds/Outlay", false);
      const state = na.state();
      await add("20 home soap");
      await na.until(() => kept().length === 1, 3000);
      await na.sleep(400);
      return { prompt, state, errors: na.errors(), kept: kept(), rows: na.view().contentEl.querySelectorAll("tbody tr").length, commands: na.commands().filter((c) => c.includes("outlay")) };`);
    await shot("kinds-kind.png");
    expect(r.prompt === undefined && r.state === "gizmo:Kinds/Outlay.md" && r.errors === 0, r);
    expect(r.kept.length === 1 && r.kept[0].amount === 20 && r.kept[0].memo === "soap" && r.rows === 1, r);
    return `${r.kept.length} row kept`;
  });

  await check("an app that links to the kind asks to read and change its rows, and a row it saves shows in another app", async () => {
    const r = await run(`
      ${KEPT} ${ADD}
      await na.write("Apps/Outlay budget.md", ${JSON.stringify(BUDGET)});
      await na.write("Apps/Outlay trip.md", ${JSON.stringify(TRIP)});
      await na.sleep(800);
      const { prompt } = await na.open("Apps/Outlay budget");
      await add("900 travel flight");
      await na.until(() => kept().length === 2, 3000);
      await na.sleep(600);
      const budget = na.text();
      const errors = na.errors();
      const trip = await na.open("Apps/Outlay trip");
      await na.sleep(600);
      return {
        prompt, budget, errors, tripPrompt: trip.prompt, tripErrors: na.errors(),
        travel: [...na.view().contentEl.querySelectorAll("tbody tr")].map((tr) => tr.innerText.replace(/\\s+/g, " ")),
        own: na.exists("Apps/Outlay budget data.md") || na.exists("Apps/Outlay trip data.md"),
      };`);
    await shot("kinds-trip.png");
    expect(JSON.stringify(r.prompt) === JSON.stringify(["Read the rows of Outlay", "Add and change rows of Outlay"]) || JSON.stringify(r.prompt) === JSON.stringify(["Add and change rows of Outlay", "Read the rows of Outlay"]), r);
    expect(JSON.stringify(r.tripPrompt) === JSON.stringify(["Read the rows of Outlay"]), r);
    expect(r.errors === 0 && r.tripErrors === 0 && r.budget.includes("920") && !r.own, r);
    expect(r.travel.length === 1 && r.travel[0].includes("900") && r.travel[0].includes("flight"), r);
    return r.travel[0];
  });

  await check("an app that only reads a kind offers no Delete and no time to move a row to in the side sheet; the kind note does", async () => {
    const r = await run(`
      const pick = async () => {
        na.view().contentEl.querySelector("tbody tr:not(.gz-ledger-group)")?.click();
        return await na.until(() => na.view().contentEl.querySelector(".gz-sheet.is-open"), 3000);
      };
      const look = (sheet) => ({
        open: !!sheet,
        actions: [...(sheet?.querySelectorAll(".gz-sheet-actions > button") ?? [])].map((b) => b.textContent),
        when: !!sheet?.querySelector("input[type=datetime-local]"),
      });
      await na.open("Apps/Outlay trip");
      await na.sleep(400);
      const reader = look(await pick());
      await na.open("Kinds/Outlay", false);
      await na.sleep(400);
      const own = look(await pick());
      return { reader, own, errors: na.errors() };`);
    await shot("kinds-reader-sheet.png");
    expect(r.reader.open && !r.reader.actions.includes("Delete") && !r.reader.when, r);
    expect(r.own.open && r.own.actions.includes("Delete") && r.own.when && r.errors === 0, r);
    return `reading app: [${r.reader.actions.join(", ")}]; kind note: [${r.own.actions.join(", ")}]`;
  });

  await check("Do… adds a row to a kind by its shortcut, with no app open", async () => {
    const r = await run(`
      ${KEPT}
      await na.open("Daily");
      const ran = await na.plugin().runtime.background.capture("outlay 7 food coffee");
      await na.until(() => kept().length === 3, 3000);
      return { ok: ran.ok, kept: kept().map((row) => row.memo) };`);
    expect(r.ok && r.kept.includes("coffee"), r);
    return r.kept.join(", ");
  });

  await check("Make a list a kind carries the rows over and points the app at the kind", async () => {
    const r = await run(`
      ${ADD}
      await na.write("Apps/Rounds.md", ${JSON.stringify(ROUNDS)});
      await na.sleep(800);
      await na.open("Apps/Rounds");
      await add("5 park");
      await na.until(() => na.fm("Apps/Rounds data.md")?.rounds?.length === 1, 3000);
      await add("8 river");
      await na.until(() => na.fm("Apps/Rounds data.md")?.rounds?.length === 2, 3000);
      app.commands.executeCommandById("gizmo:make-kind");
      const go = await na.until(() => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Make the kind"), 4000);
      const said = go?.closest(".modal")?.innerText.replace(/\\n+/g, " | ");
      // A row saved while the modal is open is carried over too, as the rows are at the click.
      await na.plugin().runtime.dataLayer.ledger.write("Apps/Rounds data.md", [{ op: "add", l: "rounds", row: "livehill0000001", v: { km: 11, where: "hill", at: "2026-11-01T08:00" } }]);
      go?.click();
      await na.until(() => na.fm("Apps/Rounds rows data.md")?.rounds?.length === 3, 5000);
      await na.sleep(1200);
      return {
        said, text: await na.read("Apps/Rounds.md"), kind: na.fm("Apps/Rounds rows.md"),
        moved: na.fm("Apps/Rounds rows data.md")?.rounds?.map((row) => row.where),
        shown: [...na.view().contentEl.querySelectorAll("tbody tr")].length, errors: na.errors(), state: na.state(),
        allow: !!na.button("Allow"),
      };`);
    await shot("kinds-made.png");
    expect(r.said?.includes("Carries its 2 rows over") && r.kind?.kind === "rounds" && r.kind.fields?.km === "number", r);
    expect(r.text.includes('save: "[[Rounds rows]]"') && r.text.includes('source: "[[Rounds rows]]"'), r);
    expect(JSON.stringify([...(r.moved ?? [])].sort()) === JSON.stringify(["hill", "park", "river"]), r);
    return `${r.moved.length} rows moved; app ${r.allow ? "asks again" : "still open"}`;
  });

  await check("Seal this kind's rows now, Check this kind's seals and Make a sealed extract say what they did on a sealed kind; the extract is a page beside it", async () => {
    const r = await run(`
      await na.write("Kinds/Readings.md", ${JSON.stringify(SEALED)});
      await na.sleep(800);
      await na.plugin().runtime.dataLayer.ledger.write("Kinds/Readings data.md", [{ op: "add", l: "reading", row: "livesea00000001", v: { value: 4.2, at: "2026-11-01T08:00" } }]);
      await na.open("Kinds/Readings");
      const notice = (re) => na.until(() => [...document.querySelectorAll(".notice")].map((n) => n.textContent).find((t) => re.test(t)), 5000);
      app.commands.executeCommandById("gizmo:seal-now");
      const sealed = await notice(/^Sealed \\d+ line/);
      app.commands.executeCommandById("gizmo:seal-check");
      const held = await notice(/^Readings: 1 seal holds/);
      app.commands.executeCommandById("gizmo:seal-extract");
      const made = await notice(/^Made Kinds\\/Readings sealed .+\\.html: one file that checks itself/);
      const path = /^Made (.+\\.html):/.exec(made ?? "")?.[1];
      const page = path ? await na.read(path) : "";
      if (path) await na.remove(path);
      return { sealed, held, made, page: page.length, errors: na.errors() };`);
    expect(r.sealed && r.held && r.made && r.page > 1000 && r.errors === 0, r);
    return `“${r.sealed}”; “${r.held.slice(0, 40)}…”; ${r.made.slice(0, 60)}…`;
  });
}
