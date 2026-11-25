// A recorded app with a long history, synced in from another device: 10,080 samples over 105 days in
// its monthly logs. Its data note keeps the newest 500, a checkpoint keeps the rest, and opening it
// again after a restart reads only the log with the last week in it.

export default async function history(t) {
  const { check, run, expect, shot } = t;

  await check("history: a recorded app with 105 days of samples shows them all; its data note keeps the newest 500 and a checkpoint is written", async () => {
    const r = await run(`
      const DATA = "Apps/Kp history data.md";
      const folder = "Apps/Kp history data/log";
      await app.vault.create("Apps/Kp history.md", [
        "---", "app: Kp history",
        "data:", "  kp:", "    source: https://example.invalid/kp.json", "    record: 15m",
        "panels:", "  - view: number", "    title: Samples", "    source: kp_log", "    agg: count",
        "---", ""].join("\\n"));
      // Opened and allowed first, so its recorded list is known before its history arrives.
      await na.until(() => na.fm("Apps/Kp history.md")?.app, 3000);
      await na.open("Apps/Kp history");
      await na.sleep(1000);
      // Another device's logs, a sample every 15 minutes up to an hour ago, one file a month.
      const step = 15 * 60_000, n = 10_080, end = Date.now() - 3_600_000;
      const months = new Map();
      for (let i = 0; i < n; i++) {
        const t = end - (n - 1 - i) * step;
        const iso = new Date(t).toISOString();
        const line = JSON.stringify({ t: iso + "/0", d: "zzhist01", op: "add", l: "kp_log", row: "h" + i.toString(16).padStart(6, "0"), v: { at: iso.slice(0, 16), kp: i % 9 } }) + "\\n";
        const month = iso.slice(0, 7);
        months.set(month, (months.get(month) ?? "") + line);
      }
      if (!app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
      for (const [month, text] of months) await app.vault.create(folder + "/zzhist01-" + month + ".jsonl", text);
      const shown = await na.until(() => /10,?080/.test(na.text()) && na.text(), 20000);
      // The device that runs background work writes the note's snapshot, and its checkpoint, a few seconds on.
      const fm = await na.until(() => na.fm(DATA)?.kp_log?.length === 500 && na.fm(DATA), 30000);
      const checkpoint = app.vault.getFiles().find((f) => f.path.startsWith(folder + "/checkpoint-"));
      return {
        files: months.size, shown: !!shown, rows: fm?.kp_log?.length, ids: fm?.["gizmo-ids"]?.kp_log?.length, newest: fm?.kp_log?.at(-1)?.kp,
        gone: fm?.["gizmo-gone"], checkpoint: checkpoint && { path: checkpoint.path, kb: Math.round(checkpoint.stat.size / 1024) },
        runner: na.plugin().runtime.beat?.isRunner(),
      };`);
    expect(r.files >= 4 && r.shown && r.rows === 500 && r.ids === 500 && r.newest === 10_079 % 9 && r.gone === undefined && r.checkpoint, r);
    await shot("history.png");
    return `${r.files} monthly logs; the note keeps 500 rows; ${r.checkpoint.path.split("/").pop()} (${r.checkpoint.kb} KB)`;
  });

  await check("history: after a restart, opening it again reads only the log with the last week in it", async () => {
    const r = await run(`
      await app.plugins.disablePlugin("gizmo");
      // Every file Gizmo reads from now on, by path.
      const read = [];
      const cached = app.vault.cachedRead.bind(app.vault);
      app.vault.cachedRead = (f) => { read.push(f.path); return cached(f); };
      try {
        await app.plugins.enablePlugin("gizmo");
        await na.sleep(1500);
        await na.open("Apps/Kp history");
        const shown = await na.until(() => /10,?080/.test(na.text()) && na.text(), 20000);
        const logs = read.filter((p) => p.startsWith("Apps/Kp history data/log/"));
        return { shown: !!shown, logs };
      } finally {
        app.vault.cachedRead = cached;
      }`);
    const jsonl = r.logs.filter((p) => p.endsWith(".jsonl"));
    expect(r.shown && jsonl.length === 1 && r.logs.some((p) => p.includes("/checkpoint-")), r);
    return `read ${r.logs.map((p) => p.split("/").pop()).join(", ")}`;
  });
}
