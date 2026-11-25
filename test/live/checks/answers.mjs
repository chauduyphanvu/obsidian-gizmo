// Links that answer: a number panel's shortcut sends its value back to the app that opened its link.
// window.open is stubbed, so nothing leaves the test instance.

const WATER = `---
app: Count the glasses of water I drink
panels:
  - view: button
    label: Drank a glass
    save: glasses
    shortcut: drank
  - view: number
    title: Glasses today
    source: glasses
    where: {at: today}
    agg: count
    shortcut: glasses
---
`;

export default async function answers(t) {
  const { check, run, expect, shot } = t;

  await check("an answer shortcut asks to send its value; its keyed link asks once where it goes, then sends it back", async () => {
    const r = await run(`
      await na.write("Apps/Water.md", ${JSON.stringify(WATER)});
      await na.sleep(800);
      const { prompt } = await na.open("Apps/Water");
      na.button("Drank a glass").click();
      await na.until(() => na.fm("Apps/Water data.md")?.glasses?.length === 1, 3000);
      const opened = [];
      const realOpen = window.open;
      window.open = (url) => { opened.push(String(url)); return null; };
      try {
        const link = na.plugin().runtime.background.shortcutLinks().find((l) => l.app === "Water" && l.shortcut === "glasses");
        const send = () => {
          const url = new URL(link.link);
          app.workspace.protocolHandler.dispatch({ action: url.host, ...Object.fromEntries(url.searchParams), "x-success": "shortcuts://x-callback-url/run-shortcut?name=Water", "x-source": "Shortcuts" });
        };
        send();
        const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);
        const modal = await na.until(() => modals().find((m) => m.innerText.includes("would send its value")), 3000);
        const title = modal?.querySelector(".modal-title")?.textContent;
        const buttons = modal ? [...modal.querySelectorAll("button")].map((b) => b.textContent) : [];
        if (modal) na.button("Always", modal).click();
        await na.until(() => opened.length === 1, 3000);
        send();
        await na.until(() => opened.length === 2, 3000);
        const again = modals().some((m) => m.innerText.includes("would send its value"));
        const log = (await na.plugin().runtime.activity.list("Apps/Water.md"))[0];
        return { prompt, title, buttons, opened, again, sent: log?.sent };
      } finally {
        window.open = realOpen;
      }`);
    expect(r.prompt?.includes("Send its “glasses” value to the app that opens its link"), r);
    expect(r.title === "Water would send its value (Glasses today) to shortcuts://x-callback-url" && r.buttons.join() === "Cancel,Once,Always", r);
    expect(r.opened[0] === "shortcuts://x-callback-url/run-shortcut?name=Water&result=1&value=1" && r.opened.length === 2 && !r.again, r);
    expect(r.sent?.to === "shortcuts://x-callback-url" && r.sent.shown === "1", r);
    return r.opened[0];
  });

  await check("a link to an answer without its key asks first, naming where the value goes, not what the link calls itself", async () => {
    const r = await run(`
      const opened = [];
      const realOpen = window.open;
      window.open = (url) => { opened.push(String(url)); return null; };
      try {
        app.workspace.protocolHandler.dispatch({ action: "gizmo", app: "Water", do: "glasses", "x-success": "raycast://extensions/x", "x-source": "Shortcuts" });
        const modals = () => [document, activeDocument].flatMap((d) => [...d.querySelectorAll(".modal")]);
        const modal = await na.until(() => modals().find((m) => m.innerText.includes("A link asks for")), 3000);
        const text = modal?.innerText;
        if (modal) na.button("Cancel", modal).click();
        await na.sleep(500);
        const mark = na.notices.length;
        app.workspace.protocolHandler.dispatch({ action: "gizmo", app: "Water", do: "glasses", "x-success": "javascript:alert(1)" });
        const refused = await na.noticesSince(mark, "Refused");
        return { text, opened, refused };
      } finally {
        window.open = realOpen;
      }`);
    expect(r.text?.includes("Its value goes to raycast://extensions") && !r.text.includes("Shortcuts") && r.opened.length === 0, r);
    expect(r.refused.some((n) => n.startsWith("Refused a link to “glasses” in Water: x-success goes to javascript:")), r);
    return r.refused.at(-1);
  });
}
