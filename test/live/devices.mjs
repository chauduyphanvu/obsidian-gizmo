// Two devices on one vault: two isolated Obsidian instances, each with its own user data (so its
// own device in local storage), opening the same vault folder, as a sync tool would keep it.
//   node test/live/devices.mjs <empty work dir>     (run `npm run build` first)
// Household chores (devices: split) is used on both at once; both run background work at first.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./launch.mjs";
import { tools } from "./tools.mjs";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) throw new Error("pass an empty or missing work directory");
const port = Number(process.env.CDP_PORT ?? "9360");
const results = [];
mkdirSync(join(work, "shots"), { recursive: true });

const a = await launch({ repo, dir: join(work, "a"), port, fill: (vault) => {
  cpSync(join(repo, "test/vault"), vault, { recursive: true });
  cpSync(join(repo, "gallery/Apps/Household chores.md"), join(vault, "Apps/Household chores.md"));
} });
let b;
try {
  const ta = await tools(a.page, join(work, "shots"), "device A", results);
  await ta.run(`await na.open("Apps/Household chores"); return true;`);
  b = await launch({ repo, dir: join(work, "b"), port: port + 1, vault: a.vault });
  const tb = await tools(b.page, join(work, "shots"), "device B", results);

  await ta.check("two devices get different ids and each starts running background work", async () => {
    const ids = await Promise.all([ta, tb].map((t) => t.run(`return na.plugin().device;`)));
    ta.expect(ids[0].id !== ids[1].id && ids.every((d) => d.background && d.name === "Mac"), ids);
    return ids.map((d) => `${d.name}-${d.id}`).join(", ");
  });

  await ta.check("both devices log a chore at the same moment; both rows are kept, each in its own device's note", async () => {
    const save = (who) => `
      await na.open("Apps/Household chores");
      const form = [...document.querySelectorAll(".workspace-leaf.mod-active .gz-panel")].find((p) => p.textContent.includes("Did a chore"));
      if (!form) return { state: na.state(), text: na.text().slice(0, 300) };
      na.fill(form.querySelector("input"), "${who}");
      na.button("Done", form).click();
      await na.sleep(500);
      return { state: na.state(), notices: na.notices.slice(-3) };`;
    const saved = await Promise.all([ta.run(save("Ann")), tb.run(save("Bo"))]);
    const folder = join(a.vault, "Apps/Household chores data");
    const notes = await (async () => {
      for (let i = 0; i < 50; i++) {
        const files = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".md")) : [];
        if (files.length === 2) return files;
        await new Promise((r) => setTimeout(r, 200));
      }
      return existsSync(folder) ? readdirSync(folder) : [];
    })();
    const texts = notes.map((f) => readFileSync(join(folder, f), "utf8"));
    ta.expect(notes.length === 2 && texts.some((t) => t.includes("who: Ann")) && texts.some((t) => t.includes("who: Bo")), { notes, texts, saved });
    const counts = await Promise.all([ta, tb].map((t) => t.run(`
      const panel = () => [...document.querySelectorAll(".workspace-leaf.mod-active .gz-panel")].find((p) => p.textContent.includes("This week"));
      return na.until(() => panel()?.querySelector(".gz-big")?.textContent === "2" && "2", 8000);`)));
    ta.expect(counts.every((c) => c === "2"), { counts });
    await tb.shot("devices-b.png");
    return notes.join(", ");
  });

  await ta.check("a device that runs background work warns when another one does too; turned off, it says so", async () => {
    // B started after A had said it runs background work, so B's first beat sees A.
    const warned = await tb.run(`return na.until(() => na.notices.find((n) => n.startsWith("Background work also runs on Mac (")), 5000);`);
    const off = await tb.run(`
      const p = na.plugin();
      p.device.background = false;
      p.deviceStore.save("gizmo-device", p.device);
      await p.beat.beat(true);
      const seen = JSON.parse(await app.vault.adapter.read(".obsidian/plugins/gizmo/devices/" + p.device.id + ".json"));
      return seen;`);
    ta.expect(!!warned && off.background === false, { warned, off });
    return warned;
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
