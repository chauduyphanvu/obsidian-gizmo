// gizmod on a copy of the test vault with Obsidian closed, then Obsidian opening the same folder,
// and gizmod installed as a launchd agent under a test label and removed again.
//   node test/live/gizmod.mjs <empty work dir>     (run `npm run build` first)
// Apps are allowed and keys made in Obsidian first, as a person would; gizmod only reads them. A
// stub server on this computer stands in for the web (Pulse's source) and for ntfy.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttps } from "node:https";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "./launch.mjs";
import { tools } from "./tools.mjs";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) throw new Error("pass an empty or missing work directory");
const port = Number(process.env.CDP_PORT ?? "9380");
const gizmodPort = 7700 + Math.floor(Math.random() * 200);
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(work, "shots"), { recursive: true });

// The web (https, which sources must use, with a certificate made for this run and trusted by gizmod
// only) and ntfy, on this computer.
mkdirSync(work, { recursive: true });
spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"), "-days", "1",
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const web = createHttps({ key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) }, (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ now: { v: 5 } }));
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const webUrl = `https://127.0.0.1:${web.address().port}`;
const pushes = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url === "/ntfy" && req.method === "POST") pushes.push({ body, title: req.headers.title, actions: req.headers.actions });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/pulse" ? JSON.stringify({ now: { v: 5 } }) : "{}");
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

const PULSE = `---
app: Pulse
data:
  pulse:
    source: ${webUrl}/pulse
    record: 1h
    pick: now
panels:
  - view: number
    title: Pulse
    source: pulse_log
    field: v
    agg: last
    alert: "> 3"
    shortcut: pulse
---
`;

// Two apps due a few minutes from now: Vitamins gets its row in time, Pills doesn't.
const due = new Date(Date.now() + 150_000);
const by = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
const rhythmApp = (name) => `---
app: ${name}
panels:
  - view: button
    label: Took
    save: doses
    shortcut: took
expect:
  - {id: daily, every: day, by: "${by}", source: doses, say: "nothing by ${by}"}
---
`;

// Allowed in Obsidian as a plain button, then given a web panel while Obsidian is closed: gizmod finds it paused.
// Adds a line to the Daily note, run by gizmod while Obsidian has that note open and is being typed in.
const JOT = "---\napp: Jot\npanels:\n  - view: button\n    label: Jot\n    append: Daily.md\n    line: \"- jotted by gizmod\"\n    shortcut: jot\n---\n";
const PAUSE = "---\napp: Pause\npanels:\n  - view: button\n    label: Did it\n    save: done\n---\n";
const PAUSE_MORE = `---\napp: Pause\npanels:\n  - view: button\n    label: Did it\n    save: done\n  - view: number\n    title: Pulse\n    source: ${webUrl}/pulse\n    pick: now.v\n---\n`;

const home = join(work, "home");
const env = { ...process.env, NODE_EXTRA_CA_CERTS: join(work, "cert.pem"), GIZMOD_HOME: home, GIZMOD_PORT: String(gizmodPort), GIZMOD_NTFY_URL: `${stubUrl}/ntfy`, GIZMOD_MAC_NOTICES: "0" };
const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(repo, "gizmod.mjs"), ...args], { env, encoding: "utf8" });
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = r.stdout + r.stderr; }
  return { code: r.status, out };
};
const until = async (fn, ms = 10000) => {
  for (let t = 0; t < ms; t += 200) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return fn();
};

let a, b, daemon;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", detail });
  } catch (e) {
    results.push({ name, status: "FAIL", detail: e.message.split("\n")[0].slice(0, 400) });
  }
};
const expect = (ok, detail) => { if (!ok) throw new Error(JSON.stringify(detail)); };

try {
  a = await launch({ repo, dir: join(work, "a"), port, fill: (vault) => {
    cpSync(join(repo, "test/vault"), vault, { recursive: true });
    writeFileSync(join(vault, "Apps/Pulse.md"), PULSE);
    writeFileSync(join(vault, "Apps/Pills.md"), rhythmApp("Pills"));
    writeFileSync(join(vault, "Apps/Vitamins.md"), rhythmApp("Vitamins"));
    writeFileSync(join(vault, "Apps/Pause.md"), PAUSE);
    writeFileSync(join(vault, "Apps/Jot.md"), JOT);
  } });
  const vault = a.vault;
  const ta = await tools(a.page, join(work, "shots"), "obsidian", results);
  const keys = await ta.run(`
    await na.open("Apps/Pulse");
    await na.open("Apps/Errands");
    await na.open("Apps/Pills");
    await na.open("Apps/Vitamins");
    await na.open("Apps/Pause");
    await na.open("Apps/Jot");
    const pack = na.plugin().runtime.background.captureIndex().names.get("pack");
    await na.open(pack.path.replace(/\\.md$/, ""));
    const link = na.plugin().runtime.linkKey("Apps/Errands.md", "add", true);
    const capture = await na.plugin().runtime.newCaptureKey([pack]);
    await na.sleep(1500);
    // As Obsidian quitting does; the harness stops it with a signal, which skips its quit event.
    await na.plugin().runtime.beat.leave();
    return { link, capture, pack: pack.path };`);
  a.page.close();
  a.quit();
  a = undefined;
  await sleep(1500);
  // Edited while Obsidian is closed; gizmod's own record says it has been paused for eleven minutes, as if it ran then.
  writeFileSync(join(vault, "Apps/Pause.md"), PAUSE_MORE);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "devices.json"), JSON.stringify({ [resolve(vault)]: "gzpause1" }));
  mkdirSync(join(vault, ".obsidian/plugins/gizmo/triggers"), { recursive: true });
  writeFileSync(join(vault, ".obsidian/plugins/gizmo/triggers/gzpause1.json"),
    JSON.stringify({ v: 2, fired: { "Apps/Pause.md\npaused:": { paused: Date.now() - 11 * 60_000, reason: "now asks to fetch data" } } }));

  daemon = spawn(process.execPath, [join(repo, "gizmod.mjs"), "serve", "--vault", vault], { env });
  let log = "";
  daemon.stdout.on("data", (d) => { log += d; });
  daemon.stderr.on("data", (d) => { log += d; });
  await until(() => log.includes("listening on"), 15000);
  const http = (method, path, key, body) => fetch(`http://127.0.0.1:${gizmodPort}${path}`, {
    method, headers: { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json" }, body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  await check("gizmod: with Obsidian closed it runs background work, and says where it listens", async () => {
    const s = cli("status");
    expect(s.code === 0 && s.out.runsBackground === true && /listening on 127\.0\.0\.1/.test(log), { s, log });
    return `${s.out.device}, ${s.out.apps} apps; ${log.split("\n").find((l) => l.includes("listening"))?.slice(20)}`;
  });

  await check("gizmod: Pulse's record is kept in gizmod's own log and its data note, and its alert is pushed with only its title", async () => {
    const pushed = await until(() => pushes.find((p) => p.body.startsWith("Pulse")), 15000);
    const fm = await until(() => {
      const text = existsSync(join(vault, "Apps/Pulse data.md")) ? readFileSync(join(vault, "Apps/Pulse data.md"), "utf8") : "";
      return text.includes("pulse_log") && text;
    }, 15000);
    const logs = existsSync(join(vault, "Apps/Pulse data/log")) ? readdirSync(join(vault, "Apps/Pulse data/log")) : [];
    expect(pushed?.body === "Pulse: Pulse" && fm && /v: 5/.test(fm) && logs.some((f) => f.startsWith("gz")), { pushes, fm, logs, log: log.slice(-600) });
    return `pushed “${pushed.body}”; logs ${logs.join(", ")}`;
  });

  await check("gizmod: an app allowed in Obsidian that now asks for more is paused, pushed once, and listed in its status", async () => {
    const pushed = await until(() => pushes.find((p) => p.body.startsWith("Pause")), 15000);
    const s = cli("status");
    await sleep(500);
    const count = pushes.filter((p) => p.body.startsWith("Pause")).length;
    expect(pushed?.body === "Pause: paused in the background" && count === 1 && s.out.paused?.[0]?.app === "Pause" && /fetch data from 127\.0\.0\.1/.test(s.out.paused[0].reason),
      { pushes, status: s.out, log: log.slice(-600) });
    return `pushed “${pushed.body}”; status: ${s.out.paused[0].reason}`;
  });

  await check("gizmod: run, get and do from the command line; over HTTP a link key runs its shortcut and no key runs nothing", async () => {
    const run = cli("run", "Errands", "add", "errand=milk");
    const get = cli("get", "Pulse", "pulse");
    const doIt = cli("do", "pack", "Chargers");
    const none = await http("POST", "/run/Errands/add", undefined, { errand: "eggs" });
    const keyed = await http("POST", "/run/Errands/add", keys.link, { errand: "bread" });
    const wrong = await http("POST", "/run/Errands/add", keys.capture, { errand: "cake" });
    const captured = await http("POST", "/do", keys.capture, { line: "pack gifts" });
    expect(run.code === 0 && get.out.value === 5 && doIt.code === 0 && none.status === 401 && keyed.status === 200 && wrong.status === 403 && captured.status === 200,
      { run, get, doIt, none, keyed, wrong, captured });
    return `get Pulse: ${get.out.shown}; no key ${none.status}, link key ${keyed.status}, wrong key ${wrong.status}, capture key ${captured.status}`;
  });

  await check("gizmod: a rhythm missed by its deadline is pushed, with a Done button only where Tailscale runs; one whose row came in time isn't", async () => {
    // The row must come before the deadline, set when the script started; a run that got here late says so.
    if (Date.now() > due.getTime() - 20_000 || due.getDate() !== new Date(due.getTime() - 150_000).getDate()) throw new Error(`started too close to ${by} to tell a row in time from a late one`);
    const took = cli("run", "Vitamins", "took");
    const wait = due.getTime() + 90_000 - Date.now();
    const pushed = await until(() => pushes.find((p) => p.body.startsWith("Pills")), Math.max(wait, 1000));
    // The miss is a row in Pills' data: in gizmod's log at once, in the note at its next snapshot (5 s).
    const note = () => (existsSync(join(vault, "Apps/Pills data.md")) ? readFileSync(join(vault, "Apps/Pills data.md"), "utf8") : "");
    const missed = (await until(() => note().includes("expect_missed") && note(), 15000)) || note();
    const vitamins = pushes.filter((p) => p.body.startsWith("Vitamins"));
    expect(took.code === 0 && pushed?.body === `Pills: nothing by ${by}` && vitamins.length === 0 && missed.includes("expect_missed"), { took, pushes, missed, log: log.slice(-800) });
    // The button POSTs to gizmod's Tailscale address with a token for the one line; without Tailscale there is none.
    if (log.includes("Tailscale isn't running here")) {
      expect(pushed.actions === undefined, pushed);
      return `pushed “${pushed.body}” with no button (no Tailscale here); Vitamins quiet`;
    }
    const url = /^http, Done, (http:\/\/[\d.]+:\d+\/answer\/[0-9a-f]{48}), method=POST, clear=true$/.exec(pushed.actions ?? "")?.[1];
    const pressed = url && await fetch(url, { method: "POST" }).then((r) => r.status);
    const again = url && await fetch(url, { method: "POST" }).then((r) => r.status);
    expect(pressed === 200 && again === 410, { pushed, pressed, again });
    return `pushed “${pushed.body}”; its Done button logged the dose once; Vitamins quiet`;
  });

  b = await launch({ repo, dir: join(work, "b"), port: port + 1, vault });
  const tb = await tools(b.page, join(work, "shots"), "obsidian again", results);
  await check("gizmod: Obsidian opening the folder shows gizmod's rows, names gizmod as the runner, and doesn't tell Pulse's alert again", async () => {
    const seen = await tb.run(`
      const p = na.plugin().runtime;
      await na.until(() => p.beat?.runner, 8000);
      await p.beat.beat(true);
      await na.open("Apps/Errands");
      const shown = await na.until(() => na.text().includes("milk") && na.text().includes("bread") && na.text(), 10000);
      await na.sleep(3000);
      return { runner: p.beat.runner?.name, here: p.beat.isRunner(), gizmodHere: p.beat.quietHere(), shown: !!shown, notices: na.notices.filter((n) => n.startsWith("Pulse")) };`);
    expect(seen.runner === "gizmod" && !seen.here && seen.gizmodHere && seen.shown && seen.notices.length === 0, seen);
    await tb.shot("gizmod-errands.png");
    return `runner: ${seen.runner}; errands from gizmod shown; no Pulse notice here`;
  });

  await check("gizmod beside Obsidian: a line gizmod adds to the Daily note while it's open and being typed in loses nothing", async () => {
    const typed = "typed while gizmod wrote";
    const typing = tb.run(`
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(app.vault.getFileByPath("Daily.md"), { state: { mode: "source" } });
      await na.sleep(800);
      const ed = leaf.view.editor;
      for (const ch of ${JSON.stringify(typed)}) {
        ed.replaceRange(ch, { line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length });
        await na.sleep(120);
      }
      return true;`);
    // Midway through the typing, gizmod adds its line to the same note on disk.
    await sleep(1800);
    const jot = cli("run", "Jot", "jot");
    await typing;
    // Obsidian saves a couple of seconds after the typing stops.
    await sleep(5000);
    const onDisk = readFileSync(join(vault, "Daily.md"), "utf8");
    const inEditor = await tb.run(`return app.workspace.activeEditor?.editor?.getValue() ?? null;`);
    // Nothing lost: every character typed is there, in order, once gizmod's line is taken out.
    const without = (text) => (text ?? "").replace("- jotted by gizmod\n", "").replace("- jotted by gizmod", "");
    const kept = { typed: without(onDisk).includes(typed), jotted: onDisk.includes("- jotted by gizmod"), editor: without(inEditor).includes(typed) && !!inEditor?.includes("- jotted by gizmod") };
    await tb.shot("gizmod-daily.png");
    expect(jot.code === 0 && kept.typed && kept.jotted && kept.editor && onDisk === inEditor, { jot, kept, onDisk, inEditor });
    // Obsidian merges a change made on disk into the note being typed in where the two part: the line may land mid-word.
    return onDisk.includes(typed) ? "both kept, the line on its own" : `both kept; the line landed inside the typing: ${JSON.stringify(onDisk.split("\n").slice(-3).join("\n"))}`;
  });

  await check("gizmod quitting says so: Obsidian takes over background work at once, not after 20 minutes", async () => {
    daemon.kill("SIGTERM");
    const exited = await until(() => daemon.exitCode !== null || daemon.signalCode !== null, 10000);
    const took = await tb.run(`
      const p = na.plugin().runtime;
      const t0 = Date.now();
      const here = await na.until(async () => { await p.beat.beat(); return p.beat.isRunner(); }, 60000);
      await na.sleep(3000);
      return { here: !!here, ms: Date.now() - t0, runner: p.beat.runner?.name, gizmodHere: p.beat.quietHere(), notices: na.notices.filter((n) => n.startsWith("Pulse")) };`);
    expect(exited && took.here && !took.gizmodHere && took.notices.length === 0, { exited, took, log: log.slice(-600) });
    daemon = undefined;
    return `Obsidian runs it ${Math.round(took.ms / 1000)} s after gizmod quit; no Pulse alert told again`;
  });
  b.page.close();
  b.quit();
  b = undefined;
} catch (e) {
  results.push({ name: "gizmod: the run itself", status: "FAIL", detail: e.message.split("\n")[0] });
} finally {
  if (a) { a.page.close(); a.quit(); }
  if (b) { b.page.close(); b.quit(); }
  daemon?.kill();
}

// Installed under a test label on a vault of its own, checked running, then removed.
const label = "com.gizmo.gizmod-test";
const installVault = join(work, "install-vault");
mkdirSync(installVault, { recursive: true });
writeFileSync(join(installVault, "Note.md"), "nothing to run\n");
const installEnv = { ...process.env, GIZMOD_HOME: join(work, "install-home") };
const gizmodCli = (args, extra = {}) => spawnSync(process.execPath, [join(repo, "gizmod.mjs"), ...args], { env: { ...installEnv, ...extra }, encoding: "utf8" });
const agent = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
await check("gizmod install: a launchd agent under a test label starts gizmod; uninstall removes it", async () => {
  const installed = gizmodCli(["install", "--vault", installVault, "--label", label]);
  const running = await until(() => spawnSync("launchctl", ["print", `gui/${userInfo().uid}/${label}`], { encoding: "utf8" }).stdout.includes("state = running"), 10000);
  const status = await until(() => {
    const r = gizmodCli(["status"], { GIZMOD_PORT: "7468" });
    return r.status === 0 && r.stdout;
  }, 15000);
  const script = readFileSync(join(work, "install-home", `${label}.sh`), "utf8");
  gizmodCli(["uninstall", "--label", label]);
  const gone = !existsSync(agent) && !spawnSync("launchctl", ["print", `gui/${userInfo().uid}/${label}`], { encoding: "utf8" }).stdout.includes("state = running");
  rmSync(join(homedir(), "Library/Logs", `${label}.log`), { force: true });
  expect(installed.status === 0 && running && status && gone && !/OP_SERVICE_ACCOUNT_TOKEN=[^"$]/.test(script), { installed: installed.stdout + installed.stderr, running, status, gone });
  return "installed, answered status, removed";
});
// Whatever happened above, nothing of the test label is left behind.
spawnSync("launchctl", ["bootout", `gui/${userInfo().uid}/${label}`]);
rmSync(agent, { force: true });
stub.close();
web.close();

for (const r of results) console.log(`${r.status}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
