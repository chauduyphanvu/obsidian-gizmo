// Authoring: error links, the data inspector, key autocomplete, a component's Copy.
import { NET } from "./apps.mjs";

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
  await run(`await na.write("Scratch/Authoring.md", ${JSON.stringify(AUTHORING)}); await na.write("Scratch/Typing.md", "---\\napp: Typing\\n---\\n"); await na.sleep(800);`);

  await check("the problems card makes panel, block and input errors links", async () => {
    const r = await run(`
      await na.open("Scratch/Authoring");
      return [...na.view().contentEl.querySelectorAll(".na-error li")].map((li) => [li.textContent, !!li.querySelector("button.na-error-link")]);`);
    const linked = r.filter(([, l]) => l).map(([text]) => text.split(":")[0]);
    expect(linked.some((x) => x.startsWith("panel 2")) && linked.some((x) => x.startsWith("data.doses")) && linked.some((x) => x.startsWith('input "unused"')), r);
    return linked.join(", ");
  });

  await check("a panel error link opens the source as text with the cursor on that panel and focus in the editor", async () => {
    const r = await run(`
      await na.open("Scratch/Authoring");
      [...na.view().contentEl.querySelectorAll("button.na-error-link")].find((b) => b.textContent.startsWith("panel 2")).click();
      await na.sleep(1500);
      const v = na.view();
      const ed = v.editor;
      return { type: v.getViewType(), source: v.getState().source, cursor: ed?.getCursor(), line: ed?.getLine(ed.getCursor().line), focus: !!document.activeElement?.closest(".cm-content") };`);
    expect(r.type === "markdown" && r.source === true && r.cursor.line === 15 && r.cursor.ch === 0 && r.line === "  - view: gauge" && r.focus, r);
    return `line ${r.cursor.line}: ${r.line}`;
  });

  await check("the data block and input links land on their lines", async () => {
    const lines = [];
    for (const [prefix, want] of [["data.doses", 3], ['input "unused"', 10]]) {
      // The link left this tab on the source; the command turns it back into the app.
      const r = await run(`
        await na.open("Scratch/Authoring");
        if (na.view().getViewType() === "markdown") { app.commands.executeCommandById("note-apps:open-as-app"); await na.settle(); }
        [...na.view().contentEl.querySelectorAll("button.na-error-link")].find((b) => b.textContent.startsWith(${JSON.stringify(prefix)})).click();
        await na.sleep(1500);
        const ed = na.view().editor;
        return { c: ed.getCursor(), l: ed.getLine(ed.getCursor().line) };`);
      lines.push(`${prefix} → ${r.c.line}: ${r.l}`);
      expect(r.c.line === want, lines);
    }
    return lines.join(" | ");
  });

  await check("Broken: the panel 2 link lands on panel 2", async () => {
    const r = await run(`
      await na.open("Apps/Broken");
      const link = [...na.view().contentEl.querySelectorAll("button.na-error-link")].find((b) => b.textContent.startsWith("panel 2"));
      link.click();
      await na.sleep(1500);
      const ed = na.view().editor;
      return { text: link.textContent, state: na.state(), line: ed?.getLine(ed.getCursor().line), n: ed?.getCursor().line, focus: !!document.activeElement?.closest(".cm-content") };`);
    expect(r.state === "markdown:Apps/Broken.md" && r.line === "  - view: line" && r.focus, r);
    return `${r.text} → line ${r.n}: ${r.line}`;
  });

  await check("Planet Earth: Inspect data lists each source above the grid; a key copies its path; the action toggles it away", async () => {
    const r = await run(`
      await na.open("Apps/Planet Earth");
      const action = () => [...na.view().containerEl.querySelectorAll(".view-action")].find((a) => a.getAttribute("aria-label") === "Inspect data");
      action().click();
      const el = na.view().contentEl;
      const pane = await na.until(() => el.querySelector(".na-inspector .na-inspect-source") && el.querySelector(".na-inspector"), 10000);
      const shell = el.querySelector(".note-app");
      const above = [...shell.children].indexOf(pane) < [...shell.children].indexOf(shell.querySelector(".na-grid"));
      const urls = [...pane.querySelectorAll(".na-inspect-url")].map((u) => u.textContent);
      const quakes = [...pane.querySelectorAll(".na-inspect-source")].find((s) => s.textContent.includes("earthquake.usgs.gov"));
      const features = [...quakes.querySelectorAll(".na-tree details")].find((d) => d.querySelector(":scope > summary .na-key")?.textContent === "features");
      features.querySelector(":scope > summary").click();
      await na.sleep(300);
      const zero = features.querySelector(":scope > .na-children > details");
      zero.querySelector(":scope > summary").click();
      await na.sleep(300);
      const props = [...zero.querySelectorAll(":scope > .na-children > details")].find((d) => d.querySelector(":scope > summary .na-key")?.textContent === "properties");
      props.querySelector(":scope > summary").click();
      await na.sleep(300);
      const mag = [...props.querySelectorAll(".na-leaf button.na-key")].find((b) => b.textContent === "mag");
      mag.click();
      await na.sleep(300);
      const copied = await navigator.clipboard.readText();
      const badge = !!props.querySelector(".na-copied");
      action().click();
      await na.sleep(300);
      return { above, urls, copied, badge, gone: !el.querySelector(".na-inspector") };`);
    const hosts = new Set(r.urls.map((u) => new URL(u).host));
    expect(r.above && r.urls.length === new Set(r.urls).size && ["earthquake.usgs.gov", "services.swpc.noaa.gov", "api.open-meteo.com", "archive-api.open-meteo.com"].every((h) => hosts.has(h)), r);
    expect(r.copied === "features.0.properties.mag" && r.badge && r.gone, r);
    return `${r.urls.length} sources on ${hosts.size} hosts; copied ${r.copied}`;
  }, { net: NET["Planet Earth"] });

  await check("the inspector shows a secret's placeholder, never its value", async () => {
    const r = await run(`
      await app.secretStorage.setSecret("parcel-key", "pk-live-0123456789");
      await na.write("Scratch/Parcel.md", ${JSON.stringify(SECRET)});
      await na.sleep(800);
      const { prompt } = await na.open("Scratch/Parcel");
      [...na.view().containerEl.querySelectorAll(".view-action")].find((a) => a.getAttribute("aria-label") === "Inspect data").click();
      const el = na.view().contentEl;
      const pane = await na.until(() => el.querySelector(".na-inspector .na-inspect-source") && el.querySelector(".na-inspector"), 10000);
      await na.sleep(500);
      return { prompt, html: pane.outerHTML, page: el.innerHTML.includes("pk-live-0123456789"), url: pane.querySelector(".na-inspect-url")?.textContent, error: pane.querySelector(".na-inspect-error")?.textContent };`);
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
      const usage = el.querySelector(".na-example").textContent;
      const copy = na.button("Copy");
      copy.click();
      await na.sleep(300);
      return { usage, clip: await navigator.clipboard.readText(), label: copy.textContent };`);
    expect(r.clip === r.usage && r.label === "Copied", r);
    return "copied";
  });
}
