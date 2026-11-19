// Starts an isolated Obsidian on a copy of a vault: its own user-data dir and vault inside the
// work dir, its own CDP port. `quit` stops only that instance, found by its user-data dir.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `dir` must be a new folder inside the work dir; `fill(vault)` puts the notes in. The built plugin
 * (main.js, manifest.json, styles.css in `repo`) is installed and turned on.
 */
export async function launch({ repo, dir, port, fill }) {
  const vault = join(dir, "vault");
  const userData = join(dir, "userdata");
  const pluginDir = join(vault, ".obsidian/plugins/gizmo");
  mkdirSync(vault, { recursive: true });
  mkdirSync(userData, { recursive: true });
  fill(vault);
  mkdirSync(pluginDir, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, f), join(pluginDir, f));
  writeFileSync(join(vault, ".obsidian/community-plugins.json"), '["gizmo"]');
  writeFileSync(join(userData, "obsidian.json"), JSON.stringify({
    vaults: { c3d4e5f607182930: { path: vault, ts: Date.now(), open: true } },
  }));

  // The window sits in the background, where Chromium would otherwise slow timers to about one
  // wake-up a minute after five minutes and stretch every wait in a run.
  spawn("open", ["-g", "-n", "-a", "Obsidian", "--args", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`,
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
  return { page, vault, quit };
}
