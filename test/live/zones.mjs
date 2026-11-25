// Two devices in two time zones on one vault: A in Los Angeles, B in Ho Chi Minh City.
//   node test/live/zones.mjs <empty work dir>     (run `npm run build` first)
// A row saved on B carries B's offset; A places it at its moment and shows it on the day B lived it.
// Deadlines follow the device used last. A row saved as a note keeps a property Obsidian can read.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./launch.mjs";
import { tools } from "./tools.mjs";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) throw new Error("pass an empty or missing work directory");
const port = Number(process.env.CDP_PORT ?? "9370");
const results = [];
mkdirSync(join(work, "shots"), { recursive: true });

const APP = "Apps/Doses";
const DOSES = `---
app: Doses
panels:
  - view: form
    title: Log
    fields: { what: text }
    save: doses
  - view: table
    title: Doses
    source: doses
    columns: [what, at]
  - view: form
    title: Note
    fields: { what: text }
    save: Dose notes/
---
`;
// Chromium names Ho Chi Minh City's zone by its older alias.
const HCM = ["Asia/Ho_Chi_Minh", "Asia/Saigon"];
const HELPERS = `
  const panel = (title) => [...document.querySelectorAll(".workspace-leaf.mod-active .gz-panel")].find((p) => p.querySelector(".gz-panel-title, h3, .gz-title")?.textContent.includes(title));
  const cells = (what) => [...(panel("Doses")?.querySelectorAll("tbody tr") ?? [])].find((tr) => tr.querySelector("td")?.textContent === what)?.querySelectorAll("td");
  const log = (title, what) => { na.fill(panel(title).querySelector("input"), what); panel(title).querySelector("form").requestSubmit(); };
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (d = new Date()) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
`;

const a = await launch({ repo, dir: join(work, "a"), port, tz: "America/Los_Angeles", fill: (vault) => {
  cpSync(join(repo, "test/vault"), vault, { recursive: true });
  writeFileSync(join(vault, `${APP}.md`), DOSES);
} });
let b;
try {
  const ta = await tools(a.page, join(work, "shots"), "device A (Los Angeles)", results);
  await ta.run(`await na.open("${APP}"); return true;`);
  b = await launch({ repo, dir: join(work, "b"), port: port + 1, vault: a.vault, tz: "Asia/Ho_Chi_Minh" });
  const tb = await tools(b.page, join(work, "shots"), "device B (Ho Chi Minh City)", results);
  await tb.run(`await na.open("${APP}"); return true;`);

  await ta.check("each device runs in its own zone and says so in its beat", async () => {
    const zones = await Promise.all([ta, tb].map((t) => t.run(`
      const p = na.plugin().runtime;
      await p.beat.beat(true);
      return { clock: Intl.DateTimeFormat().resolvedOptions().timeZone, beat: p.beat.beats[0].zone, used: typeof p.beat.beats[0].used };`)));
    ta.expect(zones[0].clock === "America/Los_Angeles" && zones[0].beat === zones[0].clock && HCM.includes(zones[1].clock) && zones[1].beat === zones[1].clock && zones.every((z) => z.used === "number"), zones);
    return zones.map((z) => z.beat).join(", ");
  });

  await ta.check("a dose saved in Ho Chi Minh City carries +07:00; Los Angeles has its moment and shows B's clock", async () => {
    const onB = await tb.run(`${HELPERS}
      const before = clock();
      log("Log", "morning pill");
      const at = await na.until(() => na.fm("${APP} data.md")?.doses?.find((r) => r.what === "morning pill")?.at, 5000);
      return { at, before, after: clock() };`);
    const onA = await ta.run(`${HELPERS}
      const shown = await na.until(() => cells("morning pill")?.[1]?.textContent, 10000);
      const at = na.fm("${APP} data.md")?.doses?.find((r) => r.what === "morning pill")?.at;
      return { shown, at, offMs: Math.abs(Date.parse(at) - Date.now()), here: clock() };`);
    const bClock = String(onB.at).slice(0, 16);
    ta.expect(/\+07:00$/.test(onB.at) && (bClock === onB.before || bClock === onB.after) && onA.at === onB.at && onA.shown === bClock && onA.offMs < 3 * 60_000 && onA.here !== bClock, { onB, onA });
    return `saved ${onB.at}; A shows ${onA.shown} at ${onA.here} its own time`;
  });

  await ta.check("deadlines follow the device used last: B touched, then A", async () => {
    const touch = (t) => t.run(`document.dispatchEvent(new PointerEvent("pointerdown")); await na.plugin().runtime.beat.beat(true); return true;`);
    const where = () => ta.run(`await na.plugin().runtime.beat.beat(true); return na.plugin().runtime.beat.whereYouAre();`);
    await touch(tb);
    await new Promise((r) => setTimeout(r, 1500));
    const afterB = await where();
    await touch(ta);
    const afterA = await where();
    ta.expect(HCM.includes(afterB) && afterA === "America/Los_Angeles", { afterB, afterA });
    return `${afterB}, then ${afterA}`;
  });

  await tb.check("a dose saved as a note: its at property, as Obsidian shows it", async () => {
    const r = await tb.run(`${HELPERS}
      log("Note", "evening pill");
      const file = await na.until(() => app.vault.getFiles().find((f) => f.path.startsWith("Dose notes/")), 5000);
      if (!file) return { file: null };
      const raw = await app.vault.read(file);
      await app.workspace.getLeaf("tab").openFile(file);
      await na.sleep(1500);
      const prop = document.querySelector(".workspace-leaf.mod-active .metadata-property[data-property-key='at']");
      const input = prop?.querySelector("input");
      return {
        path: file.path, raw: raw.split("\\n").find((l) => l.startsWith("at:")),
        type: (() => { try { const m = app.metadataTypeManager; return { assigned: m.getAssignedWidget?.("at") ?? null, stored: m.types?.at ?? m.properties?.at ?? null }; } catch (e) { return String(e); } })(),
        widget: prop?.querySelector(".metadata-property-value")?.firstElementChild?.className ?? null,
        input: input ? { type: input.type, value: input.value } : null,
        text: prop?.querySelector(".metadata-property-value")?.textContent ?? null,
      };`);
    await tb.shot("zones-note-property");
    tb.expect(r.file !== null && r.raw, r);
    return JSON.stringify(r);
  });
  await tb.check("a property set to Date & time shows a stamp with an offset as its clock, and keeps it", async () => {
    const r = await tb.run(`
      const m = app.metadataTypeManager;
      await m.setType("when_local", "datetime");
      await m.setType("when_offset", "datetime");
      const file = await app.vault.create("Stamps.md", "---\\nwhen_local: 2026-11-21T01:02\\nwhen_offset: 2026-11-21T01:02+07:00\\n---\\n");
      await app.workspace.getLeaf("tab").openFile(file);
      await na.sleep(1500);
      const input = (key) => document.querySelector(".workspace-leaf.mod-active .metadata-property[data-property-key='" + key + "'] .metadata-property-value input");
      const shown = (key) => { const i = input(key); return i ? { type: i.type, value: i.value, invalid: i.closest(".metadata-property")?.classList.contains("is-invalid") ?? false } : null; };
      const raw = await app.vault.read(file);
      return { local: shown("when_local"), offset: shown("when_offset"), raw };`);
    await tb.shot("zones-datetime-property");
    tb.expect(r.local?.type === "datetime-local", r);
    return JSON.stringify(r);
  });
} catch (e) {
  results.push({ name: "zones: the run itself", status: "FAIL", detail: e.message.split("\n")[0] });
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
