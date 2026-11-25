/**
 * gizmod: Gizmo's background work without Obsidian open. It reads the vault folder, runs records,
 * alerts and their thens as the device that runs background work, pushes alerts to a phone through
 * ntfy, and answers shortcuts over HTTP on this computer and its Tailscale address.
 *
 *   node gizmod.mjs serve --vault <path> [--port 7468]
 *   node gizmod.mjs run <app> <shortcut> [field=value …]    (and get, do "<line>", dry, status)
 *   node gizmod.mjs install --vault <path> [--label com.gizmo.gizmod] | uninstall [--label …]
 *
 * State lives in ~/.config/gizmod (GIZMOD_HOME): this vault's device id, the admin token the
 * command line uses, which is taken only from this computer, and the tokens of the buttons pushed
 * with missed rhythms. Secrets come from the environment (GIZMO_SECRET_<ID>), which run.sh fills
 * through `op run`, never from a file.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { AlertNotice, Background } from "../../src/background.ts";
import { dryLines, type ShortcutResult } from "../../src/background-shortcuts.ts";
import { parseLine, swallowed } from "../../src/capture.ts";
import { captureCovers } from "../../src/links.ts";
import { captureNamesOf } from "../../src/stored.ts";
import { gizmodEnv } from "./host.ts";
import { isPlainObject } from "../../src/keys.ts";

const run = promisify(execFile);
export const DEFAULT_PORT = 7468;
export const DEFAULT_LABEL = "com.gizmo.gizmod";
const ADDRESS_EVERY_MS = 5 * 60_000;
const MAX_BODY = 64 * 1024;

const homeDir = () => process.env.GIZMOD_HOME ?? join(homedir(), ".config", "gizmod");
const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
// A command line program: what it says goes to standard output.
const print = (line: string) => void process.stdout.write(`${line}\n`);
const say = (line: string) => print(`${stamp()} ${line}`);

/** This vault's gizmod id, made once and kept, so its ledger files and beat stay its own. */
async function deviceId(home: string, vault: string): Promise<string> {
  const path = join(home, "devices.json");
  const kept = existsSync(path) ? (JSON.parse(await fs.readFile(path, "utf8")) as Record<string, string>) : {};
  if (kept[vault]) return kept[vault];
  kept[vault] = `gz${randomBytes(4).toString("hex").slice(0, 6)}`;
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path, JSON.stringify(kept, null, 2));
  return kept[vault];
}

/** The command line's token: made once, readable only by this user. */
export async function adminToken(home = homeDir()): Promise<string> {
  const path = join(home, "token");
  if (existsSync(path)) return (await fs.readFile(path, "utf8")).trim();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("hex");
  await fs.writeFile(path, token, { mode: 0o600 });
  return token;
}

/** How long a pushed button answers. */
export const ANSWER_MS = 24 * 3_600_000;

/**
 * What a pushed button runs: the shortcut its capture line reached when it was pushed, by the app's
 * path, with the line's values; and the rhythm's window it answers, by the rule's app and id.
 */
export interface Answer {
  line: string;
  path: string;
  shortcut: string;
  params: Record<string, string>;
  window?: { app: string; rule: string; start: number; deadline: number };
}


/** A kept answer as the file holds it; undefined for anything else, such as a file from before or one cut short. */
function answerOf(v: unknown): { answer: Answer; until: number } | undefined {
  if (!isPlainObject(v) || typeof v.until !== "number" || !isPlainObject(v.answer)) return undefined;
  const a = v.answer;
  if (typeof a.line !== "string" || typeof a.path !== "string" || typeof a.shortcut !== "string" || !isPlainObject(a.params) || !Object.values(a.params).every((x) => typeof x === "string")) return undefined;
  return { answer: a as unknown as Answer, until: v.until };
}

/**
 * The tokens pushed buttons carry, each good for one answer (see Answer), once, within ANSWER_MS.
 * The push goes through the ntfy server, so a token is never a key: it runs its own shortcut and
 * nothing else. Kept in GIZMOD_HOME as hashes, so the file alone answers nothing; one read or write
 * at a time, each write whole (a file that can't be read is read as none).
 */
export class AnswerTokens {
  private path: string;
  private now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(home: string, now: () => number = Date.now) {
    this.path = join(home, "answers.json");
    this.now = now;
  }

  /** A new token for `answer`. */
  mint(answer: Answer): Promise<string> {
    return this.change((kept) => {
      const token = randomBytes(24).toString("hex");
      kept[hashOf(token)] = { answer, until: this.now() + ANSWER_MS };
      return token;
    });
  }

  /** What a token was made for, leaving it there; undefined for one used, too old, or never made. */
  peek(token: string): Promise<Answer | undefined> {
    return this.change((kept) => kept[hashOf(token)]?.answer, false);
  }

  /** What a token was made for, forgotten as it is given; undefined for one used, too old, or never made. */
  take(token: string): Promise<Answer | undefined> {
    return this.change((kept) => {
      const key = hashOf(token);
      const answer = kept[key]?.answer;
      delete kept[key];
      return answer;
    });
  }

  /** Reads the tokens kept, drops those too old or unreadable, changes them with `fn` and, with `write`, writes them back whole. */
  private change<T>(fn: (kept: Record<string, { answer: Answer; until: number }>) => T, write = true): Promise<T> {
    const run = this.queue.then(async () => {
      let read: unknown;
      try {
        read = existsSync(this.path) ? JSON.parse(await fs.readFile(this.path, "utf8")) : {};
      } catch {
        read = {};
      }
      const kept: Record<string, { answer: Answer; until: number }> = {};
      for (const [k, v] of Object.entries(isPlainObject(read) ? read : {})) {
        const a = answerOf(v);
        if (a && a.until > this.now()) kept[k] = a;
      }
      const out = fn(kept);
      if (!write) return out;
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const part = `${this.path}.${process.pid}.part`;
      await fs.writeFile(part, JSON.stringify(kept), { mode: 0o600 });
      await fs.rename(part, this.path);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** This computer's Tailscale address, or undefined when Tailscale isn't running here. */
async function tailscaleIp(): Promise<string | undefined> {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const { stdout } = await run(bin, ["ip", "-4"], { timeout: 5000 });
      const ip = stdout.trim().split("\n")[0];
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch {
      // Not installed there, or not running.
    }
  }
  return undefined;
}

/** Whether two keys are the same, in time that doesn't tell how much of one matched. */
function sameKey(expected: string, given: string): boolean {
  return timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(given).digest());
}

/**
 * Whether a request's Host header names gizmod itself: this computer, an address it listens on, or
 * this computer's name on the tailnet, short (`mac`) or whole (`mac.tail1234.ts.net`), at its port.
 * A web page can point only a name with a dot in it, of a domain of its own, at this computer, and
 * no `.ts.net` name. A request with no Host (not from a browser) is answered.
 */
export function ownHost(header: string | undefined, addresses: readonly string[], port: number): boolean {
  if (header === undefined) return true;
  const host = header.toLowerCase().replace(new RegExp(`:${port}$`), "");
  return ["127.0.0.1", "[::1]", ...addresses].includes(host) || /^[a-z0-9-]+$/.test(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host);
}

const isLoopback = (address: string | undefined) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "the request is too big");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body must be JSON: an object of field values");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "the body must be an object of field values");
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A run's result as an HTTP status: refused when it wasn't allowed, unprocessable when it couldn't run. */
function statusOf(r: ShortcutResult): number {
  if (r.ok) return 200;
  return /wasn't allowed|allow it|data policy/.test(r.error ?? "") ? 403 : 422;
}

export interface Served {
  bg: Background;
  env: ReturnType<typeof gizmodEnv>;
  /** Answers one request; the servers call it, and tests may too. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Where it listens, once listening. */
  addresses(): string[];
  close(): Promise<void>;
}

export interface ServeOptions {
  vault: string;
  port?: number;
  home?: string;
  ntfyUrl?: string;
  macNotices?: boolean;
  /** Listen on the Tailscale address too (checked again every five minutes). */
  tailscale?: boolean;
  /** Finds this computer's Tailscale address, where a phone reaches gizmod; tests give their own. */
  tailscaleAddress?: () => Promise<string | undefined>;
  /** Listen at all; tests may call `handle` instead. */
  listen?: boolean;
  log?: (line: string) => void;
}

export async function serve(opts: ServeOptions): Promise<Served> {
  const log = opts.log ?? say;
  const home = opts.home ?? homeDir();
  const vaultPath = resolve(opts.vault);
  const id = await deviceId(home, vaultPath);
  const token = await adminToken(home);
  const port = opts.port ?? DEFAULT_PORT;
  const answers = new AnswerTokens(home);
  const findTailnet = opts.tailscale === false ? async () => undefined : opts.tailscaleAddress ?? tailscaleIp;
  // Looked up at once, so a miss pushed as gizmod starts can carry its button.
  let tailnet = findTailnet();
  // A pushed miss's button: ntfy's phone app POSTs to gizmod's Tailscale address with a token for
  // the shortcut its line reaches now.
  const answerButton = async (notice: AlertNotice) => {
    const ip = await tailnet;
    const parsed = ip && notice.answer ? parseLine(notice.answer, bg.captureIndex(), new Date()) : undefined;
    if (!parsed?.ok) return undefined;
    const token = await answers.mint({ line: notice.answer!, path: parsed.target.path, shortcut: parsed.target.shortcut, params: parsed.params ?? {}, ...(notice.window && { window: notice.window }) });
    return `http, Done, http://${ip}:${port}/answer/${token}, method=POST, clear=true`;
  };
  const env = gizmodEnv({ vault: vaultPath, device: id, ntfyUrl: opts.ntfyUrl, macNotices: opts.macNotices, log, answerButton });
  const { runtime } = env;
  const bg = runtime.background;
  await env.vault.scan();
  env.vault.onChange((path, gone) => {
    if (gone) runtime.fileDeleted(path);
    else runtime.fileChanged(path);
  });
  env.vault.watch();
  await runtime.open();
  await runtime.start();
  log(`gizmod ${id} reads ${vaultPath}; ${runtime.beat.isRunner() ? "it runs background work" : `${runtime.beat.runner?.name ?? "another device"} runs background work`}`);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      // A web page can point a name of its own at this computer; only gizmod's own addresses are answered.
      if (!ownHost(req.headers.host, [...servers.keys()], port)) throw new HttpError(403, "gizmod answers only at its own address: 127.0.0.1, or this computer's Tailscale address or name");
      const url = new URL(req.url ?? "/", "http://gizmod");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (req.method === "POST" && parts[0] === "answer" && parts.length === 2) {
        // A pushed button: its token is all it carries, good once for the shortcut it was made for,
        // while that app may run and the window it answers still waits.
        const gone = "that button was used already, or is more than a day old";
        const answer = await answers.peek(parts[1]);
        if (!answer) throw new HttpError(410, gone);
        if (!bg.mayRun(answer.path)) throw new HttpError(403, `${answer.path.replace(/^.*\//, "").replace(/\.md$/, "")} isn't allowed to run now; open it in Obsidian`);
        const w = answer.window;
        if (w && (await bg.rhythmMet(w.app, w.rule, w))) {
          await answers.take(parts[1]);
          return reply(409, { ok: false, error: "that was done already; nothing more was logged" });
        }
        if (!(await answers.take(parts[1]))) throw new HttpError(410, gone);
        const r = await bg.runFrom(answer.path, answer.shortcut, { params: answer.params, captureKeyed: true });
        return reply(statusOf(r), { ok: r.ok, error: r.error });
      }
      const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
      // The admin token is the computer's own user: taken only from this computer.
      const trusted = auth !== undefined && sameKey(token, auth) && isLoopback(req.socket.remoteAddress);
      if (!auth) throw new HttpError(401, "a key is needed: the shortcut's link key, a capture key, or on this computer the admin token");
      // Whoever holds no key that runs the shortcut hears one answer, whatever is or isn't there:
      // an app's name, its shortcuts and what a form takes are told only to a key's holder.
      const target = (name: string, shortcut: string) => {
        const found = bg.appFor(name);
        if (trusted) {
          if ("error" in found) throw new HttpError(404, found.error);
          return found.path;
        }
        const expected = "error" in found ? undefined : runtime.linkKey(found.path, shortcut, false);
        if ("error" in found || expected === undefined || !sameKey(expected, auth)) throw new HttpError(403, "that key doesn't run this");
        return found.path;
      };
      if (req.method === "GET" && parts[0] === "status" && parts.length === 1) {
        if (!trusted) throw new HttpError(403, "status is for this computer's own user");
        return reply(200, {
          device: id, vault: vaultPath, runsBackground: runtime.beat.isRunner(), runner: runtime.beat.runner?.name, apps: bg.list().length,
          paused: bg.paused().map((p) => ({ app: p.name, path: p.path, reason: p.reason, since: new Date(p.since).toISOString() })),
        });
      }
      if ((req.method === "POST" && parts[0] === "run") || (req.method === "GET" && parts[0] === "get")) {
        if (parts.length !== 3) throw new HttpError(404, `use /${parts[0]}/<app>/<shortcut>`);
        const params = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
        const r = await bg.runFrom(target(parts[1], parts[2]), parts[2], { params: req.method === "POST" || Object.keys(params).length ? params : undefined, key: trusted ? undefined : auth, trusted });
        return reply(statusOf(r), r);
      }
      if (req.method === "POST" && parts[0] === "dry" && parts.length === 3) {
        const path = target(parts[1], parts[2]);
        return reply(200, { ok: true, lines: dryLines(await bg.dryRun(path, parts[2], await readBody(req))) });
      }
      if (req.method === "POST" && parts[0] === "do" && parts.length === 1) {
        const { line = "" } = await readBody(req);
        if (trusted) {
          const r = await bg.capture(line, "shortcut");
          return reply(r.ok ? 200 : 422, { ok: r.ok, error: r.error, entryId: r.entryId });
        }
        const names = captureNamesOf(runtime.store, auth);
        if (!names) throw new HttpError(403, "that isn't a capture key");
        const parsed = parseLine(line, bg.captureIndex(), new Date());
        if (!parsed.ok) return reply(422, { ok: false, error: parsed.error });
        const { name, path, shortcut } = parsed.target;
        // A key runs only the names it was made for, and only while each still reaches the same shortcut.
        if (!captureCovers(names, parsed.target)) throw new HttpError(403, `that key doesn't cover “${name}”`);
        const guess = swallowed(parsed);
        if (guess) return reply(422, { ok: false, error: guess });
        const r = await bg.runFrom(path, shortcut, { params: parsed.params, captureKeyed: true });
        return reply(statusOf(r), { ok: r.ok, error: r.error, entryId: r.entryId });
      }
      throw new HttpError(404, "no such request: POST /run/<app>/<shortcut>, GET /get/<app>/<shortcut>, POST /do, POST /dry/<app>/<shortcut>, GET /status");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      reply(status, { ok: false, error: (e as Error).message });
    }
  };

  const servers = new Map<string, Server>();
  const listenOn = (address: string) => new Promise<void>((done) => {
    const server = createServer((req, res) => void handle(req, res));
    server.on("error", (e) => {
      log(`couldn't listen on ${address}:${port}: ${e.message}`);
      done();
    });
    server.listen(port, address, () => {
      servers.set(address, server);
      done();
    });
  });
  let addressTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.listen !== false) {
    await listenOn("127.0.0.1");
    const follow = async (ip: string | undefined) => {
      for (const [address, server] of servers) {
        if (address !== "127.0.0.1" && address !== ip) {
          server.close();
          servers.delete(address);
        }
      }
      if (ip && !servers.has(ip)) await listenOn(ip);
      if (!ip && opts.tailscale !== false) log("Tailscale isn't running here: listening on this computer only");
    };
    await follow(await tailnet);
    addressTimer = setInterval(() => void (tailnet = findTailnet()).then(follow), ADDRESS_EVERY_MS);
    log(`listening on ${[...servers.keys()].map((a) => `${a}:${port}`).join(", ")}`);
  }

  return {
    bg,
    env,
    handle,
    addresses: () => [...servers.keys()],
    async close() {
      if (addressTimer) clearInterval(addressTimer);
      // What's waiting is written before the vault is let go of, and gizmod says it's leaving.
      await runtime.quit().catch(() => {});
      runtime.stop();
      env.vault.close();
      await Promise.all([...servers.values()].map((s) => new Promise((r) => s.close(r))));
    },
  };
}

// ---- Installing as a launchd agent ------------------------------------------------------------

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The script launchd runs: secrets through `op run` when a 1Password service account is set up, never in the plist. */
export function runScript(o: { node: string; script: string; vault: string; home: string }): string {
  return `#!/bin/sh
# gizmod for ${o.vault.replace(/\n/g, " ")}. Secrets come from 1Password through op run; none is kept here.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export GIZMOD_HOME=${shellQuote(o.home)}
cd ${shellQuote(o.home)} || exit 1
TOKEN="$(/usr/bin/security find-generic-password -s gizmod-op -w 2>/dev/null)"
if [ -n "$TOKEN" ] && [ -f .env ] && command -v op >/dev/null 2>&1; then
  export OP_SERVICE_ACCOUNT_TOKEN="$TOKEN"
  exec op run --env-file .env -- ${shellQuote(o.node)} ${shellQuote(o.script)} serve --vault ${shellQuote(o.vault)}
fi
exec ${shellQuote(o.node)} ${shellQuote(o.script)} serve --vault ${shellQuote(o.vault)}
`;
}

export function plist(o: { label: string; script: string; log: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(o.label)}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(o.script)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

const agentPath = (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = () => `gui/${userInfo().uid}`;

async function install(vault: string, label: string): Promise<void> {
  const home = homeDir();
  const script = join(home, `${label}.sh`);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(script, runScript({ node: process.execPath, script: fileURLToPath(import.meta.url), vault: resolve(vault), home }), { mode: 0o700 });
  const agent = agentPath(label);
  await fs.mkdir(dirname(agent), { recursive: true });
  await fs.writeFile(agent, plist({ label, script, log: join(homedir(), "Library", "Logs", `${label}.log`) }));
  await run("launchctl", ["bootout", `${domain()}/${label}`]).catch(() => {});
  await run("launchctl", ["bootstrap", domain(), agent]);
  print(`Installed ${label}: it starts now and at each login. Logs: ~/Library/Logs/${label}.log`);
  if (resolve(vault).includes("Mobile Documents")) {
    print(`The vault is in iCloud Drive: give ${process.execPath} access to files in System Settings → Privacy & Security, or gizmod can't read it.`);
  }
}

async function uninstall(label: string): Promise<void> {
  await run("launchctl", ["bootout", `${domain()}/${label}`]).catch(() => {});
  await fs.rm(agentPath(label), { force: true });
  await fs.rm(join(homeDir(), `${label}.sh`), { force: true });
  print(`Removed ${label}.`);
}

// ---- The command line ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const fieldsOf = (args: string[]) => Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));

async function client(method: string, path: string, body?: unknown): Promise<number> {
  const port = Number(process.env.GIZMOD_PORT ?? DEFAULT_PORT);
  const token = readFileSync(join(homeDir(), "token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => undefined);
  if (!res) {
    console.error(`gizmod isn't answering on port ${port}`);
    return 1;
  }
  print(JSON.stringify(await res.json(), null, 2));
  return res.ok ? 0 : 1;
}

export async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  const enc = encodeURIComponent;
  switch (cmd) {
    case "serve": {
      const vault = flag(rest, "vault");
      if (!vault) throw new Error("serve needs --vault <path>");
      const served = await serve({
        vault, port: Number(flag(rest, "port") ?? process.env.GIZMOD_PORT ?? DEFAULT_PORT),
        ntfyUrl: process.env.GIZMOD_NTFY_URL, macNotices: process.env.GIZMOD_MAC_NOTICES !== "0",
      });
      const stop = () => void served.close().then(() => process.exit(0));
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      return new Promise(() => {});
    }
    case "run": return client("POST", `/run/${enc(rest[0])}/${enc(rest[1])}`, fieldsOf(rest.slice(2)));
    case "dry": return client("POST", `/dry/${enc(rest[0])}/${enc(rest[1])}`, fieldsOf(rest.slice(2)));
    case "get": return client("GET", `/get/${enc(rest[0])}/${enc(rest[1])}`);
    case "do": return client("POST", "/do", { line: rest.join(" ") });
    case "status": return client("GET", "/status");
    case "install": {
      const vault = flag(rest, "vault");
      if (!vault) throw new Error("install needs --vault <path>");
      await install(vault, flag(rest, "label") ?? DEFAULT_LABEL);
      return 0;
    }
    case "uninstall":
      await uninstall(flag(rest, "label") ?? DEFAULT_LABEL);
      return 0;
    default:
      print("gizmod serve --vault <path> | run <app> <shortcut> [field=value…] | get <app> <shortcut> | do <line> | dry <app> <shortcut> | status | install --vault <path> [--label L] | uninstall [--label L]");
      return cmd ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code; }, (e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
