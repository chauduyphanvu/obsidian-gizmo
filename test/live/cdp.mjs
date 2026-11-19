// Drives an isolated Obsidian started with --remote-debugging-port, without touching the user's window.
//   node test/live/cdp.mjs eval '<js expression>'
//   node test/live/cdp.mjs shot <file.png> [width height]
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9333";

async function target() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith("app://obsidian.md"));
  if (!page) throw new Error("no Obsidian page target");
  return page.webSocketDebuggerUrl;
}

async function session() {
  const ws = new WebSocket(await target());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

const [cmd, ...args] = process.argv.slice(2);
const s = await session();
try {
  if (cmd === "eval") {
    const res = await s.send("Runtime.evaluate", { expression: args[0], awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
      console.error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(res.result?.result?.value, null, 2));
    }
  } else if (cmd === "shot") {
    const [file, width, height] = args;
    if (width) {
      await s.send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: false });
      await new Promise((r) => setTimeout(r, 600));
    }
    const res = await s.send("Page.captureScreenshot", { format: "png" });
    if (width) await s.send("Emulation.clearDeviceMetricsOverride");
    writeFileSync(file, Buffer.from(res.result.data, "base64"));
    console.log(file);
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
} finally {
  s.close();
}
