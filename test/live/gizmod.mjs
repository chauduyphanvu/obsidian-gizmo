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
    if (req.url === "/ntfy" && req.method === "POST") pushes.push({ body, title: req.headers.title });
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
  } });
  const vault = a.vault;
  const ta = await tools(a.page, join(work, "shots"), "obsidian", results);
  const keys = await ta.run(`
    await na.open("Apps/Pulse");
    await na.open("Apps/Errands");
    await na.open("Apps/Pills");
    await na.open("Apps/Vitamins");
    const pack = na.plugin().background.captureIndex().names.get("pack");
    await na.open(pack.path.replace(/\\.md$/, ""));
    const link = na.plugin().linkKey("Apps/Errands.md", "add", true);
    const capture = await na.plugin().newCaptureKey([pack]);
    await na.sleep(1500);
    return { link, capture, pack: pack.path };`);
  a.page.close();
  a.quit();
  a = undefined;
  await sleep(1500);

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

  await check("gizmod: a rhythm missed by its deadline is pushed; one whose row came in time isn't", async () => {
    const took = cli("run", "Vitamins", "took");
    const wait = due.getTime() + 90_000 - Date.now();
    const pushed = await until(() => pushes.find((p) => p.body.startsWith("Pills")), Math.max(wait, 1000));
    // The miss is a row in Pills' data: in gizmod's log at once, in the note at its next snapshot (5 s).
    const note = () => (existsSync(join(vault, "Apps/Pills data.md")) ? readFileSync(join(vault, "Apps/Pills data.md"), "utf8") : "");
    const missed = (await until(() => note().includes("expect_missed") && note(), 15000)) || note();
    const vitamins = pushes.filter((p) => p.body.startsWith("Vitamins"));
    expect(took.code === 0 && pushed?.body === `Pills: nothing by ${by}` && vitamins.length === 0 && missed.includes("expect_missed"), { took, pushes, missed, log: log.slice(-800) });
    return `pushed “${pushed.body}”; Vitamins quiet`;
  });

  b = await launch({ repo, dir: join(work, "b"), port: port + 1, vault });
  const tb = await tools(b.page, join(work, "shots"), "obsidian again", results);
  await check("gizmod: Obsidian opening the folder shows gizmod's rows, names gizmod as the runner, and doesn't tell Pulse's alert again", async () => {
    const seen = await tb.run(`
      const p = na.plugin();
      await na.until(() => p.beat?.runner, 8000);
      await p.beat.beat(true);
      await na.open("Apps/Errands");
      const shown = await na.until(() => na.text().includes("milk") && na.text().includes("bread") && na.text(), 10000);
      await na.sleep(3000);
      return { runner: p.beat.runner?.name, here: p.beat.isRunner(), gizmodHere: p.beat.gizmodHere(), shown: !!shown, notices: na.notices.filter((n) => n.startsWith("Pulse")) };`);
    expect(seen.runner === "gizmod" && !seen.here && seen.gizmodHere && seen.shown && seen.notices.length === 0, seen);
    await tb.shot("gizmod-errands.png");
    return `runner: ${seen.runner}; errands from gizmod shown; no Pulse notice here`;
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
