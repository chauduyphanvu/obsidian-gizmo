// What the last fix rounds changed, seen in Obsidian.
import { CLOSE_OPENED, TABS } from "./apps.mjs";

const COVERS = `---
app: My records, with their sleeves
view: table
title: Records
source: notes
from: Books
columns: [cover, name]
cells: {cover: image}
---
`;
const OPENER = `---
app: Jump to my holiday plan
view: button
label: Open the plan
notify: Opening the plan
open: Plans/Holiday plan
---
`;
const FEED = JSON.stringify([
  { title: "Sneaky post", app: "Run me", view: "number", panels: [{ view: "text", text: "hi" }], link: "https://example.com/post" },
  { title: "Plain post", link: "https://example.com/plain" },
]);
const SAVER = `---
app: Keep posts from my saved feed as notes
view: list
title: Posts
source: Scratch/feed.json
item: "{title}"
action: Keep
save: Scratch/Kept/
name: "{title}"
notify: Kept {title}
---
`;
const JOTTER = `---
app: Jot a line into my scratch log
view: form
title: Jot
fields: {text: text}
append: Scratch/Jottings
line: "{text}"
label: Jot
---
`;

/** In the page: whether the active view shows the note's YAML as text, not the properties table. */
const RAW_YAML = `(() => {
  const v = na.view();
  const table = v.containerEl.querySelector(".metadata-container");
  return {
    state: na.state(), source: v.getState().source,
    head: v.containerEl.querySelector(".cm-content")?.innerText.split("\\n").slice(0, 2).join("|"),
    table: !!table && table.offsetParent !== null,
  };
})()`;

export default async function fixes(t) {
  const { check, run, expect } = t;

  await check("Edit source, from the view action and from the prompt's button, shows the YAML as text", async () => {
    const r = await run(`
      ${TABS}
      await na.open("Apps/Habits");
      [...na.view().containerEl.querySelectorAll(".view-action")].find((a) => a.getAttribute("aria-label") === "Edit source").click();
      await na.sleep(1000);
      const action = ${RAW_YAML};
      await na.write("Scratch/Records.md", ${JSON.stringify(COVERS)});
      await na.sleep(500);
      const { prompt } = await na.open("Scratch/Records", false);
      na.button("Edit source").click();
      await na.sleep(1000);
      const button = ${RAW_YAML};
      ${CLOSE_OPENED}
      return { action, prompt, button };`);
    for (const [from, s] of [["action", r.action], ["button", r.button]]) {
      expect(s.state.startsWith("markdown:") && s.source === true && s.head?.startsWith("---|app: ") && !s.table, { from, ...s });
    }
    return `${r.action.head}; ${r.button.head}`;
  });

  await check("an app with an image cell asks to load images from any site", async () => {
    // The check above left this tab on Records' source; another note first, so it opens as an app.
    const r = await run(`await na.open("Daily"); return (await na.open("Scratch/Records", false)).prompt;`);
    expect(r?.includes("Load images from any site (image cells)") && r.includes("Read notes in Books"), r);
    return r.join("; ");
  });

  await check("open: a note that doesn't exist says so and creates nothing; once it exists, it opens", async () => {
    const r = await run(`
      await na.write("Scratch/Opener.md", ${JSON.stringify(OPENER)});
      await na.sleep(500);
      await na.open("Scratch/Opener");
      const mark = na.notices.length;
      na.button("Open the plan").click();
      const notices = await na.noticesSince(mark, "Can't find");
      await na.sleep(500);
      const missing = { notices, state: na.state(), created: na.exists("Plans/Holiday plan.md") || na.exists("Plans") };
      await na.write("Plans/Holiday plan.md", "# Holiday plan\\n");
      await na.open("Scratch/Opener");
      na.button("Open the plan").click();
      await na.sleep(1000);
      return { missing, opened: na.state() };`);
    expect(r.missing.notices.includes("Can't find “Plans/Holiday plan”") && r.missing.state === "gizmo:Scratch/Opener.md" && !r.missing.created, r);
    expect(r.opened === "markdown:Plans/Holiday plan.md", r);
    return `“Can't find” and nothing made; then opened ${r.opened}`;
  });

  await check("Library: a book note deleted behind the app, then its status changed: That note is gone, and it isn't made again", async () => {
    const r = await run(`
      await na.write("Books/Throwaway.md", "---\\nstatus: to read\\n---\\n");
      await na.open("Apps/Library");
      const el = na.view().contentEl;
      const row = await na.until(() => [...el.querySelectorAll(".gz-view-table tbody tr")].find((tr) => tr.textContent.startsWith("Throwaway")), 3000);
      const select = row.querySelector("select");
      const disk = app.vault.adapter.basePath + "/Books/Throwaway.md";
      const mark = na.notices.length;
      // Gone from the disk (another app, a sync) before Obsidian has noticed.
      require("fs").unlinkSync(disk);
      na.choose(select, "reading");
      const notices = await na.noticesSince(mark, "gone");
      await na.sleep(1500);
      return { notices, onDisk: require("fs").existsSync(disk), inVault: na.exists("Books/Throwaway.md") };`);
    expect(r.notices.includes("That note is gone") && !r.onDisk && !r.inVault, r);
    return `${r.notices.join(" | ")}; not on disk, not in the vault`;
  });

  await check("a row saved into a folder never makes the new note an app, even when the data has app:", async () => {
    const r = await run(`
      await na.write("Scratch/feed.json", ${JSON.stringify(FEED)});
      await na.write("Scratch/Saver.md", ${JSON.stringify(SAVER)});
      await na.sleep(800);
      const { prompt } = await na.open("Scratch/Saver");
      const item = [...na.view().contentEl.querySelectorAll(".gz-view-list li")].find((li) => li.textContent.startsWith("Sneaky post"));
      na.button("Keep", item).click();
      const fm = await na.until(() => na.fm("Scratch/Kept/Sneaky post.md"), 3000);
      await app.workspace.openLinkText("Scratch/Kept/Sneaky post", "", false);
      await na.sleep(800);
      return { prompt, fm, state: na.state(), text: await na.read("Scratch/Kept/Sneaky post.md") };`);
    expect(r.fm && !("app" in r.fm) && !("view" in r.fm) && !("panels" in r.fm) && r.fm.link === "https://example.com/post", r);
    expect(r.state === "markdown:Scratch/Kept/Sneaky post.md", r);
    return `${r.state}; properties: ${Object.keys(r.fm).join(", ")}`;
  });

  await check("append to a missing note with the line ---: the new note doesn't start with a properties block", async () => {
    const r = await run(`
      await na.write("Scratch/Jotter.md", ${JSON.stringify(JOTTER)});
      await na.sleep(500);
      await na.open("Scratch/Jotter");
      // Composed, the form is an add line: the whole line is the text.
      const form = na.view().contentEl.querySelector("form.gz-addline");
      na.fill(form.querySelector(".gz-addline-input"), "---");
      na.button("Jot", form).click();
      const text = await na.until(() => na.read("Scratch/Jottings.md"), 3000);
      await na.sleep(500);
      return { text, fm: na.fm("Scratch/Jottings.md") ?? null };`);
    expect(r.text === "\n---\n" && r.fm === null, r);
    return JSON.stringify(r.text);
  });
}
