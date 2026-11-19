// Display: compare, goal, stack, edit dropdowns, cards, link cells.

const PLANTS = `---
app: Water my plants and note when I did
panels:
  - view: table
    title: Plants
    source: plants
    layout: cards
    columns: [name, room, thirsty]
    select: plant
    action: Watered
    save: waterings
    row: {plant: "{name}"}
    edit: [thirsty]
  - view: text
    title: Picked
    text: "$plant.name in the $plant.room"
  - view: list
    title: Watered
    source: waterings
    item: "{plant}"
---
`;
const PLANTS_DATA = `---
plants:
  - {name: Fern, room: hall, thirsty: true}
  - {name: Cactus, room: study, thirsty: false}
  - {name: Basil, room: kitchen, thirsty: true}
---
`;
const LINKS = `---
app: Places I keep coming back to
view: table
title: Bookmarks
source: marks
columns: [what, where]
cells: {where: link}
marks:
  - {what: Example, where: "https://example.com/"}
  - {what: Diary, where: "[[Daily]]"}
  - {what: Trap, where: "javascript:alert(1)"}
---
`;

/** In the page: the stacked bars of the right-most week, as class and height. */
const LAST_WEEK_BARS = `(() => {
  const bars = [...na.view().contentEl.querySelectorAll(".na-view-bar path.na-bar")];
  const xs = bars.map((b) => Number(b.getAttribute("d").match(/^M([\\d.]+)/)[1]));
  const right = Math.max(...xs);
  return bars.filter((b, i) => Math.abs(xs[i] - right) < 1).map((b) => {
    const m = b.getAttribute("d").match(/^M[\\d.]+,([\\d.]+)V([\\d.]+)/);
    return b.getAttribute("class").replace("na-bar ", "") + ":" + Math.round(Math.abs(Number(m[1]) - Number(m[2])));
  });
})()`;

export default async function display(t) {
  const { check, run, expect, press } = t;

  await check("Spending: an expense from the form changes This week, the compare line, the week's bar; the goal line shows", async () => {
    const r = await run(`
      // Last week's spending, so there is something to compare with.
      const last = new Date(Date.now() - 7 * 86400000);
      const at = last.getFullYear() + "-" + String(last.getMonth() + 1).padStart(2, "0") + "-" + String(last.getDate()).padStart(2, "0") + "T12:00";
      await na.write("Apps/Spending data.md", "---\\nspend:\\n  - {amount: 50, category: food, note: groceries, at: " + at + "}\\n---\\n");
      await na.open("Apps/Spending");
      const el = na.view().contentEl;
      const week = () => el.querySelector(".na-view-number");
      const before = { value: week().querySelector(".na-big").textContent, compare: week().querySelector(".na-compare")?.textContent, bars: ${LAST_WEEK_BARS} };
      const form = el.querySelector(".na-view-form");
      na.fill(form.querySelector('input[type="number"]'), "80");
      na.choose(form.querySelector("select"), "food");
      na.fill(form.querySelector('input[type="text"]'), "dinner out");
      na.button("Add", form).click();
      await na.until(() => week().querySelector(".na-big").textContent !== before.value, 3000);
      await na.sleep(500);
      return {
        before, value: week().querySelector(".na-big").textContent, compare: week().querySelector(".na-compare")?.textContent,
        bars: ${LAST_WEEK_BARS}, goal: el.querySelector(".na-view-bar .na-goal-label")?.textContent,
        goalLine: !!el.querySelector(".na-view-bar line.na-goal"),
      };`);
    expect(r.value === "$80.00" && /^▲ \$30\.00 \(60%\) vs previous$/.test(r.compare ?? ""), r);
    const height = (bars) => bars.reduce((s, b) => s + Number(b.split(":")[1]), 0);
    expect(height(r.bars) > height(r.before.bars) && r.goal === "goal $400" && r.goalLine, r);
    return `${r.before.value} → ${r.value}; ${r.compare}; week bar ${height(r.before.bars)} → ${height(r.bars)} px; ${r.goal}`;
  });

  await check("Spending: changing a row's category in the table restacks the bar and keeps focus", async () => {
    const r = await run(`
      await na.open("Apps/Spending");
      const el = na.view().contentEl;
      const before = ${LAST_WEEK_BARS};
      const row = [...el.querySelectorAll(".na-view-table tbody tr")].find((tr) => tr.textContent.includes("dinner out"));
      const select = row.querySelector("select");
      select.focus();
      na.choose(select, "fun");
      await na.until(() => na.fm("Apps/Spending data.md")?.spend?.some((s) => s.note === "dinner out" && s.category === "fun"), 3000);
      await na.sleep(800);
      return { before, after: ${LAST_WEEK_BARS}, focused: document.activeElement === select, connected: select.isConnected };`);
    expect(JSON.stringify(r.before) !== JSON.stringify(r.after) && r.focused && r.connected, r);
    return `${r.before.join(" ")} → ${r.after.join(" ")}; focus kept`;
  });

  await check("cards with select, action and edit: a click, Enter on another card, and a card's button each do only their own thing", async () => {
    await run(`
      await na.write("Scratch/Plants data.md", ${JSON.stringify(PLANTS_DATA)});
      await na.write("Scratch/Plants.md", ${JSON.stringify(PLANTS)});
      await na.sleep(800);
      await na.open("Scratch/Plants");`);
    const r1 = await run(`
      const el = na.view().contentEl;
      const cards = el.querySelectorAll(".na-card-item, .na-cards > *");
      const picked = () => na.text([...el.querySelectorAll(".na-panel")].find((p) => p.querySelector(".na-title")?.textContent === "Picked"));
      const card = (name) => [...el.querySelectorAll(".na-selectable")].find((c) => c.textContent.includes(name));
      card("Fern").click();
      await na.sleep(400);
      const first = picked();
      card("Cactus").focus();
      return { first, count: el.querySelectorAll(".na-selectable").length, focused: document.activeElement?.textContent?.slice(0, 20) };`);
    await press("Enter");
    const r2 = await run(`
      const el = na.view().contentEl;
      const picked = () => na.text([...el.querySelectorAll(".na-panel")].find((p) => p.querySelector(".na-title")?.textContent === "Picked"));
      const card = (name) => [...el.querySelectorAll(".na-selectable")].find((c) => c.textContent.includes(name));
      await na.sleep(400);
      const second = picked();
      na.button("Watered", card("Basil")).click();
      await na.until(() => na.fm("Scratch/Plants data.md")?.waterings?.length === 1, 3000);
      await na.sleep(400);
      const third = picked();
      card("Fern").querySelector('input[type="checkbox"]').click();
      await na.until(() => na.fm("Scratch/Plants data.md")?.plants?.[0]?.thirsty === false, 3000);
      await na.sleep(400);
      return { second, third, fourth: picked(), waterings: na.fm("Scratch/Plants data.md")?.waterings, plants: na.fm("Scratch/Plants data.md")?.plants, selected: [...el.querySelectorAll(".na-selected")].map((c) => c.textContent.slice(0, 12)) };`);
    expect(r1.count === 3 && r1.first.includes("Fern in the hall"), r1);
    expect(r2.second.includes("Cactus in the study") && r2.third.includes("Cactus in the study") && r2.fourth.includes("Cactus in the study"), r2);
    expect(r2.waterings?.length === 1 && r2.waterings[0].plant === "Basil" && r2.plants[0].thirsty === false && r2.plants[1].thirsty === false && r2.plants[2].thirsty === true, r2);
    return `click Fern, Enter Cactus, Watered Basil, untick Fern: picked stays Cactus, one watering (Basil)`;
  });

  await check("link cells: https opens outside, [[Daily]] opens the note, javascript: stays text", async () => {
    const r = await run(`
      await na.write("Scratch/Bookmarks.md", ${JSON.stringify(LINKS)});
      await na.sleep(800);
      await na.open("Scratch/Bookmarks");
      const cells = [...na.view().contentEl.querySelectorAll("tbody tr td:nth-child(2)")];
      const shape = cells.map((td) => ({ a: td.querySelector("a")?.className ?? null, href: td.querySelector("a")?.getAttribute("href") ?? null, text: td.textContent }));
      cells[1].querySelector("a").click();
      await na.sleep(800);
      const opened = na.state();
      app.commands.executeCommandById("app:go-back");
      await na.sleep(600);
      return { shape, opened };`);
    const [web, note, trap] = r.shape;
    expect(web.a === "external-link" && web.href === "https://example.com/", r);
    expect(note.a?.includes("internal-link") && r.opened === "markdown:Daily.md", r);
    expect(trap.a === null && trap.text === "javascript:alert(1)", r);
    return `external ${web.href}; [[Daily]] → ${r.opened}; trap is text`;
  });
}
