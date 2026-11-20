// Sources: vault files, calendars, feeds, POST.
const FEEDS = ["https://hnrss.org/frontpage", "https://xkcd.com/atom.xml"];

const POST = `---
app: Ask an echo service what a request body looks like when it arrives
view: text
title: Echo
source: https://httpbin.org/post
body: {query: "x"}
text: "{json.query} sent as {headers.Content-Type}"
---
`;

export default async function sources(t) {
  const { check, run, expect } = t;

  await check("Bank: four month bars; flag the picked transaction with a reason; the amount is saved as a number", async () => {
    const r = await run(`
      await na.open("Apps/Bank");
      const el = na.view().contentEl;
      const bars = el.querySelectorAll(".gz-view-bar path.gz-bar").length;
      const row = el.querySelector(".gz-view-table tbody tr.gz-selectable");
      row.click();
      await na.sleep(500);
      const form = el.querySelector(".gz-view-form");
      na.fill(form.querySelector("input"), "Rent went up?");
      na.button("Flag it", form).click();
      await na.until(() => na.text(el.querySelector(".gz-view-list")).includes("Rent went up?"), 3000);
      const flagged = na.fm("Apps/Bank data.md")?.flagged;
      return { bars, row: row.textContent, list: na.text(el.querySelector(".gz-view-list")), flagged, type: typeof flagged?.[0]?.amount };`);
    expect(r.bars === 4, r);
    expect(r.list.includes("Rent went up?") && r.flagged?.length === 1 && r.type === "number" && r.flagged[0].description && r.flagged[0].date, r);
    return `4 bars; flagged ${JSON.stringify(r.flagged[0])}`;
  });

  await check("Bank: a row appended to bank.csv shows without reopening; renaming the file away and back", async () => {
    const r = await run(`
      await na.open("Apps/Bank");
      const el = na.view().contentEl;
      const top = () => el.querySelector(".gz-view-table tbody tr")?.textContent;
      const before = top();
      const csv = app.vault.getFileByPath("Finance/bank.csv");
      const text = await app.vault.read(csv);
      await app.vault.modify(csv, text.replace(/\\n?$/, "\\n") + "2026-11-18,Big TV,-2000.00,Shopping\\n");
      const appended = await na.until(() => top()?.includes("Big TV") && top(), 3000);
      await app.fileManager.renameFile(csv, "Finance/bank-old.csv");
      const gone = await na.until(() => el.querySelector(".gz-panel.gz-error") && na.text(el.querySelector(".gz-panel.gz-error")), 3000);
      await app.fileManager.renameFile(app.vault.getFileByPath("Finance/bank-old.csv"), "Finance/bank.csv");
      const back = await na.until(() => !el.querySelector(".gz-panel.gz-error") && top()?.includes("Big TV") && top(), 3000);
      return { before, appended, gone, back, errors: na.errors() };`);
    expect(r.appended && !r.before.includes("Big TV"), r);
    expect(typeof r.gone === "string" && r.gone.includes("Can't find Finance/bank.csv"), r);
    expect(r.back && r.errors === 0, r);
    return `appended row on top; "${r.gone.slice(0, 60)}"; back again`;
  });

  await check("Reading list: Save creates Reading/<title>.md; the table shows it; ticking read writes read: true; Save again says it exists", async () => {
    const r = await run(`
      await na.open("Apps/Reading list");
      const el = na.view().contentEl;
      const feed = el.querySelector(".gz-view-list");
      const item = feed.querySelector("li");
      const title = item.textContent.replace(/Save$/, "");
      const mark = na.notices.length;
      na.button("Save", item).click();
      const note = await na.until(() => app.vault.getFiles().find((f) => f.path.startsWith("Reading/")), 4000);
      await na.sleep(800);
      const fm = note && na.fm(note.path);
      const row = () => [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.includes(note.basename));
      const listed = !!(await na.until(row, 3000));
      row().querySelector('input[type="checkbox"]').click();
      const read = await na.until(() => na.fm(note.path)?.read === true, 3000);
      na.button("Save", feed.querySelector("li")).click();
      const notices = await na.noticesSince(mark, "already exists");
      return { title, path: note?.path, fm, listed, read: !!read, notices };`);
    expect(r.path && r.fm?.link?.startsWith("http") && r.fm.date && r.fm.at, r);
    expect(r.listed && r.read && r.notices.some((n) => n.endsWith("already exists")), r);
    return `${r.path}: ${Object.keys(r.fm).join(", ")}; read: true; ${r.notices.at(-1)}`;
  }, { net: FEEDS });

  await check("Week: the agenda shows Swim practice, and Bins out unless its only Thursday this week is skipped; Done logs it; an edit to family.ics shows", async () => {
    const r = await run(`
      await na.open("Apps/Week");
      const el = na.view().contentEl;
      const [agenda, , done] = el.querySelectorAll(".gz-panel");
      const items = () => [...agenda.querySelectorAll("li")].map((li) => li.textContent);
      const first = items();
      // Bins out is every Thursday except 26 November (EXDATE), so some weeks it has none to show.
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const days = [...Array(7).keys()].map((i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
      const binsDue = days.some((d) => d.getDay() === 4 && !(d.getFullYear() === 2026 && d.getMonth() === 10 && d.getDate() === 26));
      const swim = [...agenda.querySelectorAll("li")].find((li) => li.textContent.includes("Swim practice"));
      const mark = na.notices.length;
      na.button("Done", swim).click();
      const notices = await na.noticesSince(mark, "Logged");
      const logged = await na.until(() => na.text(done).includes("Swim practice") && na.text(done), 3000);
      const ics = app.vault.getFileByPath("Calendar/family.ics");
      const d = new Date(Date.now() + 2 * 86400000);
      const day = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
      const event = ["BEGIN:VEVENT", "UID:check@family.home", "DTSTART:" + day + "T090000", "DTEND:" + day + "T100000", "SUMMARY:Pick up the new glasses", "END:VEVENT", ""].join("\\r\\n");
      await app.vault.process(ics, (text) => text.replace("END:VCALENDAR", event + "END:VCALENDAR"));
      const edited = await na.until(() => items().some((i) => i.includes("Pick up the new glasses")), 3000);
      return { first, binsDue, notices, logged, edited: !!edited };`);
    expect(r.first.some((i) => i.includes("Swim practice")) && r.first.some((i) => i.includes("Bins out")) === r.binsDue, r);
    expect(r.notices.includes("Logged Swim practice") && r.logged, r);
    expect(r.edited, r);
    return `${r.first.length} items (Bins out ${r.binsDue ? "due" : "skipped this week"}); logged; the new event shows`;
  });

  await check("POST: the prompt asks to send a body to httpbin.org; the echo shows the body as JSON", async () => {
    const r = await run(`
      await na.write("Scratch/Echo.md", ${JSON.stringify(POST)});
      await na.sleep(800);
      const { prompt } = await na.open("Scratch/Echo");
      await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 10000);
      return { prompt, text: na.text(), errors: na.errors() };`);
    expect(r.prompt?.includes("Send a request body to httpbin.org") && r.prompt.includes("Fetch data from httpbin.org"), r);
    expect(r.errors === 0 && r.text.includes("x sent as application/json"), r);
    return r.text;
  }, { net: ["https://httpbin.org/get"] });
}
