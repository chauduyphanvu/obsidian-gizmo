// What the checks use: `window.__na` in the page (opening notes, reading files, notices, waiting),
// and on this side the check runner with PASS, FAIL and SKIP, keys, typing and screenshots.
import { join } from "node:path";

/** Installed once per launch; every check's page code reads it as `na`. */
const PAGE_HELPERS = `(async () => {
  if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
  if (!app.plugins.plugins["note-apps"]) await app.plugins.enablePluginAndSave("note-apps");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const leaf = () => app.workspace.getMostRecentLeaf();
  const view = () => leaf().view;
  const settle = async () => {
    if (view().getViewType() !== "note-app") return sleep(300);
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const el = view().contentEl;
      if (el.querySelector(".note-app") && !el.querySelector(".na-loading")) break;
    }
    await sleep(200);
  };
  const buttons = (root) => [...(root ?? view().contentEl).querySelectorAll("button")];
  // Notices are drawn and taken away again within seconds; every one shown is kept here. They go
  // to activeDocument, which in the test instance can be another window (Obsidian's settings).
  const notices = [];
  const watched = new WeakSet();
  const seen = new WeakSet();
  const watch = () => {
    for (const doc of [document, activeDocument]) {
      if (!doc?.body || watched.has(doc)) continue;
      watched.add(doc);
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          for (const el of n.matches(".notice") ? [n] : n.querySelectorAll(".notice")) {
            if (!seen.has(el)) notices.push(el.textContent);
            seen.add(el);
          }
        }
      }).observe(doc.body, { childList: true, subtree: true });
    }
  };
  watch();
  setInterval(watch, 100);
  window.__na = {
    sleep, leaf, view, settle, notices,
    /** The notices shown after mark (notices.length taken earlier), once one holding part is among them or after ms. */
    noticesSince: async (mark, part = "", ms = 3000) => {
      for (let t = 0; t < ms && !notices.slice(mark).some((n) => n.includes(part)); t += 100) await sleep(100);
      return notices.slice(mark);
    },
    text: (root) => (root ?? view().contentEl).innerText.replace(/\\n+/g, " | "),
    errors: (root) => (root ?? view().contentEl).querySelectorAll(".na-panel.na-error, .na-card.na-error").length,
    state: () => view().getViewType() + ":" + view().file?.path,
    /** Polls until fn() gives something truthy, which it returns; undefined after ms. */
    until: async (fn, ms = 5000) => {
      for (let t = 0; t < ms; t += 100) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
      }
      return undefined;
    },
    /** Opens a note by link text; for an app that asks, reads what it asks for and (unless allow is false) allows it. */
    open: async (path, allow = true) => {
      await app.workspace.openLinkText(path, "", false);
      await settle();
      const allowBtn = buttons().find((b) => b.textContent === "Allow");
      const prompt = allowBtn ? [...allowBtn.closest(".na-card").querySelectorAll("li")].map((li) => li.textContent) : undefined;
      if (allowBtn && allow) {
        allowBtn.click();
        for (let i = 0; i < 50 && buttons().some((b) => b.textContent === "Allow"); i++) await sleep(100);
        await settle();
      }
      return { prompt };
    },
    /** Opens a note as markdown in this leaf: mode "preview" (reading), "live" (live preview) or "source". */
    openMd: async (path, mode) => {
      const state = mode === "preview" ? { mode: "preview" } : { mode: "source", source: mode === "source" };
      await leaf().setViewState({ type: "markdown", state: { file: path, ...state }, active: true });
      await sleep(600);
    },
    button: (label, root) => buttons(root).find((b) => b.textContent === label),
    /** The note-app blocks drawn and visible in a leaf (a markdown view keeps its other mode's copy hidden). */
    embeds: (l = leaf()) => [...l.view.containerEl.querySelectorAll(".na-embed")].filter((e) => e.offsetParent !== null),
    /** Opens a file in a new tab and makes it the active one. */
    openInTab: async (path) => {
      const l = app.workspace.getLeaf("tab");
      await l.openFile(app.vault.getFileByPath(path));
      app.workspace.setActiveLeaf(l, { focus: true });
      await settle();
      return l;
    },
    file: (path) => app.vault.getFileByPath(path),
    exists: (path) => !!app.vault.getAbstractFileByPath(path),
    read: async (path) => { const f = app.vault.getFileByPath(path); return f ? app.vault.read(f) : undefined; },
    write: async (path, text) => {
      const f = app.vault.getFileByPath(path);
      if (f) return app.vault.modify(f, text);
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
      await app.vault.create(path, text);
    },
    remove: async (path) => { const f = app.vault.getAbstractFileByPath(path); if (f) await app.vault.delete(f, true); },
    fm: (path) => { const f = app.vault.getFileByPath(path); return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined; },
    status: () => [...document.querySelectorAll(".status-bar .na-status")].map((e) => e.textContent),
    commands: () => Object.keys(app.commands.commands).filter((id) => id.startsWith("note-apps:")).sort(),
    plugin: () => app.plugins.plugins["note-apps"],
    /** Turns the plugin off and on again, as the user would in settings. */
    reload: async () => {
      await app.plugins.disablePlugin("note-apps");
      await sleep(500);
      await app.plugins.enablePlugin("note-apps");
      await sleep(1500);
    },
    /** Picks an option (by value, else by its text) as a person picking it would. */
    choose: (select, value) => {
      const option = [...select.options].find((o) => o.value === value) ?? [...select.options].find((o) => o.textContent === value);
      if (!option) throw new Error("no option " + value + " in " + [...select.options].map((o) => o.textContent).join(", "));
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    /** Types into an input as a person would (an input event per value). */
    fill: (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
  };
  await sleep(1000);
})()`;

const KEYS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
};

class Skip extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Whether each web address answered (2xx) once in this run, by address. */
const reachable = new Map();

/** Whether a web address answers now; any network failure or non-2xx answer is "no". */
async function answers(url) {
  if (!reachable.has(url)) {
    reachable.set(url, (async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "Mozilla/5.0" } });
        return res.ok ? true : `answered ${res.status}`;
      } catch (e) {
        return e.cause?.code ?? e.message;
      }
    })());
  }
  return reachable.get(url);
}

/** The tools one launch's checks get; `results` collects every check's outcome. */
export async function tools(page, work, phase, results) {
  await page.evaluate(PAGE_HELPERS);
  const run = (body) => page.evaluate(`(async () => { const na = window.__na; ${body} })()`);
  return {
    page, run, sleep, phase,
    /**
     * Runs one check. With `net`, a failure is a SKIP when one of those addresses doesn't answer
     * right now (the check then says nothing about the plugin), and a FAIL when they all do.
     */
    async check(name, fn, opts = {}) {
      const full = `${phase}: ${name}`;
      try {
        const detail = await fn();
        results.push({ name: full, status: "PASS", detail });
      } catch (e) {
        if (e instanceof Skip) return void results.push({ name: full, status: "SKIP", detail: e.message });
        for (const url of opts.net ?? []) {
          const ok = await answers(url);
          if (ok !== true) return void results.push({ name: full, status: "SKIP", detail: `no network: ${new URL(url).host} ${ok}` });
        }
        results.push({ name: full, status: "FAIL", detail: e.message.split("\n")[0] });
      }
    },
    skip(reason) { throw new Skip(reason); },
    /** Throws (fails the check) with the value as JSON unless ok. */
    expect(ok, value) { if (!ok) throw new Error(typeof value === "string" ? value : JSON.stringify(value)); },
    async press(name, modifiers = 0) {
      const k = KEYS[name];
      await page.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", key: k.key, code: k.code, text: k.text, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers });
      await sleep(150);
    },
    /** A real left click at [x, y] in the page: move, press and release, as a mouse would. */
    async click([x, y]) {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
      }
      await sleep(150);
    },
    /**
     * A real mouse drag from one point to another ([x, y] in the page). Chromium hands the drag it
     * starts to CDP, which drops it where the mouse is let go, as the OS would.
     */
    async drag(from, to) {
      let data;
      const stop = page.on("Input.dragIntercepted", (p) => { data = p.data; });
      const mouse = (type, [x, y], buttons) => page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
      await page.send("Input.setInterceptDrags", { enabled: true });
      try {
        await mouse("mouseMoved", from, 0);
        await mouse("mousePressed", from, 1);
        for (let i = 1; i <= 10; i++) {
          await mouse("mouseMoved", [from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10], 1);
          await sleep(30);
        }
        await sleep(200);
        if (data) {
          for (const type of ["dragEnter", "dragOver", "drop"]) await page.send("Input.dispatchDragEvent", { type, x: to[0], y: to[1], data });
        }
        await mouse("mouseReleased", to, 0);
      } finally {
        stop();
        await page.send("Input.setInterceptDrags", { enabled: false });
      }
      return !!data;
    },
    async type(text) {
      await page.send("Input.insertText", { text });
      await sleep(250);
    },
    /** Light or dark, as the Appearance setting sets it ("moonstone" is Obsidian's name for light). */
    async theme(which) {
      const ok = await run(`app.changeTheme("${which === "dark" ? "obsidian" : "moonstone"}"); await na.sleep(400); return document.body.classList.contains("theme-${which}");`);
      if (!ok) throw new Error(`couldn't switch to the ${which} theme`);
    },
    /** A screenshot into the work dir. Obsidian's first-open "trust the author" dialog can arrive at any point; plugins are already on, so it's accepted first. */
    async shot(name, width = 1100, height = 760, scale = 1) {
      await run(`[...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Trust author and enable plugins")?.click(); await na.sleep(300);`);
      // A mouse left over a control by an earlier check would draw a tooltip over the shot.
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: -1, y: -1 });
      return page.shot(join(work, name), width, height, scale);
    },
  };
}
