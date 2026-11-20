// The data policy: Gizmo policy.md does nothing until applied; applied, it blocks Appointments (it
// pins and alerts on Health dates) and lets Weather fetch from open-meteo without asking. Each
// check leaves no policy applied, so the checks after it see the vault as before.

/** Page code: the open modals, in whichever window Obsidian drew them. */
const MODALS = `const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);`;
/** Page code: opens the automation map and gives it once its apps are drawn. */
const MAP = `
  app.commands.executeCommandById("gizmo:open-map");
  const map = await na.until(() => document.querySelector(".workspace-leaf.mod-active .gz-map .gz-map-app"), 5000) && document.querySelector(".workspace-leaf.mod-active .gz-map");
  const card = (name) => [...map.querySelectorAll(".gz-map-app")].find((c) => c.querySelector(".gz-title")?.textContent === name);`;
const POLICY = "Gizmo policy.md";

export default async function policy(t) {
  const { check, run, expect, shot, press } = t;
  const closeAll = async () => {
    for (let i = 0; i < 5 && (await run(`${MODALS} return modals().length;`)); i++) await press("Escape");
  };
  const original = await run(`return await app.vault.adapter.read(${JSON.stringify(POLICY)});`);

  await check("Policy: until it's applied, Gizmo policy.md changes nothing, and the map says so", async () => {
    await closeAll();
    const r = await run(`
      await na.plugin().applyPolicy(undefined);
      ${MAP}
      await na.until(() => map.querySelector(".gz-map-policy"), 3000);
      const banner = map.querySelector(".gz-map-policy")?.textContent;
      const state = card("Appointments")?.querySelector(".gz-map-state")?.textContent;
      await na.open("Apps/Appointments");
      return { banner, state, blocked: !!na.view().contentEl.querySelector(".gz-blocked"), panels: na.view().contentEl.querySelectorAll(".gz-panel").length };`);
    expect(r.banner?.includes("isn't applied yet") && r.state !== "Blocked by your policy", r);
    expect(!r.blocked && r.panels > 0, r);
    return `${r.banner} · Appointments: ${r.state}, ${r.panels} panels`;
  });

  await check("Policy: Apply lists what stops and what no longer asks; then Appointments is blocked, naming each flow, and runs nothing", async () => {
    await closeAll();
    const r = await run(`
      ${MODALS}
      app.commands.executeCommandById("gizmo:apply-policy");
      const modal = await na.until(() => modals().find((m) => m.querySelector(".gz-policy, .modal-content.gz-policy") || m.textContent.includes("Your data policy")), 3000);
      const text = modal.innerText;
      const stops = [...modal.querySelectorAll(".gz-card .gz-title")].map((e) => e.textContent);
      const flows = [...modal.querySelectorAll(".gz-card li")].map((e) => e.textContent);
      [...modal.querySelectorAll("button")].find((b) => b.textContent === "Apply").click();
      await na.until(() => !modals().length, 3000);
      await na.sleep(500);
      const stored = na.plugin().store.policy;
      await na.open("Apps/Appointments");
      const el = na.view().contentEl;
      const blocked = [...el.querySelectorAll(".gz-blocked li")].map((li) => li.textContent);
      const status = [...document.querySelectorAll(".status-bar-item")].map((s) => s.textContent).join(" | ");
      ${MAP}
      return {
        weather: text.split("\\n").find((l) => l.startsWith("Weather")), stops, flows, stored: !!stored?.hash, blocked,
        panels: el.querySelectorAll(".gz-panel").length, status, state: card("Appointments")?.querySelector(".gz-map-state")?.textContent,
        banner: map.querySelector(".gz-map-policy")?.textContent,
      };`);
    await shot("policy-blocked");
    expect(r.stops.includes("Appointments") && r.stored, r);
    expect(r.flows.some((f) => f.includes("(private) → the status bar (personal)")), r);
    expect(r.weather?.includes("no longer asks to: Fetch data from api.open-meteo.com"), r);
    expect(r.blocked.length >= 2 && r.blocked.every((b) => b.includes("notes in Health")) && r.panels === 0, r);
    expect(!r.status.includes("Next appointment"), r);
    expect(r.state === "Blocked by your policy" && r.banner?.includes("1 app is blocked"), r);
    return `${r.blocked.join("; ")} · ${r.weather}`;
  });

  await check("Policy: an app it covers in part asks only for the rest, and says how much the policy covers", async () => {
    await closeAll();
    const r = await run(`
      await na.plugin().revoke("Apps/Weather.md");
      const { prompt } = await na.open("Apps/Weather", false);
      const covered = na.view().contentEl.querySelector(".gz-covered")?.textContent;
      na.button("Allow").click();
      await na.until(() => na.view().contentEl.querySelector(".gz-panel"), 5000);
      return { prompt, covered, granted: na.plugin().granted("Apps/Weather.md"), panels: na.view().contentEl.querySelectorAll(".gz-panel").length };`);
    expect(JSON.stringify(r.prompt) === JSON.stringify(["Add lines to Daily.md"]), r);
    expect(r.covered === "Your data policy covers 1 more." && JSON.stringify(r.granted) === JSON.stringify(["write:Daily.md"]) && r.panels > 0, r);
    return `${r.prompt.join(", ")}; ${r.covered}`;
  });

  await check("Policy: an edit to the note waits for Apply; taking the policy away lets Appointments run again", async () => {
    await closeAll();
    const r = await run(`
      await app.vault.adapter.write(${JSON.stringify(POLICY)}, ${JSON.stringify(original.replace('"Health/**": private', '"Health/**": personal'))});
      await na.sleep(1200);
      ${MAP}
      const banner = await na.until(() => map.querySelector(".gz-map-policy.is-pending")?.textContent, 3000);
      await na.open("Apps/Appointments");
      const still = !!na.view().contentEl.querySelector(".gz-blocked");
      await app.vault.adapter.write(${JSON.stringify(POLICY)}, ${JSON.stringify(original)});
      await na.sleep(800);
      await na.plugin().applyPolicy(undefined);
      await na.sleep(500);
      await na.open("Apps/Appointments");
      return { banner, still, after: na.view().contentEl.querySelectorAll(".gz-panel").length, blocked: !!na.view().contentEl.querySelector(".gz-blocked") };`);
    expect(r.banner?.includes("aren't applied yet") && r.still, r);
    expect(r.after > 0 && !r.blocked, r);
    return `${r.banner} · after: ${r.after} panels`;
  });

  await check("Policy: no app may write the policy note", async () => {
    await closeAll();
    const r = await run(`
      await na.write("Scratch/Policy writer.md", ${JSON.stringify(`---
app: Try to change the policy
panels:
  - view: button
    label: Loosen
    append: Gizmo policy
    line: "typed: secret"
---
`)});
      await na.sleep(800);
      await na.open("Scratch/Policy writer");
      const errors = [...na.view().contentEl.querySelectorAll(".gz-error li")].map((li) => li.textContent);
      return { errors, text: await app.vault.adapter.read(${JSON.stringify(POLICY)}) };`);
    expect(r.errors.some((e) => e.includes("append can't write Gizmo policy, your data policy")), r);
    expect(r.text === original, "the policy note is unchanged");
    return r.errors.join("; ");
  });
}
