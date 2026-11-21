// Starts an isolated Obsidian on a copy of a vault: its own user-data dir and vault inside the
// work dir, its own CDP port. `quit` stops only that instance, found by its user-data dir. It never
// takes focus or covers other windows: see the end of `launch`.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VAULT_ID = "c3d4e5f607182930";

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
  /** Stops only the instance this launch started, found by its own user-data dir. */
  const quit = () => {
    const pids = spawnSync("pgrep", ["-f", `user-data-dir=${userData}`]).stdout.toString().trim().split("\n").filter(Boolean);
    if (pids.length) spawnSync("kill", pids);
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
