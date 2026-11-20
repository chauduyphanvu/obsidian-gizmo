// Shortcut links, then: between apps, and the activity log with undo, on Calls and Errands.

export default async function triggers(t) {
  const { check, run, expect } = t;

  await check("a copied shortcut link adds an errand, and is listed with the fields it fills", async () => {
    const r = await run(`
      await na.open("Apps/Errands");
      const links = na.plugin().background.shortcutLinks().filter((l) => l.app === "Errands" || l.app === "Calls");
      const add = links.find((l) => l.app === "Errands");
      const count = () => na.fm("Apps/Errands data.md")?.errands?.length ?? 0;
      const before = count();
      const url = new URL(add.link + "&errand=" + encodeURIComponent("Post the parcel"));
      const mark = na.notices.length;
      app.workspace.protocolHandler.dispatch({ action: url.host, ...Object.fromEntries(url.searchParams) });
      const notices = await na.noticesSince(mark, "Errands");
      await na.until(() => count() === before + 1, 3000);
      return { links: links.map((l) => [l.app, l.link, l.fields]), notices, errands: na.fm("Apps/Errands data.md")?.errands };`);
    // Each link carries its shortcut's key, which only a link copied in Obsidian has.
    const keyless = r.links.map(([app, link, fields]) => [app, link.replace(/&key=[\w-]{22}$/, ""), fields]);
    expect(JSON.stringify(keyless) === JSON.stringify([["Calls", "obsidian://gizmo?app=Calls&do=log", ["who", "back"]], ["Errands", "obsidian://gizmo?app=Errands&do=add", ["errand"]]]), r);
    expect(r.errands?.at(-1)?.errand === "Post the parcel" && r.notices.includes("Errands: Add done"), r);
    return `${r.links.length} links; ${r.errands.length} errands`;
  });

  await check("a call logged by link adds a call-back errand through then, and the activity log keeps both runs", async () => {
    const r = await run(`
      await na.open("Apps/Calls");
      const errands = () => na.fm("Apps/Errands data.md")?.errands ?? [];
      const before = errands().length;
      const mark = na.notices.length;
      // The link as "Copy link to an app shortcut" gives it, key and all, with the form's values on the end.
      const url = new URL(na.plugin().background.shortcutLinks().find((l) => l.app === "Calls" && l.shortcut === "log").link);
      app.workspace.protocolHandler.dispatch({ action: url.host, ...Object.fromEntries(url.searchParams), who: "Sam", back: "2099-01-31" });
      const notices = await na.noticesSince(mark, "for Calls");
      await na.until(() => errands().length === before + 1, 3000);
      const log = await na.plugin().activity.list();
      return { notices, last: errands().at(-1), log: log.slice(0, 2).map((e) => [e.app, e.actor, e.what, e.changes.map((c) => c.kind)]) };`);
    expect(r.last?.errand === "Call Sam back by 2099-01-31", r);
    expect(JSON.stringify(r.notices.slice(-2)) === JSON.stringify(["Calls: Log done", "Errands: Add done for Calls"]), r);
    expect(JSON.stringify(r.log) === JSON.stringify([["Apps/Errands.md", "trigger:Calls", "Add an errand", ["row-added"]], ["Apps/Calls.md", "link", "Log a call", ["row-added"]]]), r);
    return `${r.last.errand}; logged as ${r.log.map((e) => e[1]).join(", ")}`;
  });

  await check("Activity shows what Errands did in words; Undo takes the call-back errand out and the entry reads undone", async () => {
    const r = await run(`
      await na.open("Apps/Errands");
      const errands = () => (na.fm("Apps/Errands data.md")?.errands ?? []).map((e) => e.errand);
      const before = errands();
      app.commands.executeCommandById("gizmo:show-activity");
      const modal = await na.until(() => activeDocument.querySelector(".modal .gz-activity .gz-activity-entry")?.closest(".modal"), 5000);
      if (!modal) return { missing: [...activeDocument.querySelectorAll(".modal")].map((m) => m.innerText.slice(0, 200)), active: app.workspace.getActiveFile()?.path };
      const title = modal.querySelector(".modal-title").textContent;
      const first = modal.querySelector(".gz-activity-entry");
      const text = first.innerText.replace(/\\n+/g, " | ");
      const mark = na.notices.length;
      first.querySelector("button.gz-activity-undo").click();
      const notices = await na.noticesSince(mark, "Undone");
      await na.until(() => errands().length === before.length - 1, 3000);
      const after = await na.until(() => activeDocument.querySelector(".modal .gz-activity-entry .gz-activity-undone") && activeDocument.querySelector(".modal .gz-activity-entry").innerText.replace(/\\n+/g, " | "), 3000);
      modal.querySelector(".modal-close-button, .modal-header-button").click();
      return { title, text, notices, before, now: errands(), after };`);
    expect(r.title === "What Errands did" && r.text.includes("Triggered by Calls: Add an errand") && r.text.includes("Saved errand Call Sam back by 2099-01-31 to errands in Errands data"), r);
    expect(r.notices.includes("Undone") && r.now.length === r.before.length - 1 && !r.now.includes("Call Sam back by 2099-01-31") && r.after?.includes("Undone"), r);
    return `"${r.text.slice(0, 80)}…" → Undone`;
  });

  await check("an undo after a hand edit is refused and leaves the note alone", async () => {
    const r = await run(`
      await na.open("Apps/Errands");
      const form = na.view().contentEl.querySelector("form");
      na.fill(form.querySelector("input"), "Buy milk");
      form.querySelector("button[type=submit], button").click();
      await na.until(() => (na.fm("Apps/Errands data.md")?.errands ?? []).some((e) => e.errand === "Buy milk"), 3000);
      await app.fileManager.processFrontMatter(na.file("Apps/Errands data.md"), (fm) => {
        fm.errands = fm.errands.map((e) => (e.errand === "Buy milk" ? { ...e, errand: "Buy oat milk" } : e));
      });
      await na.sleep(300);
      const [latest] = await na.plugin().activity.list("Apps/Errands.md");
      const result = await na.plugin().undo(latest);
      return { actor: latest.actor, result, errands: na.fm("Apps/Errands data.md").errands.map((e) => e.errand) };`);
    expect(r.actor === "you" && r.result.undone === 0 && /has changed or is gone/.test(r.result.refusal) && r.errands.includes("Buy oat milk"), r);
    return r.result.refusal;
  });

  await check("Calls' overdue alert runs then once for a call-back whose day has passed, not again", async () => {
    const r = await run(`
      const errands = () => (na.fm("Apps/Errands data.md")?.errands ?? []).map((e) => e.errand);
      const overdue = () => errands().filter((e) => e === "Overdue: call Pat").length;
      await app.fileManager.processFrontMatter(na.file("Apps/Calls data.md"), (fm) => {
        fm.calls = [...(fm.calls ?? []), { who: "Pat", back: "2020-01-01", at: "2020-01-01T09:00" }];
      });
      const once = await na.until(() => overdue() === 1, 8000);
      await app.fileManager.processFrontMatter(na.file("Apps/Calls data.md"), (fm) => { fm.calls = [...fm.calls]; fm.touched = true; });
      await na.sleep(1500);
      return { once: !!once, count: overdue() };`);
    expect(r.once && r.count === 1, r);
    return "one Overdue: call Pat";
  });
}
