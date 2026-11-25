// A shared kind between two vaults, each in its own isolated Obsidian, through an ntfy stub on this
// computer; then a guest page in headless Chrome from its file, and gizmod keeping one vault in step
// while its Obsidian is closed.
//   node test/live/share.mjs <empty work dir>     (run `npm run build` first)
// Nothing here reaches a real server: the kind's relay is the stub, and the guest page's own
// Content-Security-Policy lets it reach only that.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { launch } from "./launch.mjs";
import { tools } from "./tools.mjs";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) throw new Error("pass an empty or missing work directory");
const port = Number(process.env.CDP_PORT ?? "9420");
const chromePort = port + 5;
const gizmodPort = 7700 + Math.floor(Math.random() * 200);
const results = [];
const shots = join(work, "shots");
mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The ntfy stub: POST /<topic> keeps a message, GET /<topic>/json?poll=1&since=<id|all> gives those after it.
const topics = new Map();
const requests = [];
const relay = { down: false, drop: 0 };
let next = 0;
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "*" };
    if (relay.down) return void req.socket.destroy();
    const u = new URL(req.url, "http://stub");
    const [topic, json] = u.pathname.slice(1).split("/");
    requests.push({ method: req.method, topic, origin: req.headers.origin, size: body.length });
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    if (req.method === "POST" && topic && !json) {
      if (Buffer.byteLength(body) > 4096) return void res.writeHead(413, cors).end("{}");
      if (relay.drop > 0) relay.drop--;
      else {
        const list = topics.get(topic) ?? [];
        topics.set(topic, list);
        list.push({ id: `s${(next++).toString().padStart(6, "0")}`, time: Math.floor(Date.now() / 1000), message: body });
      }
      return void res.writeHead(200, { ...cors, "content-type": "application/json" }).end("{}");
    }
    if (req.method === "GET" && json === "json" && u.searchParams.get("poll") === "1") {
      const list = topics.get(topic) ?? [];
      const since = u.searchParams.get("since");
      const at = list.findIndex((m) => m.id === since);
      const after = since === "all" || at < 0 ? list : list.slice(at + 1);
      return void res.writeHead(200, { ...cors, "content-type": "application/x-ndjson" }).end(after.map((m) => JSON.stringify({ ...m, event: "message", topic })).join("\n"));
    }
    res.writeHead(404, cors).end();
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
const stubHost = `127.0.0.1:${stub.address().port}`;
const posts = () => requests.filter((r) => r.method === "POST").length;
const allMessages = () => [...topics.values()].flat();

const CHORE = `---
kind: chore
shortcut: chore
fields:
  task: text
  who: [Alex, Sam]
share:
  relay: ${stubUrl}
  key: {secret: chore-key}
---
The household's chores, kept by both of us.
`;

// Closes the window that `selector` finds with Escape, as a person would (this Obsidian's windows have
// no close button to click); one that stays open fails the check.
const shut = async (t, selector) => {
  if (!(await t.run(`return !!document.querySelector(${JSON.stringify(selector)});`))) return;
  await t.press("Escape");
  if (!(await t.run(`return !!(await na.until(() => !document.querySelector(${JSON.stringify(selector)}), 3000));`))) throw new Error(`the window with ${selector} didn't close on Escape`);
};

// A screenshot with Obsidian's settings out of the way: accepting the trust dialog (as tools' shot does) can open them.
const snap = async (t, name) => {
  await t.shot(name);
  await t.run(`app.setting?.close(); await na.sleep(300); return true;`);
  return t.shot(name);
};

// What each vault's page reads: the kind's rows with their lines, and its asks.
const ROWS = `const rows = async () => (await na.plugin().runtime.background.env.actionDeps("Chore.md", "Chore data.md", "you").store.rows("chore")).map((r) => ({ task: r.task, line: r.line, by: r.by, writer: r.writer }));`;

let a, b, chrome, daemon;
try {
  a = await launch({ repo, dir: join(work, "a"), port, fill: (vault) => {
    cpSync(join(repo, "test/vault"), vault, { recursive: true });
    writeFileSync(join(vault, "Chore.md"), CHORE);
  } });
  const ta = await tools(a.page, shots, "vault A", results);
  await ta.run(`app.setting?.close(); return true;`);

  await ta.check("a shared kind asks to share through its relay, with its secret, before anything is sent", async () => {
    const asked = await ta.run(`const r = await na.open("Chore", false); return r.prompt;`);
    await snap(ta, "share-permission.png");
    ta.expect(asked?.some((t) => t.includes(`Share the rows of Chore through ${stubHost}`)) && asked.some((t) => /chore-key/.test(t)) && requests.length === 0, { asked, requests });
    const told = await ta.run(`
      const mark = na.notices.length;
      na.button("Allow").click();
      await na.settle();
      await na.plugin().runtime.background.share("Chore.md");
      return na.noticesSince(mark, "nothing is shared", 4000);`);
    ta.expect(told.some((n) => n.includes("Chore: nothing is shared from this device until the secret chore-key holds the kind's key")) && requests.length === 0, { told, requests });
    return `${asked.join(" · ")}; allowed, and without a key nothing reached the relay`;
  });

  let link;
  await ta.check("Invite to a kind makes the key the first time, keeps it as a secret, and gives a link; the note never holds it", async () => {
    const r = await ta.run(`
      app.commands.executeCommandById("gizmo:invite-kind");
      const modal = await na.until(() => document.querySelector(".modal .gz-invite"), 3000);
      // Never shared yet, so it offers to make a key (and to paste one from another device).
      const name = await na.until(() => modal.querySelector("#gz-share-name"), 3000);
      const offered = modal.innerText;
      na.fill(name, "Ann");
      na.button("Make a key", modal).click();
      const area = await na.until(() => [...document.querySelectorAll(".modal .gz-invite textarea")].find((t) => t.value.startsWith("obsidian://")), 5000);
      return { offered, link: area?.value, text: area?.closest(".modal").innerText, secret: app.secretStorage.getSecret("chore-key"), note: await na.read("Chore.md") };`);
    link = r.link;
    await snap(ta, "share-invite-link.png");
    await shut(ta, ".modal .gz-invite");
    const key = r.secret?.split(".")[1];
    ta.expect(r.offered.includes("Chore has no key yet") && r.offered.includes("Keep this key"), r.offered);
    ta.expect(/^obsidian:\/\/gizmo\?invite=[A-Za-z0-9_-]+$/.test(link ?? "") && r.secret?.startsWith("gzk1.") && key && !r.note.includes(key) && r.text.includes("The key is in the link"), { r: { ...r, secret: r.secret?.slice(0, 5) } });
    return `link of ${link.length} characters; secret chore-key holds the key`;
  });

  b = await launch({ repo, dir: join(work, "b"), port: port + 1, fill: (vault) => cpSync(join(repo, "test/vault"), vault, { recursive: true }) });
  const tb = await tools(b.page, shots, "vault B", results);
  await tb.run(`app.setting?.close(); return true;`);
  const both = (code) => Promise.all([ta.run(code), tb.run(code)]);

  await tb.check("the invite link opened in Obsidian previews the kind and what it asks; Join makes it and keeps the key as a secret", async () => {
    // Pasted as text, the same preview, which is closed unjoined; then the link itself, through this
    // instance's own handler for obsidian://gizmo, which never reaches another Obsidian.
    const pasted = await tb.run(`
      app.commands.executeCommandById("gizmo:join-kind");
      const area = await na.until(() => document.querySelector(".modal .gz-share textarea"), 3000);
      area.value = ${JSON.stringify(link)};
      na.button("Preview", area.closest(".modal")).click();
      const modal = await na.until(() => document.querySelector(".modal .gz-join"), 5000);
      return { text: modal?.innerText, exists: na.exists("Chore.md") };`);
    await shut(tb, ".modal .gz-join");
    ta.expect(pasted.text?.includes("Ann invites you to share Chore") && !pasted.exists, pasted);
    const preview = await tb.run(`
      const handler = app.workspace.protocolHandler?.handlers?.get("gizmo");
      if (!handler) return { via: "none", handlers: [...(app.workspace.protocolHandler?.handlers?.keys() ?? [])] };
      if (document.querySelector(".modal .gz-join")) return { via: "none", why: "a preview was still open" };
      handler({ action: "gizmo", invite: ${JSON.stringify(link)}.split("invite=")[1] });
      const modal = await na.until(() => document.querySelector(".modal .gz-join"), 5000);
      return { via: "link", text: modal?.innerText, exists: na.exists("Chore.md"), previews: document.querySelectorAll(".modal .gz-join").length };`);
    await snap(tb, "share-invite-preview.png");
    ta.expect(preview.via === "link" && preview.previews === 1 && preview.text?.includes("Ann invites you to share Chore") && preview.text.includes("Creates Chore.md") && !preview.exists, preview);
    const joined = await tb.run(`
      const modal = document.querySelector(".modal .gz-join");
      na.fill(modal.querySelector("input"), "Bo");
      na.button("Join", modal).click();
      await na.until(() => na.exists("Chore.md"), 5000);
      const r = await na.open("Chore");
      return { asked: r.prompt, secret: app.secretStorage.getSecret("chore-key")?.slice(0, 5), note: await na.read("Chore.md"), writers: Object.values(na.plugin().runtime.store.writers ?? {}) };`);
    ta.expect(joined.secret === "gzk1." && joined.asked?.some((t) => t.includes(`through ${stubHost}`)) && joined.writers.some((w) => w.name === "Ann" && w.state === "accepted") && !joined.note.includes("gzk1"), joined);
    return `previewed pasted and opened by the link; joined as Bo; Ann accepted`;
  });

  await ta.check("a chore added in A comes into B as logged, from Ann", async () => {
    const before = posts();
    await ta.run(`await na.plugin().runtime.background.capture("chore Bins Alex"); return true;`);
    for (let i = 0; i < 30 && posts() === before; i++) await sleep(200);
    const got = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return rows();`);
    ta.expect(got.some((r) => r.task === "Bins" && r.line === undefined && r.by === "Ann" && r.writer), { got, posts: posts() - before });
    const shown = await tb.run(`
      await na.open("Chore");
      const cells = () => [...na.view().contentEl.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.querySelector("input, select")?.value ?? td.textContent.trim()));
      return (await na.until(() => cells().some((c) => c.includes("Bins") && c.includes("Ann")), 8000)) ? "shown" : JSON.stringify(cells());`);
    await snap(tb, "share-b-rows.png");
    ta.expect(shown === "shown", shown);
    return `sent at once on save (${posts() - before} posts); B's kind note shows Bins, by Ann`;
  });

  await ta.check("a chore from B, whom A never accepted, waits in A's Next; Accept makes it count", async () => {
    await tb.run(`await na.plugin().runtime.background.capture("chore Dishes Sam"); await na.sleep(800); await na.plugin().runtime.background.share("Chore.md"); return true;`);
    const waiting = await ta.run(`${ROWS}
      await na.plugin().runtime.background.share("Chore.md");
      await na.until(() => na.plugin().runtime.background.asks.list().some((a) => a.id.startsWith("writer\\n")), 5000);
      return { rows: await rows(), asks: na.plugin().runtime.background.asks.list().map((a) => a.text) };`);
    ta.expect(waiting.rows.some((r) => r.task === "Dishes" && r.line === "attested" && r.by === "Bo") && waiting.asks.some((t) => /^Accept rows from Bo \(key [0-9a-f]{4}\) in Chore\? 1 row waits, and later ones will count as logged$/.test(t)), waiting);
    const shown = await ta.run(`
      app.commands.executeCommandById("gizmo:next");
      const modal = await na.until(() => [...document.querySelectorAll(".modal")].find((m) => m.innerText.includes("Accept rows from Bo")), 4000);
      return modal?.innerText;`);
    await ta.run(`app.setting?.close(); return true;`);
    await snap(ta, "share-next-ask.png");
    const after = await ta.run(`${ROWS}
      const mark = na.notices.length;
      const modal = [...document.querySelectorAll(".modal")].find((m) => m.innerText.includes("Accept rows from Bo"));
      na.button("Accept", modal).click();
      const told = await na.noticesSince(mark, "Accepted", 4000);
      return { told, rows: await rows(), writers: Object.values(na.plugin().runtime.store.writers ?? {}) };`);
    await shut(ta, ".gz-next-modal");
    ta.expect(shown?.includes("Refuse") && after.told.some((n) => n.startsWith("Chore: Accepted rows from Bo.")) && after.rows.some((r) => r.task === "Dishes" && r.line === undefined) && after.writers.some((w) => w.name === "Bo" && w.state === "accepted"), { shown, after });
    return `asked “Accept rows from Bo in Chore?”; accepted, Dishes logged`;
  });

  await ta.check("a chore undone in A is set aside in B", async () => {
    const undone = await ta.run(`
      const p = na.plugin().runtime;
      const entry = (await p.activity.list("Chore.md")).find((e) => e.changes.some((c) => c.kind === "row-added" && c.row.task === "Bins"));
      return entry ? (await p.undo(entry)).undone : "no entry";`);
    await sleep(1500);
    const got = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return rows();`);
    ta.expect(undone === 1 && got.some((r) => r.task === "Bins" && r.line === "dismissed"), { undone, got });
    return "Bins is dismissed in B";
  });

  await ta.check("a message the relay loses is sent again once B says what it holds", async () => {
    relay.drop = 1;
    await ta.run(`await na.plugin().runtime.background.capture("chore Laundry Sam"); await na.sleep(1500); return true;`);
    await ta.run(`await na.plugin().runtime.background.capture("chore Windows Alex"); await na.sleep(1500); return true;`);
    const first = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return rows();`);
    await ta.run(`await na.plugin().runtime.background.share("Chore.md"); return true;`);
    const then = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return rows();`);
    ta.expect(first.some((r) => r.task === "Windows") && !first.some((r) => r.task === "Laundry") && then.some((r) => r.task === "Laundry" && r.line === undefined), { first, then });
    return "Laundry lost on the way, then sent again from B's summary";
  });

  await ta.check("a chore deleted in A from its sheet, then put back with Undo, is set aside in B and then counts there again", async () => {
    const deleted = await ta.run(`${ROWS}
      await na.open("Chore");
      await na.sleep(600);
      // The kind note's cells are inputs, whose values aren't in its text.
      const shows = (tr) => [...tr.querySelectorAll("td")].some((td) => (td.querySelector("input, select")?.value ?? td.textContent).includes("Windows"));
      const row = await na.until(() => [...na.view().contentEl.querySelectorAll("tbody tr:not(.gz-ledger-group)")].find(shows), 4000);
      row?.click();
      const sheet = await na.until(() => na.view().contentEl.querySelector(".gz-sheet.is-open"), 3000);
      [...(sheet?.querySelectorAll(".gz-sheet-actions > button") ?? [])].find((b) => b.textContent === "Delete")?.click();
      await na.until(async () => !(await rows()).some((r) => r.task === "Windows"), 4000);
      await na.plugin().runtime.background.share("Chore.md");
      return (await rows()).filter((r) => r.task === "Windows");`);
    await sleep(1500);
    const gone = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return (await rows()).filter((r) => r.task === "Windows");`);
    const back = await ta.run(`
      const p = na.plugin().runtime;
      const entry = (await p.activity.list("Chore.md")).find((e) => e.changes.some((c) => c.kind === "row-deleted" && c.row.task === "Windows"));
      const undone = entry ? (await p.undo(entry)).undone : "no entry";
      await na.sleep(800);
      await p.background.share("Chore.md");
      return undone;`);
    await sleep(1500);
    const again = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return (await rows()).filter((r) => r.task === "Windows");`);
    ta.expect(deleted.length === 0 && gone.length === 1 && gone[0].line === "dismissed" && back === 1 && again.length === 1 && again[0].line === undefined, { deleted, gone, back, again });
    return "Windows set aside in B when A deleted it; logged in B again after A's Undo";
  });

  await ta.check("a field A changes in its own row goes to B as a newer version; in B, Ann's row can't be changed or deleted, says whose it is, and Not mine sets it aside in B only", async () => {
    const WHO = `const who = async (task) => (await na.plugin().runtime.background.env.actionDeps("Chore.md", "Chore data.md", "you").store.rows("chore")).filter((r) => r.task === task).map((r) => ({ who: r.who, line: r.line }));`;
    const changed = await ta.run(`${WHO}
      await na.open("Chore");
      const shows = (tr) => [...tr.querySelectorAll("td")].some((td) => (td.querySelector("input, select")?.value ?? td.textContent).includes("Laundry"));
      const row = await na.until(() => [...na.view().contentEl.querySelectorAll("tbody tr:not(.gz-ledger-group)")].find(shows), 4000);
      na.choose(row.querySelector("select.gz-edit"), "Alex");
      await na.until(async () => (await who("Laundry"))[0]?.who === "Alex", 4000);
      await na.plugin().runtime.background.share("Chore.md");
      return who("Laundry");`);
    await sleep(1500);
    const inB = await tb.run(`${WHO}
      await na.plugin().runtime.background.share("Chore.md");
      await na.open("Chore");
      const shows = (tr) => [...tr.querySelectorAll("td")].some((td) => (td.querySelector("input, select")?.value ?? td.textContent).includes("Laundry"));
      const row = await na.until(() => [...na.view().contentEl.querySelectorAll("tbody tr:not(.gz-ledger-group)")].find(shows), 4000);
      const cells = { inputs: row.querySelectorAll("input, select").length, title: row.getAttribute("title"), text: [...row.querySelectorAll("td")].map((td) => td.textContent.trim()) };
      row.click();
      const sheet = await na.until(() => na.view().contentEl.querySelector(".gz-sheet.is-open"), 3000);
      return { rows: await who("Laundry"), cells, theirs: sheet?.querySelector(".gz-sheet-theirs")?.textContent, buttons: [...(sheet?.querySelectorAll(".gz-sheet-actions > button") ?? [])].map((b) => b.textContent), editable: sheet?.querySelectorAll("input, select, textarea").length };`);
    await snap(tb, "share-theirs-sheet.png");
    const aside = await tb.run(`${WHO}
      const sheet = na.view().contentEl.querySelector(".gz-sheet.is-open");
      [...sheet.querySelectorAll(".gz-sheet-actions > button")].find((b) => b.textContent === "Not mine").click();
      await na.until(async () => (await who("Laundry"))[0]?.line === "dismissed", 4000);
      await na.sleep(600);
      const said = na.view().contentEl.querySelector(".gz-said, .gz-undo-bar")?.textContent;
      await na.plugin().runtime.background.share("Chore.md");
      return { rows: await who("Laundry"), said };`);
    await snap(tb, "share-theirs-aside.png");
    await sleep(1500);
    const inA = await ta.run(`${WHO} await na.plugin().runtime.background.share("Chore.md"); return who("Laundry");`);
    ta.expect(changed[0]?.who === "Alex" && inB.rows[0]?.who === "Alex", { changed, inB: inB.rows });
    ta.expect(inB.cells.inputs === 0 && inB.cells.title === "By Ann; only Ann can change it" && inB.theirs === "By Ann; only Ann can change it." && inB.buttons.includes("Not mine") && !inB.buttons.includes("Delete") && inB.editable === 0, inB);
    ta.expect(aside.rows[0]?.line === "dismissed" && inA[0]?.line === undefined && inA[0]?.who === "Alex", { aside, inA });
    return `Laundry's who Sam → Alex in A, then in B; B: "${inB.theirs}" buttons ${inB.buttons.join(", ")}; Not mine set it aside in B, still logged in A`;
  });

  let pagePath, code;
  await ta.check("Make a guest page writes one HTML file beside the kind, with no key in it, and gives its code", async () => {
    const r = await ta.run(`
      await na.open("Chore");
      app.commands.executeCommandById("gizmo:guest-page");
      const modal = await na.until(() => document.querySelector(".modal .gz-guest input"), 3000);
      na.fill(modal, "Sitter");
      na.button("Make the page", modal.closest(".modal")).click();
      const area = await na.until(() => document.querySelector(".modal .gz-guest textarea"), 5000);
      const text = area?.closest(".modal").innerText;
      const file = app.vault.getFiles().find((f) => f.name.startsWith("Chore guest page"));
      return { code: area?.value, text, path: file?.path, html: file ? await app.vault.read(file) : "", secret: app.secretStorage.getSecret("chore-key") };`);
    await snap(ta, "share-guest-made.png");
    await shut(ta, ".modal .gz-guest");
    code = r.code;
    pagePath = r.path && join(a.vault, r.path);
    const parts = r.secret.split(".");
    ta.expect(/^gzg1\./.test(code ?? "") && r.path === "Chore guest page (Sitter).html" && ![parts[1], parts[2], code.split(".")[1], code.split(".")[2]].some((s) => r.html.includes(s)) && r.text.includes("Rows from it go to Ann"), { ...r, html: r.html.length, secret: undefined });
    return `${r.path}, ${r.html.length} bytes`;
  });

  await ta.check("the guest page, opened from its file on a phone-sized screen: a changed code is refused; offline it adds nothing; online it adds a row, logged in A, which made it; waiting in B", async () => {
    const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (!existsSync(chromeBin)) ta.skip("no Chrome on this computer");
    chrome = spawn(chromeBin, ["--headless=new", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${join(work, "chrome")}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
    const page = await chromePage(chromePort);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.send("Page.enable");
    await page.send("Network.enable");
    const start = posts();
    // Four characters of its key changed, each still base64: the page tells it isn't its own.
    const parts = code.split(".");
    parts[1] = [...parts[1]].map((c, i) => (i >= 10 && i < 14 ? (c === "A" ? "B" : "A") : c)).join("");
    await page.send("Page.navigate", { url: `file://${encodeURI(pagePath)}#${parts.join(".")}` });
    await sleep(1500);
    const refused = await page.eval(`({ form: !document.getElementById("form").hidden, why: document.getElementById("why").hidden ? "" : document.getElementById("why").textContent })`);
    await page.shot(join(shots, "guest-page-wrong-code.png"));
    // Only the part after # differs, which a browser takes as the same page: by way of a blank one.
    await page.send("Page.navigate", { url: "about:blank" });
    await sleep(300);
    await page.send("Page.navigate", { url: `file://${encodeURI(pagePath)}#${code}` });
    await sleep(1500);
    const shown = await page.eval(`({ form: !document.getElementById("form").hidden, text: document.body.innerText, csp: document.querySelector("meta[http-equiv]").content })`);
    await page.shot(join(shots, "guest-page-phone-before.png"));
    const answer = async () => {
      for (let i = 0; i < 40; i++) {
        const said = await page.eval(`({ cls: document.getElementById("said").className, text: document.getElementById("said").textContent, task: document.getElementById("f-task").value, list: document.getElementById("list").innerText })`);
        if (said.cls) return said;
        await sleep(200);
      }
    };
    await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.eval(`(() => {
      document.getElementById("f-task").value = "Fed the cat";
      document.getElementById("f-who").value = "Alex";
      document.getElementById("form").requestSubmit();
      return true;
    })()`);
    const offline = await answer();
    await page.shot(join(shots, "guest-page-offline.png"));
    await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const before = posts();
    await page.eval(`(() => { document.getElementById("said").className = ""; document.getElementById("form").requestSubmit(); return true; })()`);
    const said = await answer();
    await page.shot(join(shots, "guest-page-phone-after.png"));
    page.close();
    ta.expect(!refused.form && refused.why.startsWith("This code isn't for this page.") && before === start, { refused, posts: before - start });
    ta.expect(offline?.cls === "bad" && offline.text.endsWith("Nothing was added; try again.") && offline.task === "Fed the cat" && !offline.list, offline);
    ta.expect(shown.form && shown.text.includes("This page is for Sitter") && said?.cls === "ok" && posts() === before + 1 && requests.at(-1).origin === "null", { shown, said, last: requests.at(-1) });
    const inA = await ta.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return rows();`);
    const inB = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); await na.sleep(500); return { rows: await rows(), asks: na.plugin().runtime.background.asks.list().map((a) => a.text) };`);
    ta.expect(inA.some((r) => r.task === "Fed the cat" && r.line === undefined && r.by === "Sitter") && inB.rows.some((r) => r.task === "Fed the cat" && r.line === "attested" && r.by === "Sitter") && inB.asks.some((t) => /^Accept rows from Sitter \(key [0-9a-f]{4}\) in Chore\?/.test(t)), { inA, inB });
    return `changed code: “${refused.why.split(".")[0]}”; offline: “${offline.text}”; then ${said.text} A: logged, by Sitter; B asks “Accept rows from Sitter in Chore?”`;
  });

  await ta.check("the map lists each shared kind with its writers and Remove; Remove stops a writer and keeps their rows", async () => {
    const card = await ta.run(`
      app.commands.executeCommandById("gizmo:open-map");
      const el = await na.until(() => document.querySelector(".gz-map-shared"), 5000);
      el?.scrollIntoView();
      return el?.innerText;`);
    await snap(ta, "share-map-writers.png");
    const removed = await ta.run(`${ROWS}
      const el = document.querySelector(".gz-map-shared");
      const li = [...el.querySelectorAll("li")].find((l) => l.textContent.startsWith("Sitter"));
      const mark = na.notices.length;
      na.button("Remove", li).click();
      const told = await na.noticesSince(mark, "no longer", 3000);
      return { told, state: Object.values(na.plugin().runtime.store.writers).find((w) => w.name === "Sitter")?.state, rows: await rows() };`);
    ta.expect(card?.includes("Bo: accepted") && card.includes("Sitter (guest page): accepted") && removed.state === "removed" && removed.told.some((n) => n.includes("rows from Sitter no longer come in. The rows of theirs already here stay")) && removed.rows.some((r) => r.task === "Fed the cat"), { card, removed });
    return card.split("\n").slice(0, 4).join(" · ");
  });

  await ta.check("a tampered message, and one sealed with another key, are left out without a word", async () => {
    const real = allMessages().at(-1).message;
    const topic = [...topics.keys()][0];
    const list = topics.get(topic);
    const flip = real.slice(0, -5) + (real.at(-5) === "A" ? "B" : "A") + real.slice(-4);
    list.push({ id: `s${(next++).toString().padStart(6, "0")}`, time: Math.floor(Date.now() / 1000), message: flip });
    list.push({ id: `s${(next++).toString().padStart(6, "0")}`, time: Math.floor(Date.now() / 1000), message: `gz1.m.${"A".repeat(16)}.${"B".repeat(120)}` });
    const r = await ta.run(`${ROWS}
      const before = (await rows()).length;
      const mark = na.notices.length;
      await na.plugin().runtime.background.share("Chore.md");
      await na.sleep(500);
      const id = na.plugin().runtime.device.id;
      const st = JSON.parse(await app.vault.adapter.read(".obsidian/plugins/gizmo/share/" + id + ".json"));
      return { before, after: (await rows()).length, notices: na.notices.slice(mark), ignored: st.kinds["Chore.md"].ignored };`);
    ta.expect(r.before === r.after && r.notices.length === 0 && r.ignored >= 2, r);
    return `rows unchanged, no notice; ${r.ignored} left out`;
  });

  await ta.check("A offline: what B adds meanwhile comes in when A's Obsidian opens again", async () => {
    await ta.run(`await na.plugin().runtime.beat.leave(); return true;`);
    a.page.close();
    a.quit();
    await sleep(1500);
    await tb.run(`await na.plugin().runtime.background.capture("chore Mop Sam"); await na.sleep(800); await na.plugin().runtime.background.capture("chore Sweep Alex"); await na.sleep(800); await na.plugin().runtime.background.share("Chore.md"); return true;`);
    a = await launch({ repo, dir: join(work, "a"), port, vault: a.vault });
    const ta2 = await tools(a.page, shots, "vault A", results);
    Object.assign(ta, ta2);
    const got = await ta.run(`${ROWS} return na.until(async () => { const r = await rows(); return r.some((x) => x.task === "Mop") && r.some((x) => x.task === "Sweep") && r; }, 30000);`);
    ta.expect(Array.isArray(got) && got.filter((r) => ["Mop", "Sweep"].includes(r.task)).every((r) => r.line === undefined && r.by === "Bo"), got);
    return "Mop and Sweep came in on start, logged";
  });

  await ta.check("gizmod keeps A in step while its Obsidian is closed: sends what A saved while the relay was down, and takes in B's", async () => {
    const secret = await ta.run(`return app.secretStorage.getSecret("chore-key");`);
    relay.down = true;
    const saved = await ta.run(`${ROWS} await na.plugin().runtime.background.capture('chore "Feed the fish" Sam'); await na.sleep(800); await na.plugin().runtime.background.share("Chore.md"); return (await rows()).some((r) => r.task === "Feed the fish");`);
    await ta.run(`await na.plugin().runtime.beat.leave(); return true;`);
    a.page.close();
    a.quit();
    a = undefined;
    relay.down = false;
    await tb.run(`await na.plugin().runtime.background.capture('chore "Water plants" Alex'); await na.sleep(800); await na.plugin().runtime.background.share("Chore.md"); return true;`);
    const home = join(work, "gizmod-home");
    mkdirSync(home, { recursive: true });
    const env = { ...process.env, GIZMOD_HOME: home, GIZMOD_PORT: String(gizmodPort), GIZMOD_MAC_NOTICES: "0", GIZMO_SECRET_CHORE_KEY: secret };
    delete env.GIZMOD_NTFY_URL;
    daemon = spawn(process.execPath, [join(repo, "gizmod.mjs"), "serve", "--vault", join(work, "a", "vault")], { env });
    let log = "";
    daemon.stdout.on("data", (d) => { log += d; });
    daemon.stderr.on("data", (d) => { log += d; });
    const dataNote = join(work, "a", "vault", "Chore data.md");
    let note = "";
    for (let i = 0; i < 100 && !(note.includes("Water plants")); i++) {
      await sleep(300);
      note = existsSync(dataNote) ? readFileSync(dataNote, "utf8") : "";
    }
    const inB = await tb.run(`${ROWS} await na.plugin().runtime.background.share("Chore.md"); return rows();`);
    const shareFiles = readdirSync(join(work, "a", "vault", ".obsidian/plugins/gizmo/share"));
    ta.expect(saved && note.includes("Water plants") && inB.some((r) => r.task === "Feed the fish" && r.by === "Ann"), { saved, note: note.slice(0, 600), inB, log: log.slice(-800) });
    return `gizmod took in Water plants and sent Feed the fish; share files: ${shareFiles.join(", ")}`;
  });
} catch (e) {
  results.push({ name: "share: the run itself", status: "FAIL", detail: e.message.split("\n")[0] });
} finally {
  daemon?.kill();
  chrome?.kill();
  for (const x of [a, b]) {
    if (!x) continue;
    x.page.close();
    x.quit();
  }
  stub.close();
}
const external = requests.filter((r) => !r.topic);
for (const r of results) console.log(`${r.status}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} passed, ${failed} failed; ${requests.length} requests to the stub (${posts()} posts${external.length ? `, ${external.length} without a topic` : ""}); screenshots in ${shots}`);
process.exit(failed ? 1 : 0);

/** The first page of a headless Chrome on this CDP port: eval, screenshots, CDP calls. */
async function chromePage(cdpPort) {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    target = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => undefined);
  }
  if (!target) throw new Error("headless Chrome didn't come up");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  return {
    send,
    eval: async (expression) => {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
      return res.result?.result?.value;
    },
    shot: async (file) => {
      const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      writeFileSync(file, Buffer.from(res.result.data, "base64"));
    },
    close: () => ws.close(),
  };
}
