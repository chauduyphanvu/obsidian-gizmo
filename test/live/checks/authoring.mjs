// Authoring: error links, the data inspector, key autocomplete, a component's Copy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLOSE_OPENED, NET, TABS } from "./apps.mjs";

const AUTHORING = `---
app: Authoring check
data:
  doses:
    source: doses
    colour: red
  weather:
    source: https://api.open-meteo.com/v1/forecast?latitude=39.95&longitude=-75.17&current=temperature_2m
    pick: current
inputs:
  unused: [a, b]
panels:
  - view: number
    title: Doses logged
    source: doses
  - view: gauge
    title: Broken
  - view: number
    title: Temperature
    source: weather
    field: temperature_2m
  - view: list
    title: Books
    source: notes
    from: Books
    item: "{name}"
doses:
  - {name: Vitamin D, mg: 25}
  - {name: Iron, mg: 14}
---
Authoring check.
`;

const SECRET = `---
app: Check my parcel with a key I keep secret
view: text
title: Parcel
source: https://parcels.example.invalid/track?key={secret:parcel-key}
text: "{status}"
---
`;

export default async function authoring(t) {
  const { check, run, expect, press, type } = t;
  // Obsidian's first-open dialog takes the keys typed below until someone answers it (earlier check files do; a run of this one alone must),
  // and answering it opens the settings in a window of their own, which then takes the pop-up lists.
  await run(`[...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins")?.click(); await na.sleep(800); app.setting?.close?.(); await na.sleep(300);`);
  await run(`await na.write("Scratch/Authoring.md", ${JSON.stringify(AUTHORING)}); await na.write("Scratch/Typing.md", "---\\napp: Typing\\n---\\n"); await na.sleep(800);`);

  await check("the problems card makes panel, block and input errors links", async () => {
    const r = await run(`
      await na.open("Scratch/Authoring");
      return [...na.view().contentEl.querySelectorAll(".gz-error li")].map((li) => [li.textContent, !!li.querySelector("button.gz-error-link")]);`);
    const linked = r.filter(([, l]) => l).map(([text]) => text.split(":")[0]);
    expect(linked.some((x) => x.startsWith("panel 2")) && linked.some((x) => x.startsWith("data.doses")) && linked.some((x) => x.startsWith('input "unused"')), r);
    return linked.join(", ");
  });

  await check("a panel error link opens the source as text with the cursor on that panel and focus in the editor", async () => {
    const r = await run(`
      ${TABS}
      await na.open("Scratch/Authoring");
      [...na.view().contentEl.querySelectorAll("button.gz-error-link")].find((b) => b.textContent.startsWith("panel 2")).click();
      await na.sleep(1500);
      const v = na.view();
      const ed = v.editor;
      const out = { type: v.getViewType(), source: v.getState().source, cursor: ed?.getCursor(), line: ed?.getLine(ed.getCursor().line), focus: !!document.activeElement?.closest(".cm-content") };
      ${CLOSE_OPENED}
      return out;`);
    expect(r.type === "markdown" && r.source === true && r.cursor.line === 15 && r.cursor.ch === 0 && r.line === "  - view: gauge" && r.focus, r);
    return `line ${r.cursor.line}: ${r.line}`;
  });

  await check("the data block and input links land on their lines", async () => {
    const lines = [];
    for (const [prefix, want] of [["data.doses", 3], ['input "unused"', 10]]) {
      // The link opens the source beside the app, closed again after; should this tab be on the source, the command turns it back into the app.
      const r = await run(`
        ${TABS}
        await na.open("Scratch/Authoring");
        if (na.view().getViewType() === "markdown") { app.commands.executeCommandById("gizmo:open-as-app"); await na.settle(); }
        [...na.view().contentEl.querySelectorAll("button.gz-error-link")].find((b) => b.textContent.startsWith(${JSON.stringify(prefix)})).click();
        await na.sleep(1500);
        const ed = na.view().editor;
        const at = { c: ed.getCursor(), l: ed.getLine(ed.getCursor().line) };
        ${CLOSE_OPENED}
        return at;`);
      lines.push(`${prefix} → ${r.c.line}: ${r.l}`);
      expect(r.c.line === want, lines);
    }
    return lines.join(" | ");
  });

  await check("Broken: the panel 2 link lands on panel 2", async () => {
    const r = await run(`
      ${TABS}
      await na.open("Apps/Broken");
      const link = [...na.view().contentEl.querySelectorAll("button.gz-error-link")].find((b) => b.textContent.startsWith("panel 2"));
      link.click();
      // The split and its editor come when the note is read, which can take longer than a fixed wait.
      await na.until(() => na.state() === "markdown:Apps/Broken.md" && na.view().editor?.getLine(na.view().editor.getCursor().line) === "  - view: line", 5000);
      const ed = na.view().editor;
      const where = (l) => (l.getRoot() === app.workspace.rootSplit ? "main" : l.getRoot() === app.workspace.leftSplit ? "left" : l.getRoot() === app.workspace.rightSplit ? "right" : "window");
      const out = { text: link.textContent, state: na.state(), line: ed?.getLine(ed.getCursor().line), n: ed?.getCursor().line, focus: !!document.activeElement?.closest(".cm-content"),
        // Should it fail: every tab on Apps/Broken.md, where it is and what it shows, and the active one.
        tabs: app.workspace.getLeavesOfType("markdown").concat(app.workspace.getLeavesOfType("gizmo")).filter((l) => l.view.file?.path === "Apps/Broken.md").map((l) => \`\${where(l)}:\${l.view.getViewType()}:\${l.getViewState().state?.source ?? ""}\`),
        active: app.workspace.activeLeaf && \`\${where(app.workspace.activeLeaf)}:\${app.workspace.activeLeaf.view.getViewType()}:\${app.workspace.activeLeaf.view.file?.path}\` };
      ${CLOSE_OPENED}
      return out;`);
    expect(r.state === "markdown:Apps/Broken.md" && r.line === "  - view: line" && r.focus, r);
    return `${r.text} → line ${r.n}: ${r.line}`;
  });

  await check("Planet Earth: Inspect data lists each source above the panels; a key copies its path; the menu item toggles it away", async () => {
    const r = await run(`
      await na.open("Apps/Planet Earth");
      na.menuItem("Inspect data");
      const el = na.view().contentEl;
      const pane = await na.until(() => el.querySelector(".gz-inspector .gz-inspect-source") && el.querySelector(".gz-inspector"), 10000);
      const shell = el.querySelector(".gizmo");
      const above = [...shell.children].indexOf(pane) < [...shell.children].indexOf(shell.querySelector(".gz-body"));
      const urls = [...pane.querySelectorAll(".gz-inspect-url")].map((u) => u.textContent);
      const quakes = [...pane.querySelectorAll(".gz-inspect-source")].find((s) => s.textContent.includes("earthquake.usgs.gov"));
      const features = [...quakes.querySelectorAll(".gz-tree details")].find((d) => d.querySelector(":scope > summary .gz-key")?.textContent === "features");
      features.querySelector(":scope > summary").click();
      await na.sleep(300);
      const zero = features.querySelector(":scope > .gz-children > details");
      zero.querySelector(":scope > summary").click();
      await na.sleep(300);
      const props = [...zero.querySelectorAll(":scope > .gz-children > details")].find((d) => d.querySelector(":scope > summary .gz-key")?.textContent === "properties");
      props.querySelector(":scope > summary").click();
      await na.sleep(300);
      const mag = [...props.querySelectorAll(".gz-leaf button.gz-key")].find((b) => b.textContent === "mag");
      mag.click();
      await na.sleep(300);
      const copied = await navigator.clipboard.readText();
      const badge = !!props.querySelector(".gz-copied");
      na.menuItem("Inspect data");
      await na.sleep(300);
      return { above, urls, copied, badge, gone: !el.querySelector(".gz-inspector") };`);
    const hosts = new Set(r.urls.map((u) => new URL(u).host));
    expect(r.above && r.urls.length === new Set(r.urls).size && ["earthquake.usgs.gov", "services.swpc.noaa.gov", "api.open-meteo.com"].every((h) => hosts.has(h)), r);
    expect(r.copied === "features.0.properties.mag" && r.badge && r.gone, r);
    return `${r.urls.length} sources on ${hosts.size} hosts; copied ${r.copied}`;
  }, { net: NET["Planet Earth"] });

  await check("the inspector shows a secret's placeholder, never its value", async () => {
    const r = await run(`
      await app.secretStorage.setSecret("parcel-key", "pk-live-0123456789");
      await na.write("Scratch/Parcel.md", ${JSON.stringify(SECRET)});
      await na.sleep(800);
      const { prompt } = await na.open("Scratch/Parcel");
      na.menuItem("Inspect data");
      const el = na.view().contentEl;
      const pane = await na.until(() => el.querySelector(".gz-inspector .gz-inspect-source") && el.querySelector(".gz-inspector"), 10000);
      await na.sleep(500);
      return { prompt, html: pane.outerHTML, page: el.innerHTML.includes("pk-live-0123456789"), url: pane.querySelector(".gz-inspect-url")?.textContent, error: pane.querySelector(".gz-inspect-error")?.textContent };`);
    expect(r.prompt?.includes('Use your saved secret "parcel-key"'), r.prompt);
    expect(r.url === "https://parcels.example.invalid/track?key={secret:parcel-key}" && !r.html.includes("pk-live-0123456789") && !r.page, { url: r.url, error: r.error, leaked: r.page });
    return `${r.url}; ${r.error ?? "no error"}`;
  });

  await check("typing keys in an app note's source offers keys and values, and picking inserts them", async () => {
    await run(`
      const file = na.file("Scratch/Typing.md");
      const leaf = app.workspace.getLeaf(false);
      await na.plugin().showSource(leaf, file);
      await na.sleep(800);
      const ed = leaf.view.editor;
      ed.setValue("---\\napp: Typing\\npanels:\\n  - \\n---\\n");
      ed.setCursor({ line: 3, ch: 4 });
      ed.focus();
      await na.sleep(300);`);
    const pop = () => run(`const s = app.workspace.editorSuggest.currentSuggest; return s?.isOpen ? [...s.suggestEl.querySelectorAll(".suggestion-item")].map((i) => i.textContent) : [];`);
    await type("vi");
    const first = await pop();
    await t.shot("suggest.png");
    expect(first.length && first[0].startsWith("view"), { first });
    await press("Enter");
    await t.sleep(400);
    const afterKey = await run(`return na.view().editor.getLine(3);`);
    expect(afterKey === "  - view: ", { afterKey });
    const values = await pop();
    expect(values.some((v) => v.startsWith("table")), { values });
    await type("ta");
    await press("Enter");
    await t.sleep(400);
    const line = await run(`return na.view().editor.getLine(3);`);
    expect(line === "  - view: table", { line });
    await run(`const ed = na.view().editor; ed.replaceRange("\\n    ", { line: 3, ch: ed.getLine(3).length }); ed.setCursor({ line: 4, ch: 4 });`);
    await type("col");
    await press("Enter");
    await t.sleep(400);
    const line4 = await run(`return na.view().editor.getLine(4);`);
    expect(line4 === "    columns: ", { line4 });
    return `${first.slice(0, 2).join(" | ")}; view: table; columns:`;
  });

  await check("no pop-up on an empty indented line", async () => {
    const r = await run(`
      const ed = na.view().editor;
      ed.setValue("---\\napp: Typing\\npanels:\\n  - view: table\\n    \\n---\\nbody text");
      ed.setCursor({ line: 4, ch: 4 });
      ed.focus();
      await na.sleep(400);
      const s = app.workspace.editorSuggest.currentSuggest;
      return s?.isOpen ? s.suggestEl.querySelectorAll(".suggestion-item").length : 0;`);
    expect(r === 0, `${r} suggestions on an empty line`);
    return "none";
  });

  await check("Components/Ticker: Copy puts the usage snippet on the clipboard", async () => {
    const r = await run(`
      await na.open("Components/Ticker");
      const el = na.view().contentEl;
      const usage = el.querySelector(".gz-example").textContent;
      const copy = na.button("Copy");
      copy.click();
      await na.sleep(300);
      return { usage, clip: await navigator.clipboard.readText(), label: copy.textContent };`);
    expect(r.clip === r.usage && r.label === "Copied", r);
    return "copied";
  });

  // ---- Insert panel -------------------------------------------------------------------------------

  const INSERT_LINES = INSERT.split("\n");
  const AT = INSERT_LINES.indexOf("    text: Insert check") + 1;
  const WITH_TABLE = [...INSERT_LINES.slice(0, AT), ...TABLE_PANEL, ...INSERT_LINES.slice(AT)].join("\n");
  const picker = async (word) => {
    await run(`await na.until(() => document.querySelector(".prompt .prompt-input"), 3000);`);
    await type(word);
    return run(`return [...document.querySelectorAll(".prompt .suggestion-item")].map((i) => i.textContent);`);
  };

  await check("Insert panel: choosing table adds exactly its lines at the end of panels:, the cursor on its source, and one undo takes them away", async () => {
    await run(`
      await na.write("Scratch/Insert.md", ${JSON.stringify(INSERT)});
      await na.sleep(800);
      const leaf = app.workspace.getLeaf(false);
      await na.plugin().showSource(leaf, na.file("Scratch/Insert.md"));
      await na.sleep(800);
      leaf.view.editor.setCursor({ line: 0, ch: 0 });
      leaf.view.editor.focus();`);
    const offered = await run(`const v = na.view(); return app.commands.commands["gizmo:insert-panel"].editorCheckCallback(true, v.editor, v);`);
    expect(offered === true, "not offered in an app note");
    await run(`app.commands.executeCommandById("gizmo:insert-panel");`);
    const items = await picker("table");
    await t.shot("insert-panel.png");
    expect(items.length && items[0].startsWith("table"), items);
    expect(items.some((i) => i.startsWith("table") && i.includes("Rows in a table")), items);
    await press("Enter");
    await t.sleep(500);
    const r = await run(`
      const ed = na.view().editor;
      const c = ed.getCursor();
      return { text: ed.getValue(), line: ed.getLine(c.line), at: c, rest: ed.getLine(c.line).slice(c.ch), modal: !!document.querySelector(".prompt") };`);
    expect(r.text === WITH_TABLE, { got: r.text.split("\n").slice(AT - 2, AT + 6) });
    // The cursor is on the first value to change, the source after view: table.
    expect(r.at.line === AT + 1 && r.rest === "spending" && r.line === "    source: spending" && !r.modal, r);
    const undone = await run(`const ed = na.view().editor; ed.undo(); return ed.getValue();`);
    expect(undone === INSERT, "one undo should restore the original text");
    const redone = await run(`const ed = na.view().editor; ed.redo(); return ed.getValue();`);
    expect(redone === WITH_TABLE, "redo should bring the panel back");
    return `table at line ${AT}, cursor on "${r.rest}" at line ${r.at.line}; one undo restores`;
  });

  await check("Insert panel: the note with the new panel still opens as an app with no problems card", async () => {
    const r = await run(`
      await na.view().save();
      await na.until(async () => (await na.read("Scratch/Insert.md")) === ${JSON.stringify(WITH_TABLE)} && na.fm("Scratch/Insert.md")?.panels?.length === 3, 5000);
      await na.open("Scratch/Insert");
      if (na.view().getViewType() === "markdown") { app.commands.executeCommandById("gizmo:open-as-app"); await na.settle(); }
      await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 5000);
      return { state: na.state(), errors: na.errors(), problems: na.text().includes("keys have problems"), tables: na.view().contentEl.querySelectorAll("table").length, text: na.text() };`);
    expect(r.state === "gizmo:Scratch/Insert.md" && r.errors === 0 && !r.problems && r.tables === 1, r);
    return `3 panels, one table; ${r.text.slice(0, 80)}`;
  });

  await check("Insert panel: it isn't offered in a plain note, and a component note is offered it", async () => {
    await run(`
      await na.write("Scratch/Plain.md", "---\\ntitle: Plain\\n---\\nJust a note\\n");
      await na.write("Scratch/Bare.md", "Just a note, no frontmatter\\n");
      await na.write("Scratch/Part.md", "---\\ncomponent: A part\\npanels:\\n  - view: text\\n    text: hi\\n---\\n");
      await na.sleep(800);`);
    const offered = {};
    for (const name of ["Plain", "Bare", "Part"]) {
      offered[name] = await run(`
        const file = na.file("Scratch/${name}.md");
        const leaf = app.workspace.getLeaf(false);
        if (${name === "Part"}) await na.plugin().showSource(leaf, file); else await leaf.openFile(file);
        await na.sleep(600);
        const v = na.view();
        const direct = app.commands.commands["gizmo:insert-panel"].editorCheckCallback(true, v.editor, v);
        app.commands.executeCommandById("gizmo:insert-panel");
        await na.sleep(300);
        return { direct, modal: !!document.querySelector(".prompt") };`);
    }
    // Close the list the component note opened before anything is judged, or it stays over the next check.
    await press("Escape");
    expect(!offered.Plain.direct && !offered.Plain.modal, offered);
    expect(!offered.Bare.direct && !offered.Bare.modal, offered);
    expect(offered.Part.direct === true && offered.Part.modal === true, offered);
    return "plain: no, no frontmatter: no, component: yes";
  });

  await check("Insert panel: a note with one panel typed at the top level says so and is left alone", async () => {
    const r = await run(`
      await na.write("Scratch/OnePanel.md", ${JSON.stringify(ONE_PANEL)});
      await na.sleep(800);
      const leaf = app.workspace.getLeaf(false);
      await na.plugin().showSource(leaf, na.file("Scratch/OnePanel.md"));
      await na.sleep(800);
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:insert-panel");
      const notices = await na.noticesSince(mark, "one panel");
      return { notices, modal: !!document.querySelector(".prompt"), text: leaf.view.editor.getValue() };`);
    expect(r.notices.includes("This note has one panel typed at the top level; move it under panels: to add more") && !r.modal && r.text === ONE_PANEL, r);
    return r.notices.join(" | ");
  });

  // ---- New app from the gallery -------------------------------------------------------------------

  const gallery = (name) => readFileSync(resolve(import.meta.dirname, "../../../gallery", name), "utf8");
  const copy = (name) => run(`
    const mark = na.notices.length;
    const before = app.vault.getMarkdownFiles().length;
    app.commands.executeCommandById("gizmo:new-app-from-gallery");
    await na.until(() => document.querySelector(".prompt .prompt-input"), 3000);
    return { mark, before };`).then(async (r) => {
    const items = await picker(name);
    await press("Enter");
    await t.sleep(800);
    // A kit with params asks for your values first, filled in with the gallery's: Copy takes them as they are.
    const setUp = await run(`
      const modal = [...document.querySelectorAll(".modal")].find((m) => m.querySelector(".modal-title")?.textContent.startsWith("Set up "));
      if (!modal) return null;
      const out = { title: modal.querySelector(".modal-title").textContent, values: [...modal.querySelectorAll("input")].map((i) => i.value) };
      na.button("Copy", modal).click();
      await na.sleep(800);
      return out;`);
    return { ...r, items, setUp };
  });

  // An app you have already is offered to open instead: what that says and offers, then Cancel, which leaves it.
  const HAVE_IT = `
    const modal = await na.until(() => [...document.querySelectorAll(".modal")].find((m) => m.textContent.includes("You already have")), 3000);
    const have = { said: modal?.querySelector("p")?.textContent, buttons: modal ? [...modal.querySelectorAll("button")].map((b) => b.textContent) : [] };
    if (modal) na.button("Cancel", modal).click();
    await na.sleep(500);
    have.open = !!document.querySelector(".prompt") || !!modal?.isConnected;`;

  await check("New app from the gallery: Budget brings the Spend kind, both copied as written, and opens as an app", async () => {
    // The capture check's own app called Spend would be a second note of the kind's name, which stops the copy.
    await run(`await na.remove("Apps/Spend.md"); await na.sleep(500);`);
    const r = await copy("Budget");
    await t.shot("gallery-picker.png");
    const after = await run(`
      await na.until(() => na.exists("Budget.md"), 5000);
      await na.until(() => na.state() === "gizmo:Budget.md", 5000);
      await na.settle();
      const { prompt } = await na.open("Budget", false);
      return { text: await na.read("Budget.md"), kind: await na.read("Spend.md"), state: na.state(), prompt, errors: na.errors(), problems: na.text().includes("keys have problems"), after: app.vault.getMarkdownFiles().length, modal: !!document.querySelector(".prompt") };`);
    expect(r.items.length && r.items[0].startsWith("Budget") && r.items[0].includes("Know where the month will end before it ends"), r.items);
    expect(after.text === gallery("Apps/Budget.md") && after.kind === gallery("Kinds/Spend.md"), "the copies differ from gallery/Apps/Budget.md and gallery/Kinds/Spend.md");
    expect(after.state === "gizmo:Budget.md" && !after.problems && after.errors === 0 && after.after === r.before + 2 && !after.modal, after);
    return `${after.prompt ? `asks: ${after.prompt.join("; ")}` : "opens with no prompt"}; ${r.before} → ${after.after} notes`;
  });

  await check("New app from the gallery: Trip planner brings Destination weather, uses the Spend that Budget brought, and asks for its permissions on first open", async () => {
    const r = await copy("Trip planner");
    const after = await run(`
      await na.until(() => na.exists("Trip planner.md") && na.exists("Destination weather.md"), 5000);
      await na.until(() => na.state() === "gizmo:Trip planner.md", 5000);
      await na.settle();
      const { prompt } = await na.open("Trip planner", false);
      return { app: await na.read("Trip planner.md"), part: await na.read("Destination weather.md"), kind: await na.read("Spend.md"), state: na.state(), prompt, after: app.vault.getMarkdownFiles().length,
        allowed: app.plugins.plugins["gizmo"].granted("Trip planner.md") };`);
    expect(r.items.length && r.items[0].startsWith("Trip planner"), r.items);
    expect(after.app === gallery("Apps/Trip planner.md") && after.part === gallery("Components/Destination weather.md") && after.kind === gallery("Kinds/Spend.md"), "the copies differ from the gallery's");
    expect(after.state === "gizmo:Trip planner.md" && after.after === r.before + 2, after);
    expect(after.allowed === undefined && after.prompt?.some((p) => p.includes("api.open-meteo.com")), after);
    return `asks ${after.prompt.length} things; ${r.before} → ${after.after} notes`;
  });

  await check("New app from the gallery: Practice, three lines on the Tracker kit, brings the kit and opens with no problems", async () => {
    const r = await copy("Practice");
    const after = await run(`
      await na.until(() => na.exists("Practice.md") && na.exists("Tracker kit.md"), 5000);
      await na.until(() => na.state() === "gizmo:Practice.md", 5000);
      await na.settle();
      const { prompt } = await na.open("Practice");
      await na.until(() => !na.view().contentEl.querySelector(".gz-loading"), 5000);
      return { app: await na.read("Practice.md"), kit: await na.read("Tracker kit.md"), state: na.state(), prompt, errors: na.errors(), problems: na.text().includes("keys have problems"),
        titles: [...na.view().contentEl.querySelectorAll(".gz-panel .gz-title")].map((t) => t.textContent), after: app.vault.getMarkdownFiles().length };`);
    expect(r.items.length && r.items[0].startsWith("Practice"), r.items);
    expect(r.setUp?.title === "Set up Practice" && JSON.stringify(r.setUp.values) === JSON.stringify(["practice", "minutes", "30"]), r.setUp);
    expect(after.app === gallery("Apps/Practice.md") && after.kit === gallery("Components/Tracker kit.md"), "the copies differ from the gallery's");
    expect(after.state === "gizmo:Practice.md" && after.prompt === undefined && after.errors === 0 && !after.problems && after.after === r.before + 2, after);
    // Composed: the answer (Latest, then This week) before the form that adds to it, then the rest.
    expect(JSON.stringify(after.titles) === JSON.stringify(["Latest", "This week", "Log my practice", "My practice against my goal", "Entries"]), after.titles);
    await run(`for (const p of ["Practice.md", "Tracker kit.md"]) await na.remove(p); await na.sleep(500);`);
    return `${r.before} → ${after.after} notes; ${after.titles.join(", ")}`;
  });

  await check("New app from the gallery: the same app again says it exists and creates nothing, and keeps what the note now holds", async () => {
    const r = await run(`
      const f = na.file("Budget.md");
      await app.vault.modify(f, (await app.vault.read(f)) + "\\nMy own line.\\n");
      return { before: app.vault.getMarkdownFiles().length, text: await na.read("Budget.md") };`);
    await copy("Budget");
    const after = await run(`${HAVE_IT}
      return { ...have, after: app.vault.getMarkdownFiles().length, text: await na.read("Budget.md") };`);
    expect(after.said === "You already have “Budget”." && after.buttons.includes("Open yours") && after.buttons.includes("Cancel") && !after.open, after);
    expect(after.after === r.before && after.text === r.text, after);
    return after.said;
  });

  await check("New app from the gallery: a note of that name in another folder counts too", async () => {
    const r = await run(`
      await app.vault.create("Apps/Practice.md", "My own practice log.\\n");
      await na.sleep(300);
      return { before: app.vault.getMarkdownFiles().length };`);
    await copy("Practice");
    const after = await run(`${HAVE_IT} return { ...have, after: app.vault.getMarkdownFiles().length, root: na.exists("Practice.md") };`);
    await run(`await na.remove("Apps/Practice.md"); await na.sleep(300);`);
    expect(after.said === "You already have “Practice”." && !after.open, after);
    expect(after.after === r.before && !after.root, after);
    return after.said;
  });

  await check("New app from the gallery: a component that is already there word for word is reused; one that differs stops it", async () => {
    // Trip planner is gone but its component stays: only the app is made, with no notice.
    const first = await run(`
      await na.remove("Trip planner.md");
      await na.sleep(500);
      return { mark: na.notices.length, before: app.vault.getMarkdownFiles().length };`);
    await copy("Trip planner");
    const reused = await run(`
      await na.until(() => na.exists("Trip planner.md"), 5000);
      await na.sleep(500);
      return { notices: na.notices.slice(${first.mark}), after: app.vault.getMarkdownFiles().length, part: await na.read("Destination weather.md") };`);
    expect(reused.after === first.before + 1 && reused.part === gallery("Components/Destination weather.md") && !reused.notices.some((n) => n.includes("already exists")), reused);

    // Now the component has been changed: copying the app again would need a different one.
    const second = await run(`
      const part = na.file("Destination weather.md");
      await app.vault.modify(part, (await app.vault.read(part)) + "\\nMy own line.\\n");
      await na.remove("Trip planner.md");
      await na.sleep(500);
      return { mark: na.notices.length, before: app.vault.getMarkdownFiles().length };`);
    await copy("Trip planner");
    const stopped = await run(`
      const notices = await na.noticesSince(${second.mark}, "already exists");
      return { notices, after: app.vault.getMarkdownFiles().length, app: na.exists("Trip planner.md"), part: await na.read("Destination weather.md") };`);
    expect(stopped.notices.includes("“Destination weather” already exists and isn't the one “Trip planner” needs") && !stopped.app && stopped.after === second.before, stopped);
    expect(stopped.part.endsWith("My own line.\n"), "the changed component was overwritten");
    await run(`for (const p of ["Budget.md", "Destination weather.md", "Trip planner.md", "Spend.md"]) await na.remove(p); await na.sleep(500);`);
    return `reused it silently, then: ${stopped.notices.join(" | ")}`;
  });
}

const INSERT = `---
app: Insert check
panels:
  - view: number
    title: Spent
    source: spending
    field: amount
    agg: sum
  - view: text
    text: Insert check
spending:
  - {at: 2026-01-02, amount: 12.5, category: food}
  - {at: 2026-01-03, amount: 8, category: home}
---
Insert check.
`;

/** The first example of the table view, as the command writes it under panels:. */
const TABLE_PANEL = [
  "  - view: table",
  "    source: spending",
  "    columns: [at, amount, category]",
  '    format: {amount: "$0,0.00", at: date}',
];

const ONE_PANEL = "---\napp: One panel\nview: text\ntext: hi\n---\n";
