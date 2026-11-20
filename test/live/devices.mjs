// Two devices on one vault: two isolated Obsidian instances, each with its own user data (so its
// own device in local storage), opening the same vault folder, as a sync tool would keep it.
//   node test/live/devices.mjs <empty work dir>     (run `npm run build` first)
// Shared, an app made here, is used on both at once: each device appends to its own log beside
// the data note, and only the device that runs background work writes the note itself.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./launch.mjs";
import { tools } from "./tools.mjs";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) throw new Error("pass an empty or missing work directory");
const port = Number(process.env.CDP_PORT ?? "9360");
const results = [];
mkdirSync(join(work, "shots"), { recursive: true });

const SHARED = `---
app: Shared
panels:
  - view: form
    title: Add
    fields: { task: text }
    save: chores
  - view: table
    title: Chores
    source: chores
    columns: [task, who]
    edit: [who]
  - view: checklist
    title: Shop
    items: [milk, eggs, bread]
    save: shop
---
`;

const APP = "Apps/Shared";
const DATA = "Apps/Shared data.md";
// In each device's page: the open app's panels, a chore's row, its who cell.
const HELPERS = `
  const panel = (title) => [...document.querySelectorAll(".workspace-leaf.mod-active .gz-panel")].find((p) => p.querySelector(".gz-panel-title, h3, .gz-title")?.textContent.includes(title) || p.textContent.startsWith(title));
  const row = (task) => [...(panel("Chores")?.querySelectorAll("tbody tr") ?? [])].find((tr) => tr.querySelector("td")?.textContent === task);
  const who = (task) => row(task)?.querySelectorAll("td")[1];
  const tasks = () => [...(panel("Chores")?.querySelectorAll("tbody tr td:first-child") ?? [])].map((td) => td.textContent);
  const ticked = () => [...(panel("Shop")?.querySelectorAll(".gz-checklist input") ?? [])].map((i) => i.checked);
  const save = () => panel("Add").querySelector("form").requestSubmit();
`;

const a = await launch({ repo, dir: join(work, "a"), port, fill: (vault) => {
  cpSync(join(repo, "test/vault"), vault, { recursive: true });
  writeFileSync(join(vault, `${APP}.md`), SHARED);
} });
let b;
try {
  const ta = await tools(a.page, join(work, "shots"), "device A", results);
  await ta.run(`await na.open("${APP}"); return true;`);
  b = await launch({ repo, dir: join(work, "b"), port: port + 1, vault: a.vault });
  const tb = await tools(b.page, join(work, "shots"), "device B", results);
  await tb.run(`await na.open("${APP}"); return true;`);
  const both = (code) => Promise.all([ta.run(code), tb.run(code)]);

  await ta.check("two devices get different ids, and exactly one runs background work: the lowest id", async () => {
    const seen = await both(`
      const p = na.plugin();
      await p.beat.beat(true);
      await na.sleep(1500);
      await p.beat.beat();
      return { id: p.device.id, runner: p.beat.isRunner(), beats: p.beat.beats.length };`);
    const runners = seen.filter((s) => s.runner);
    ta.expect(seen[0].id !== seen[1].id && runners.length === 1 && runners[0].id === [seen[0].id, seen[1].id].sort()[0] && seen.every((s) => s.beats === 2), seen);
    return seen.map((s) => `${s.id}${s.runner ? " (runs it)" : ""}`).join(", ");
  });

  await ta.check("a chore saved on one device shows on the other", async () => {
    await ta.run(`${HELPERS}
      na.fill(panel("Add").querySelector("input"), "bins");
      save();
      return na.until(() => tasks().includes("bins"), 5000);`);
    const shown = await tb.run(`${HELPERS} return na.until(() => tasks().includes("bins") && tasks(), 10000);`);
    ta.expect(Array.isArray(shown) && shown.includes("bins"), { shown });
    return shown.join(", ");
  });

  await ta.check("both tick one checklist and set one cell in the same second: both ticks are kept, and the cell offers the other value", async () => {
    await Promise.all([
      ta.run(`${HELPERS} panel("Shop").querySelectorAll(".gz-checklist input")[0].click(); na.fill(who("bins").querySelector("input"), "Ann"); return true;`),
      tb.run(`${HELPERS} panel("Shop").querySelectorAll(".gz-checklist input")[1].click(); na.fill(who("bins").querySelector("input"), "Bo"); return true;`),
    ]);
    const seen = await both(`${HELPERS}
      const settled = await na.until(() => ticked()[0] && ticked()[1] && who("bins")?.querySelector(".gz-conflict"), 12000);
      return { ticked: ticked(), shown: who("bins")?.querySelector("input")?.value, chip: who("bins")?.querySelector(".gz-conflict")?.textContent, settled: !!settled };`);
    const [x, y] = seen;
    const winner = x.shown;
    const other = winner === "Ann" ? "Bo" : "Ann";
    ta.expect(seen.every((s) => s.ticked[0] && s.ticked[1] && !s.ticked[2] && s.shown === winner && s.chip === `or ${other}`) && ["Ann", "Bo"].includes(winner), seen);
    await ta.shot("devices-conflict-a.png");
    await tb.shot("devices-conflict-b.png");
    // Picking the other value on one device settles it on both.
    await tb.run(`${HELPERS} who("bins").querySelector(".gz-conflict").click(); return true;`);
    const after = await both(`${HELPERS}
      await na.until(() => who("bins")?.querySelector("input")?.value === "${other}" && !who("bins")?.querySelector(".gz-conflict"), 10000);
      return { shown: who("bins")?.querySelector("input")?.value, chip: !!who("bins")?.querySelector(".gz-conflict") };`);
    ta.expect(after.every((s) => s.shown === other && !s.chip), { seen: [x, y], after });
    return `${winner} shown, ${other} offered; picked ${other} on B`;
  });

  await ta.check("a save undone on its device after the other device edited the row: the row goes on both", async () => {
    await ta.run(`${HELPERS}
      na.fill(panel("Add").querySelector("input"), "dishes");
      save();
      return na.until(() => tasks().includes("dishes"), 5000);`);
    await tb.run(`${HELPERS}
      await na.until(() => who("dishes")?.querySelector("input"), 10000);
      na.fill(who("dishes").querySelector("input"), "Cy");
      return true;`);
    await ta.run(`${HELPERS} return na.until(() => who("dishes")?.querySelector("input")?.value === "Cy", 10000);`);
    const undone = await ta.run(`
      const p = na.plugin();
      const entry = (await p.activity.list("${APP}.md")).find((e) => e.changes.some((c) => c.kind === "row-added" && c.row.task === "dishes"));
      return entry ? await p.undo(entry) : { none: (await p.activity.list("${APP}.md")).map((e) => e.what) };`);
    const left = await both(`${HELPERS} await na.until(() => !tasks().includes("dishes"), 10000); return tasks();`);
    ta.expect(undone?.undone === 1 && left.every((t) => !t.includes("dishes") && t.includes("bins")), { undone, left });
    return `left: ${left[0].join(", ")}`;
  });

  await ta.check("only the device that runs background work writes the data note: its lists, and where the logs were", async () => {
    const fm = await ta.run(`return na.until(() => { const fm = na.fm("${DATA}"); return fm?.["gizmo-snapshot"] && fm.chores?.length === 1 && fm; }, 12000);`);
    const logs = existsSync(join(a.vault, "Apps/Shared data/log")) ? readdirSync(join(a.vault, "Apps/Shared data/log")) : [];
    ta.expect(fm && fm.chores[0].task === "bins" && Array.isArray(fm.shop) && fm.shop.length === 2 && logs.filter((f) => f.endsWith(".jsonl")).length === 2, { fm, logs });
    return `${Object.keys(fm["gizmo-snapshot"].files).length} logs, ${fm.chores.length} chore, ${fm.shop.join(" + ")}`;
  });

  await ta.check("the data note edited by hand: both devices say so; Discard writes it back as the logs have it", async () => {
    await ta.run(`
      const f = app.vault.getFileByPath("${DATA}");
      await app.fileManager.processFrontMatter(f, (fm) => { fm.chores = [{ task: "bins", who: "Bo" }, { task: "laundry" }]; });
      return true;`);
    const cards = await both(`return na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-hand-edit")?.innerText, 10000);`);
    await ta.shot("devices-hand-edit.png");
    await tb.run(`na.button("Discard it", document.querySelector(".workspace-leaf.mod-active .gz-hand-edit")).click(); return true;`);
    const gone = await both(`return na.until(() => !document.querySelector(".workspace-leaf.mod-active .gz-hand-edit") && "gone", 10000);`);
    const fm = await ta.run(`return na.until(() => { const fm = na.fm("${DATA}"); return fm?.chores?.length === 1 && fm; }, 10000);`);
    ta.expect(cards.every((c) => typeof c === "string" && c.includes("was edited by hand")) && gone.every((g) => g === "gone") && fm?.chores?.[0]?.task === "bins", { cards, gone, fm });
    return cards[0].split("\n")[0];
  });

  await ta.check("a lens folded on one device, not yet saved, while the other allows an app: data.json keeps both", async () => {
    // Each device writes its own copy of data.json under a sync tool; here they share one file, so
    // the two writes are kept apart in time and B's change waits unsaved while A's lands.
    await tb.run(`(na.plugin().store.folded ??= {})["Components/Some lens.md"] = true; return true;`);
    await ta.run(`await na.plugin().grant("Apps/Elsewhere.md", ["net:a.example"]); return true;`);
    await new Promise((r) => setTimeout(r, 1500));
    await tb.run(`await na.plugin().saveSettings(); return true;`);
    // Both devices here write the one data.json a sync tool would keep a copy of per device: a read may catch a write.
    const settings = () => { try { return JSON.parse(readFileSync(join(a.vault, ".obsidian/plugins/gizmo/data.json"), "utf8")); } catch { return {}; } };
    let disk;
    for (let i = 0; i < 30; i++) {
      disk = settings();
      if (disk.grants?.["Apps/Elsewhere.md"] && disk.folded?.["Components/Some lens.md"]) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const stores = await both(`return na.until(() => { const s = na.plugin().store; return s.grants["Apps/Elsewhere.md"] && s.folded?.["Components/Some lens.md"] && "both"; }, 8000);`);
    ta.expect(disk.grants["Apps/Elsewhere.md"]?.[0] === "net:a.example" && disk.folded["Components/Some lens.md"] === true && stores.every((x) => x === "both"), { disk, stores });
    return "grant from A and fold from B on disk and on both devices";
  });

  await ta.check("an app renamed on one device: the other drops nothing, and grants, link keys and capture keys follow the new name", async () => {
    await ta.run(`
      const p = na.plugin();
      p.linkKey("${APP}.md", "add", true);
      await p.newCaptureKey([{ name: "chore", path: "${APP}.md", shortcut: "add" }]);
      await na.sleep(1500);
      await app.fileManager.renameFile(na.file("${APP}.md"), "Apps/Household.md");
      return true;`);
    // Both devices here write the one data.json a sync tool would keep a copy of per device: a read may catch a write.
    const settings = () => { try { return JSON.parse(readFileSync(join(a.vault, ".obsidian/plugins/gizmo/data.json"), "utf8")); } catch { return {}; } };
    const moved = (s) => !!s.grants?.["Apps/Household.md"] && !s.grants["${APP}.md"] && !!s.linkKeys?.["Apps/Household.md#add"]
      && Object.values(s.captureKeys ?? {}).some((names) => names.chore === "Apps/Household.md#add");
    let disk;
    for (let i = 0; i < 40; i++) {
      disk = settings();
      if (moved(disk)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // B has seen the note go from under its old name; give it time to have dropped anything it was going to.
    await new Promise((r) => setTimeout(r, 3000));
    disk = settings();
    const onB = await tb.run(`const s = na.plugin().store; return { grant: s.grants["Apps/Household.md"], old: s.grants["${APP}.md"], key: s.linkKeys?.["Apps/Household.md#add"] };`);
    ta.expect(moved(disk) && Array.isArray(onB.grant) && onB.old === undefined && onB.key, { disk, onB });
    return "kept under Apps/Household.md on disk and on B";
  });
} catch (e) {
  results.push({ name: "devices: the run itself", status: "FAIL", detail: e.message.split("\n")[0] });
} finally {
  a.page.close();
  a.quit();
  if (b) {
    b.page.close();
    b.quit();
  }
}
for (const r of results) console.log(`${r.status}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
