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
      await na.until(() => !na.plugin().store.grants["Apps/Meds.md"], 3000);
      const pinGone = await na.until(() => !pinned(), 3000);
      const count = () => na.fm("Apps/Meds data.md")?.doses?.length ?? 0;
      const doses = count();
      const mark = na.notices.length;
      app.commands.executeCommandById("gizmo:Apps/Meds.md:took-meds");
      const notices = await na.noticesSince(mark, "Open Meds");
      await na.sleep(500);
      const state = await na.until(() => {
        const c = [...document.querySelectorAll(".workspace-leaf.mod-active .gz-map .gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === "Meds");
        return c?.querySelector(".gz-map-state")?.textContent === "Never opened" && "Never opened";
      }, 3000);
      const reopened = await na.open("Apps/Meds");
      const back = await na.until(() => pinned(), 5000);
      return { before, pinGone: !!pinGone, wrote: count() !== doses, notices, state, prompt: reopened.prompt, back: !!back };`);
    expect(r.before && r.pinGone && !r.wrote && r.notices.includes("Open Meds once to allow it"), r);
    expect(r.state === "Never opened" && r.prompt?.length && r.back, r);
    return r.notices.join(" | ");
  });

  await check("New link key: a link copied before asks before it runs, and its window says what it would change", async () => {
    const r = await run(`
      const id = "Apps/Errands.md#add";
      const old = na.plugin().background.shortcutLinks().find((l) => l.app === "Errands").link;
      app.commands.executeCommandById("gizmo:open-map");
      const box = await na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-map .gz-map-app"), 5000) && document.querySelector(".workspace-leaf.mod-active .gz-map");
      const errands = [...box.querySelectorAll(".gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === "Errands");
      const key = na.plugin().store.linkKeys[id];
      na.button("New link key", errands).click();
      await na.until(() => na.plugin().store.linkKeys[id] !== key, 3000);
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
      return { changed: na.plugin().store.linkKeys[id] !== key, title, effects, notices: na.notices.slice(mark), errands: (na.fm("Apps/Errands data.md")?.errands ?? []).map((e) => e.errand) };`);
    expect(r.changed && r.title?.includes("A link asks to run") && !r.errands.includes("Old link"), r);
    expect(r.effects.join() === "Saved errand Old link to errands in Errands data", r);
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
    expect(r.same && r.lines?.some((l) => l.startsWith("Saved who Kim")) && r.lines.some((l) => l === "Errands: Saved errand Call Kim back by 2099-02-01 to errands in Errands data"), r);
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
}
