// Try before Allow: the real app on copies of its own notes, from the permission prompt and from the install window.

const TEA = `---
app: Log each cup of tea and tell the shopping list when I'm out
panels:
  - view: button
    label: Had a cup
    save: cups
    append: Daily.md
    line: "- Tea {time}"
    notify: Enjoy
  - view: number
    title: Cups today
    source: cups
    where: {at: today}
    agg: count
  - view: number
    title: Outside
    source: https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current=temperature_2m
    field: current.temperature_2m
---
`;

export default async function tryFirst(t) {
  const { check, run, expect, shot } = t;
  const modals = `const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);`;

  await check("Try it first: the app works on copies before Allow; nothing reaches the vault or the web, and Allow there allows it", async () => {
    const r = await run(`
      ${modals}
      await na.write("Apps/Tea.md", ${JSON.stringify(TEA)});
      await na.sleep(800);
      window.__daily = await na.read("Daily.md");
      const { prompt } = await na.open("Apps/Tea", false);
      na.button("Try it first").click();
      const modal = await na.until(() => modals().find((m) => m.querySelector(".gz-try")), 3000);
      await na.sleep(800);
      const before = modal.querySelector(".gz-try-app").innerText;
      na.button("Had a cup", modal).click();
      const cups = () => [...modal.querySelectorAll(".gz-panel")].find((p) => p.textContent.includes("Cups today"))?.querySelector(".gz-big")?.textContent;
      const counted = await na.until(() => cups() === "1", 3000);
      return {
        prompt, before: before.includes("Cups today"), counted: !!counted,
        did: [...modal.querySelectorAll(".gz-effects li")].map((li) => li.textContent),
        outside: [...modal.querySelectorAll(".gz-panel")].find((p) => p.innerText.includes("Outside"))?.innerText,
        fetchButton: [...modal.querySelectorAll("button")].find((b) => b.textContent.startsWith("Fetch from"))?.textContent,
      };`);
    await shot("try.png");
    const after = await run(`
      ${modals}
      const modal = modals().find((m) => m.querySelector(".gz-try"));
      na.button("Allow", modal).click();
      await na.until(() => na.plugin().runtime.store.grants["Apps/Tea.md"], 3000);
      await na.settle();
      return { data: na.exists("Apps/Tea data.md"), dailySame: (await na.read("Daily.md")) === window.__daily, grant: na.plugin().runtime.store.grants["Apps/Tea.md"], open: !!na.button("Had a cup") };`);
    expect(r.prompt?.length === 2 && r.before && r.counted, r);
    expect(r.did[0] === "Enjoy" && r.did[1]?.startsWith("Added to Daily the line “- Tea") && r.did[2] === "Saved a row to cups in Tea data", r);
    expect(r.outside?.includes("Not fetched in a try: api.open-meteo.com") && r.fetchButton === "Fetch from api.open-meteo.com for this try", r);
    expect(!after.data && after.dailySame && after.grant?.join() === "net:api.open-meteo.com,write:Daily.md" && after.open, after);
    return r.did.join(" | ");
  });

  await check("Try it in the install window: a shared app runs on its own notes, and nothing is created until Install", async () => {
    const r = await run(`
      ${modals}
      const text = "# Kettle\\n\\n" + "\`\`\`\`gizmo-note Kettle\\n" + ${JSON.stringify(TEA.replace("Log each cup of tea", "Log each kettle boil"))} + "\`\`\`\`\\n";
      const files = app.vault.getFiles().length;
      app.commands.executeCommandById("gizmo:install-app");
      const install = await na.until(() => modals().find((m) => m.innerText.includes("Install an app")), 3000);
      na.fill(install.querySelector("textarea"), text);
      na.button("Preview", install).click();
      await na.until(() => !na.button("Try it", install)?.disabled, 3000);
      na.button("Try it", install).click();
      const tryModal = await na.until(() => modals().find((m) => m.querySelector(".gz-try")), 3000);
      await na.sleep(800);
      na.button("Had a cup", tryModal).click();
      await na.sleep(600);
      const did = [...tryModal.querySelectorAll(".gz-effects li")].map((li) => li.textContent);
      na.button("Close", tryModal).click();
      await na.sleep(300);
      const sameFiles = app.vault.getFiles().length === files;
      na.button("Install", install).click();
      await na.until(() => na.exists("Kettle.md"), 3000);
      return { did, sameFiles, installed: na.exists("Kettle.md"), title: tryModal.querySelector(".modal-title")?.textContent };`);
    expect(r.title === "Try Kettle" && r.did.includes("Saved a row to cups in Kettle data") && r.did.some((d) => d.startsWith("Added to Daily")) && r.sameFiles && r.installed, r);
    return r.did.join(" | ");
  });
}
