// Drives an isolated Obsidian started with --remote-debugging-port, without touching the user's window.
//   NOTE_APPS_TEST_VAULT=<vault path> node test/live/cdp.mjs eval '<js expression>'
//   NOTE_APPS_TEST_VAULT=<vault path> node test/live/cdp.mjs shot <file.png> [width height]
// Refuses to act unless the instance on CDP_PORT has exactly that vault open, so it can never
// drive a real vault by mistake.
import { realpathSync, writeFileSync } from "node:fs";

async function pageSocket(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith("app://obsidian.md"));
  if (!page) throw new Error("no Obsidian page target");
  return page.webSocketDebuggerUrl;
}

export async function connect(port, vault) {
  if (!vault) throw new Error("set NOTE_APPS_TEST_VAULT to the isolated test vault's path");
  const ws = new WebSocket(await pageSocket(port));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
  };
  /** Calls `cb` with the params of every CDP event of this name; returns a function that stops it. */
  const on = (method, cb) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(cb);
    return () => listeners.get(method).delete(cb);
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const ex = res.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? ex.text);
    return res.result?.result?.value;
  };
  const open = await evaluate("app.vault.adapter.basePath").catch(() => undefined);
  if (typeof open !== "string" || realpathSync(open) !== realpathSync(vault)) {
    ws.close();
    throw new Error(`refusing: the instance on port ${port} has ${open ?? "no vault"} open, not ${vault}`);
  }
  const shot = async (file, width, height, scale = 2) => {
    if (width) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
      await new Promise((r) => setTimeout(r, 600));
    }
    const res = await send("Page.captureScreenshot", { format: "png" });
    if (width) await send("Emulation.clearDeviceMetricsOverride");
    writeFileSync(file, Buffer.from(res.result.data, "base64"));
    return file;
  };
  return { evaluate, shot, send, on, close: () => ws.close() };
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const page = await connect(process.env.CDP_PORT ?? "9333", process.env.NOTE_APPS_TEST_VAULT);
  try {
    if (cmd === "eval") console.log(JSON.stringify(await page.evaluate(args[0]), null, 2));
    else if (cmd === "shot") console.log(await page.shot(args[0], Number(args[1]) || 0, Number(args[2]) || 0));
    else throw new Error(`unknown command ${cmd}`);
  } finally {
    page.close();
  }
}
