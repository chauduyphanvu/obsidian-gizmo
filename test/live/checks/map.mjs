// The automation map: every app with what it may do, which apps can change a note, Revoke and a new link key.

export default async function map(t) {
  const { check, run, expect, shot } = t;

  await check("the map lists every app with its state, asks and what makes it act", async () => {
    const r = await run(`
      app.commands.executeCommandById("gizmo:open-map");
      const box = await na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-map .gz-map-app"), 5000) && document.querySelector(".workspace-leaf.mod-active .gz-map");
      const card = (name) => [...box.querySelectorAll(".gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === name);
      const meds = card("Meds");
      const calls = card("Calls");
      return {
        summary: box.querySelector(".gz-map-summary")?.textContent,
        names: [...box.querySelectorAll(".gz-map-apps > .gz-map-app .gz-map-app-head > .gz-title")].map((e) => e.textContent),
        meds: meds && { state: meds.querySelector(".gz-map-state").textContent, text: meds.innerText },
        calls: calls && calls.innerText,
      };`);
    expect(r.names.includes("Meds") && r.names.includes("Calls") && r.names.includes("Errands"), r);
    expect(r.meds?.state === "Allowed" && r.meds.text.includes("Add lines to Daily.md") && r.meds.text.includes("Shortcut “Took meds” (took-meds)"), r);
    expect(r.calls?.includes("then runs “add” in Errands"), r);
    await shot("map.png");
    return r.summary;
  });

  await check("which apps can change a note: Meds for its data note and Daily", async () => {
    const r = await run(`
      await na.openMd("Daily.md", "preview");
      app.commands.executeCommandById("gizmo:who-changes-note");
      const card = await na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-map-writers"), 5000);
      return card?.innerText;`);
    expect(r?.includes("Apps that can change Daily") && r.includes("Meds: Add lines to Daily.md"), r);
    return r.split("\n").slice(1, 3).join(" | ");
  });

  await check("Revoke stops an app at once: its shortcut asks to open it, its pin goes, and allowing it again brings both back", async () => {
    const r = await run(`
      app.commands.executeCommandById("gizmo:open-map");
      const box = await na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-map .gz-map-app"), 5000) && document.querySelector(".workspace-leaf.mod-active .gz-map");
      const meds = [...box.querySelectorAll(".gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === "Meds");
      const pinned = () => na.status().some((s) => s.startsWith("Doses today"));
      const before = pinned();
      na.button("Revoke", meds).click();
      await na.until(() => !na.plugin().runtime.store.grants["Apps/Meds.md"], 3000);
      const pinGone = await na.until(() => !pinned(), 3000);
      const count = () => na.fm("Apps/Meds data.md")?.doses?.length ?? 0;
      const doses = count();
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:Apps/Meds.md:took-meds");
      const notices = await na.noticesSince(mark, "Open Meds");
      await na.sleep(500);
      const state = await na.until(() => {
        const c = [...document.querySelectorAll(".workspace-leaf.mod-active .gz-map .gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === "Meds");
        return c?.querySelector(".gz-map-state")?.textContent === "Not allowed: you revoked it" && "Not allowed: you revoked it";
      }, 3000);
      const reopened = await na.open("Apps/Meds");
      const back = await na.until(() => pinned(), 5000);
      return { before, pinGone: !!pinGone, wrote: count() !== doses, notices, state, prompt: reopened.prompt, back: !!back };`);
    expect(r.before && r.pinGone && !r.wrote && r.notices.includes("Open Meds once to allow it"), r);
    expect(r.state === "Not allowed: you revoked it" && r.prompt?.length && r.back, r);
    return r.notices.join(" | ");
  });

  await check("an allowed app that comes to ask for a new host is paused, not dropped: the status bar and map say so, it is told once, and Allow clears it", async () => {
    const r = await run(`
      const path = "Apps/Pausable.md";
      await na.write(path, "---\\napp: Pausable\\npanels:\\n  - view: button\\n    label: Did it\\n    save: done\\n---\\nA button, then a weather panel added later.\\n");
      await na.until(() => na.fm(path)?.app, 3000);
      await na.open("Apps/Pausable");
      const allowed = !!(await na.until(() => na.plugin().runtime.store.grants[path], 3000));
      await app.fileManager.processFrontMatter(na.file(path), (fm) => {
        fm.panels.push({ view: "number", title: "Rain", source: "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&current=rain", pick: "current.rain" });
      });
      const bg = na.plugin().runtime.background;
      await na.until(() => bg.spec(path)?.panels.length === 2, 3000);
      await bg.tick();
      const shown = await na.until(() => na.status().find((s) => s.startsWith("Gizmo: ")), 3000);
      app.commands.executeCommandById("gizmo:open-map");
      const state = await na.until(() => {
        const c = [...document.querySelectorAll(".workspace-leaf.mod-active .gz-map .gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === "Pausable");
        return c?.querySelector(".gz-map-state")?.textContent;
      }, 3000);
      // Paused for eleven minutes as far as what it kept says: the next tick tells it, and the one after doesn't again.
      const fired = await bg.fired.state();
      fired[path + "\\npaused:"].paused -= 11 * 60_000;
      const mark = na.notices.length;
      await bg.tick();
      await bg.tick();
      const told = (await na.noticesSince(mark, "Pausable")).filter((n) => n.startsWith("Pausable"));
      const reopened = await na.open("Apps/Pausable");
      await bg.tick();
      const cleared = await na.until(() => !na.status().some((s) => s.startsWith("Gizmo: ")), 3000);
      await na.remove(path);
      return { allowed, shown, state, told, prompt: reopened.prompt, cleared: !!cleared };`);
    expect(r.allowed && r.shown === "Gizmo: 1 paused" && r.state === "Paused (asks for more)", r);
    expect(r.told.length === 1 && r.told[0] === "Pausable is paused in the background: it now asks to fetch data from api.open-meteo.com. Open it to allow it.", r);
    expect(r.prompt?.includes("Fetch data from api.open-meteo.com") && r.cleared, r);
    return r.told[0];
  });

  await check("New link key: a link copied before asks before it runs, and its window says what it would change", async () => {
    const r = await run(`
      const id = "Apps/Errands.md#add";
      const old = na.plugin().runtime.background.shortcutLinks().find((l) => l.app === "Errands").link;
      app.commands.executeCommandById("gizmo:open-map");
      const box = await na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-map .gz-map-app"), 5000) && document.querySelector(".workspace-leaf.mod-active .gz-map");
      const errands = [...box.querySelectorAll(".gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === "Errands");
      const key = na.plugin().runtime.store.linkKeys[id];
      na.button("New link key", errands).click();
      await na.until(() => na.plugin().runtime.store.linkKeys[id] !== key, 3000);
      const url = new URL(old + "&errand=" + encodeURIComponent("Old link"));
      const mark = na.notices.length;
      app.workspace.protocolHandler.dispatch({ action: url.host, ...Object.fromEntries(url.searchParams) });
      // A modal opens in the active window, which after the trust dialog can be Obsidian's settings window.
      const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);
      const modal = await na.until(() => modals().find((m) => m.innerText.includes("A link asks to run")), 3000);
      const title = modal?.querySelector(".modal-title")?.textContent;
      const effects = modal ? [...modal.querySelectorAll(".gz-effects li")].map((li) => li.textContent) : [];
      if (modal) na.button("Cancel", modal)?.click();
      await na.sleep(300);
      return { changed: na.plugin().runtime.store.linkKeys[id] !== key, title, effects, notices: na.notices.slice(mark), errands: (na.fm("Apps/Errands data.md")?.errands ?? []).map((e) => e.errand) };`);
    expect(r.changed && r.title?.includes("A link asks to run") && !r.errands.includes("Old link"), r);
    expect(r.effects.join() === "Save errand Old link to errands in Errands data", r);
    return `${r.title}: ${r.effects.join(" | ")}`;
  });

  await check("Dry run in the map: what a shortcut would change, through its then, as you type, with nothing written", async () => {
    const r = await run(`
      app.commands.executeCommandById("gizmo:open-map");
      const box = await na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-map .gz-map-app"), 5000) && document.querySelector(".workspace-leaf.mod-active .gz-map");
      const calls = [...box.querySelectorAll(".gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === "Calls");
      const before = JSON.stringify([na.fm("Apps/Calls data.md"), na.fm("Apps/Errands data.md")]);
      na.button("Dry run", calls).click();
      const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);
      const modal = await na.until(() => modals().find((m) => m.querySelector(".gz-dry")), 3000);
      const inputs = [...modal.querySelectorAll(".gz-dry-fields input")];
      na.fill(inputs[0], "Kim");
      na.fill(inputs[1], "2099-02-01");
      const lines = await na.until(() => {
        const l = [...modal.querySelectorAll(".gz-effects li")].map((li) => li.textContent);
        return l.some((x) => x.includes("Kim")) && l;
      }, 3000);
      modal.querySelector(".modal-close-button")?.click();
      await na.sleep(300);
      return { lines, title: modal.querySelector(".modal-title")?.textContent, same: JSON.stringify([na.fm("Apps/Calls data.md"), na.fm("Apps/Errands data.md")]) === before };`);
    expect(r.same && r.lines?.some((l) => l.startsWith("Save who Kim")) && r.lines.some((l) => l === "Errands: Save errand Call Kim back by 2099-02-01 to errands in Errands data"), r);
    return `${r.title}: ${r.lines.join(" | ")}`;
  });

  await canvas(t);
}

export async function canvas(t) {
  const { check, run, expect, shot } = t;
  await check("Save as canvas writes a new canvas of the apps and opens it, never over an earlier one", async () => {
    const r = await run(`
      const before = app.vault.getFiles().filter((f) => f.extension === "canvas").map((f) => f.path);
      app.commands.executeCommandById("gizmo:save-map-canvas");
      const made = await na.until(() => app.vault.getFiles().find((f) => f.extension === "canvas" && !before.includes(f.path)), 5000);
      app.commands.executeCommandById("gizmo:save-map-canvas");
      const second = await na.until(() => app.vault.getFiles().find((f) => f.extension === "canvas" && !before.includes(f.path) && f !== made), 5000);
      await na.sleep(1500);
      const data = JSON.parse(await app.vault.read(made));
      const meds = data.nodes.find((n) => n.file === "Apps/Meds.md");
      return { made: made?.path, second: second?.path, nodes: data.nodes.length, edges: data.edges.length, meds: !!meds, open: app.workspace.getActiveViewOfType(Object.getPrototypeOf(app.workspace.activeLeaf.view).constructor)?.getViewType?.() ?? app.workspace.activeLeaf.view.getViewType() };`);
    expect(/^Gizmo map \d{4}-\d\d-\d\d\.canvas$/.test(r.made) && /^Gizmo map \d{4}-\d\d-\d\d 2\.canvas$/.test(r.second) && r.meds && r.edges > 0 && r.open === "canvas", r);
    await shot("map-canvas.png");
    return `${r.nodes} cards, ${r.edges} lines`;
  });

  await check("the Gizmo sidebar lists every app with where it stands, says as many asks as Next has, and opens an app", async () => {
    const r = await run(`
      app.commands.executeCommandById("gizmo:open-sidebar");
      const home = await na.until(() => document.querySelector(".workspace-leaf-content[data-type='gizmo-home'] .gz-home"), 4000);
      await na.until(() => home.querySelectorAll(".gz-home-app").length, 4000);
      await na.sleep(500);
      const bg = na.plugin().runtime.background;
      const heading = [...home.querySelectorAll(".gz-home-heading")].map((h) => h.textContent);
      const names = [...home.querySelectorAll(".gz-home-name")].map((n) => n.textContent);
      const counts = Object.fromEntries([...home.querySelectorAll(".gz-home-app")].filter((li) => li.querySelector(".gz-home-count")).map((li) => [li.querySelector(".gz-home-name").textContent, Number(li.querySelector(".gz-home-count").textContent)]));
      const byApp = {};
      for (const a of bg.asks.list()) byApp[a.app] = (byApp[a.app] ?? 0) + 1;
      const target = [...home.querySelectorAll(".gz-home-app")].find((li) => li.querySelector(".gz-home-name").textContent === "Chores");
      target?.querySelector("button.gz-home-open").click();
      await na.until(() => na.view()?.file?.path === "Apps/Chores.md", 4000);
      return { heading, apps: names.length, known: bg.list().length, asks: bg.asks.list().length, counts, byApp, opened: na.view()?.file?.path, type: na.view()?.getViewType() };`);
    await shot("sidebar.png");
    const needs = r.asks ? `Needs you · ${r.asks}` : "Needs you";
    expect(r.heading[0] === needs && r.heading[1] === `Apps · ${r.known}` && r.apps === r.known, r);
    expect(JSON.stringify(r.counts) === JSON.stringify(r.byApp) || Object.keys(r.byApp).every((k) => r.counts[k] === r.byApp[k]), r);
    expect(r.opened === "Apps/Chores.md" && r.type === "gizmo", r);
    return `${r.apps} apps, ${needs}; opened Chores`;
  });

  await check("an app's figure stays in the sidebar when another app is allowed, and goes when its own grant is revoked", async () => {
    const r = await run(`
      const fig = (title) => "---\\napp: " + title + "\\npanels:\\n  - {view: number, title: Jobs, source: jobs, agg: count}\\n---\\n";
      await na.write("Apps/Figure one data.md", "---\\njobs: [{a: 1}, {a: 2}]\\n---\\n");
      await na.write("Apps/Figure one.md", fig("Figure one"));
      await na.write("Apps/Figure two.md", fig("Figure two"));
      await na.sleep(800);
      await na.open("Apps/Figure one");
      await na.until(() => na.plugin().runtime.headlines.get("Apps/Figure one.md"), 4000);
      await na.open("Apps/Figure two");
      await na.sleep(1500);
      const row = () => [...document.querySelectorAll(".workspace-leaf-content[data-type='gizmo-home'] .gz-home-app")].find((li) => li.querySelector(".gz-home-name").textContent === "Figure one");
      await na.until(() => row(), 4000);
      const kept = row()?.querySelector(".gz-home-headline")?.textContent;
      await na.plugin().runtime.revoke("Apps/Figure one.md");
      await na.sleep(1000);
      return { kept, after: row()?.querySelector(".gz-home-headline")?.textContent ?? null, map: na.plugin().runtime.headlines.has("Apps/Figure one.md") };`);
    expect(r.kept === "Jobs: 2" && r.after === null && !r.map, r);
    return `${r.kept} kept after another app was allowed; gone on revoke`;
  });
}
