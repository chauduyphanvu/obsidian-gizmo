// Starts an isolated Obsidian on a copy of a vault: its own user-data dir and vault inside the
// work dir, its own CDP port. `quit` stops only that instance, found by its user-data dir. It never
// covers other windows (see the end of `launch`), and it gives the screen back whenever it comes to
// the front (see `guard`).
import { execFile, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VAULT_ID = "c3d4e5f607182930";
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, (err, out) => resolve(err ? "" : out)));
/** Asks the app with this pid, and only it, to hide or unhide, through AppKit; neither makes any app active. */
const appKit = (pid, what) => ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!a.isNil()) a.${what};`];

/**
 * Obsidian makes itself the active app as it starts (open -g notwithstanding), and so can a window it
 * shows later. Each time the frontmost app is this instance, found by its pid's own user-data dir,
 * it is hidden, so macOS hands the front back to the app that had it, then unhidden, which leaves
 * it drawn but inactive. Gives a stop function.
 */
function guard(userData) {
  const ours = new Map();
  const mine = async (pid) => {
    if (!ours.has(pid)) ours.set(pid, (await run("ps", ["-o", "command=", "-p", String(pid)])).includes(`--user-data-dir=${userData} `));
    return ours.get(pid);
  };
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const asn = (await run("lsappinfo", ["front"])).trim();
    const pid = Number((asn ? await run("lsappinfo", ["info", "-only", "pid", asn]) : "").match(/=\s*(\d+)/)?.[1] ?? 0);
    if (pid && (await mine(pid))) {
      await run("osascript", appKit(pid, "hide"));
      await sleep(300);
      await run("osascript", appKit(pid, "unhide"));
    }
    busy = false;
  }, 200);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * `dir` must be a new folder inside the work dir; `fill(vault)` puts the notes in. The built plugin
 * (main.js, manifest.json, styles.css in `repo`) is installed and turned on. With `vault`, a second
 * instance opens that vault (one another launch made) as another device would, with its own user data.
 * With `tz` (an IANA name), that instance runs in that time zone.
 */
export async function launch({ repo, dir, port, fill, vault: shared, tz }) {
  const vault = shared ?? join(dir, "vault");
  const userData = join(dir, "userdata");
  mkdirSync(userData, { recursive: true });
  if (!shared) {
    const pluginDir = join(vault, ".obsidian/plugins/gizmo");
    mkdirSync(vault, { recursive: true });
    fill(vault);
    mkdirSync(pluginDir, { recursive: true });
    for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, f), join(pluginDir, f));
    writeFileSync(join(vault, ".obsidian/community-plugins.json"), '["gizmo"]');
    // Obsidian 1.15 opens Settings in a window of its own, which takes focus as it shows.
    const appJson = join(vault, ".obsidian/app.json");
    const config = existsSync(appJson) ? JSON.parse(readFileSync(appJson, "utf8")) : {};
    writeFileSync(appJson, JSON.stringify({ ...config, settingsPopoutWindow: false }));
  }
  writeFileSync(join(userData, "obsidian.json"), JSON.stringify({
    vaults: { [VAULT_ID]: { path: vault, ts: Date.now(), open: true } },
  }));
  // The window shows for a moment before the harness can hide it: at Obsidian's smallest size, in
  // the top-left corner (macOS moves a new window onto the screen wherever it's asked to open).
  writeFileSync(join(userData, `${VAULT_ID}.json`), JSON.stringify({ x: 0, y: 0, width: 300, height: 200, isMaximized: false, devTools: false, zoom: 0 }));

  // The window sits in the background, where Chromium would otherwise slow timers to about one
  // wake-up a minute after five minutes and stretch every wait in a run.
  spawn("open", ["-g", "-n", ...(tz ? ["--env", `TZ=${tz}`] : []), "-a", "Obsidian", "--args", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`,
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]);
  const unguard = guard(userData);
  /** Stops only the instance this launch started, found by its own user-data dir. */
  const quit = () => {
    unguard();
    const pids = (pattern) => spawnSync("pgrep", ["-f", pattern]).stdout.toString().trim().split("\n").filter(Boolean);
    // Hidden first, it closes as an inactive app: nothing of it shows, and macOS brings nothing forward in its place.
    const main = pids(`MacOS/Obsidian --user-data-dir=${userData} `);
    for (const pid of main) spawnSync("osascript", appKit(pid, "hide"));
    if (main.length) spawnSync("sleep", ["0.3"]);
    const all = pids(`user-data-dir=${userData}`);
    if (all.length) spawnSync("kill", all);
  };
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(1000);
    page = await connect(port, vault).catch(() => undefined);
  }
  if (!page) {
    quit();
    throw new Error(`the test Obsidian did not come up on port ${port} (is another instance using it?)`);
  }
  // The window is in the background; without this, focus and :focus-within never apply in it.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Out of sight and out of the way: see-through, clicks pass through it, at the size the checks
  // expect, pushed against a corner. Chromium still draws it, so screenshots and events work.
  await page.evaluate(`(() => {
    const w = electron.remote.getCurrentWindow();
    w.setOpacity(0);
    w.setIgnoreMouseEvents(true);
    w.setBounds({ x: -10000, y: 10000, width: 1024, height: 800 });
  })()`);
  await sleep(300);
  return { page, vault, quit };
}
