import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { stringify } from "yaml";
import { ANSWER_MS, AnswerTokens, adminToken, plist, runScript, serve } from "../src/node/gizmod.ts";
import { gizmodEnv, pushText, secretFromEnv } from "../src/node/host.ts";
import { Background } from "../src/background.ts";
import { identityText, kindKeys, newIdentity } from "../src/share-crypto.ts";
import { NodeVault, inlineTags, splitNote } from "../src/node/vault.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { PRIORITY, readBeat, runnerOf } from "../src/device.ts";
import { stampOf } from "../src/time.ts";

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A vault folder on disk: notes as frontmatter and body, any other file as text. */
function vaultDir(files: Record<string, string | { fm: Record<string, unknown>; body?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "gizmod-"));
  made.push(root);
  for (const [path, f] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof f === "string" ? f : `---\n${stringify(f.fm)}---\n${f.body ?? ""}`);
  }
  return root;
}

test("the vault reads frontmatter as Obsidian does: a block YAML can't read is dropped whole, tags come from it and the body", async () => {
  const root = vaultDir({
    "A.md": "---\ntitle: A\ntags: [x, \"#y\", 2026, \"a b\"]\n---\nSee #inline and #2026 and `#code`\n```\n#fenced\n```\n#nested/tag-1 end",
    "B.md": "---\ntags: one, two\ntag: old\n---\n",
    "C.md": "---\ntags: single\n---\n",
    "Broken.md": "---\ntitle: [unclosed\n---\nbody",
    "Plain.md": "No frontmatter #here",
    ".hidden/Secret.md": "---\nx: 1\n---\n",
    ".obsidian/plugins/gizmo/data.json": "{}",
    "Apps/Data/log/d1-2026-11.jsonl": "{}\n",
  });
  const v = new NodeVault(root);
  await v.scan();
  assert.deepEqual(v.file("A.md")?.fm, { title: "A", tags: ["x", "#y", 2026, "a b"] });
  assert.deepEqual([v.file("B.md")?.tags, v.file("C.md")?.tags], [[], ["#single"]], "only tags:, and a string is one tag");
  assert.deepEqual(v.file("A.md")?.tags, ["#x", "#y", "#inline", "#nested/tag-1"]);
  assert.equal(v.file("Broken.md")?.fm, undefined);
  assert.deepEqual(v.file("Plain.md")?.tags, ["#here"]);
  assert.equal(v.file(".hidden/Secret.md"), undefined, "dot folders and the config folder aren't the vault's");
  assert.deepEqual(v.notes().map((n) => n.path).sort(), ["A.md", "B.md", "Broken.md", "C.md", "Plain.md"]);
  assert.deepEqual(v.filesIn("Apps/Data/log"), ["Apps/Data/log/d1-2026-11.jsonl"]);
  assert.deepEqual(splitNote("---\na: 1\n---\nbody"), { yaml: "a: 1", body: "body" });
  assert.deepEqual(inlineTags("a#notatag #ok"), ["#ok"]);
});

test("links resolve as Obsidian resolves them: a path, then a name from the linking note's folder, else the shortest path, case aside", async () => {
  const root = vaultDir({ "Inbox.md": "", "Apps/Inbox.md": "", "Apps/Deep/Inbox.md": "", "Apps/Budget.md": "", "Apps/Errands.md": "", "Notes/x.md": "", "Projects/Plan.md": "", "Lists/Errands.md": "" });
  const v = new NodeVault(root);
  await v.scan();
  assert.equal(v.resolve("Apps/Inbox", ""), "Apps/Inbox.md");
  // A path is a path whatever its case, and wins over a note of that name in the linking note's folder.
  assert.equal(v.resolve("inbox", "Apps/Budget.md"), "Inbox.md");
  assert.equal(v.resolve("Inbox", "Notes/x.md"), "Inbox.md");
  assert.equal(v.resolve("Errands", "Apps/Budget.md"), "Apps/Errands.md");
  assert.equal(v.resolve("errands", "Notes/x.md"), "Apps/Errands.md");
  assert.equal(v.resolve("deep/inbox", "Notes/x.md"), "Apps/Deep/Inbox.md");
  assert.equal(v.resolve("plan", "Notes/x.md"), "Projects/Plan.md");
  assert.equal(v.resolve("Nope", "Notes/x.md"), undefined);
});

test("a folder renamed while gizmod watches is read under its new name, and its old notes go", async () => {
  const root = vaultDir({ "Apps/Mood.md": "---\napp: Mood\n---\n", "Apps/Deep/Inbox.md": "x" });
  const v = new NodeVault(root);
  await v.scan();
  const told: string[] = [];
  v.onChange((path, gone) => told.push(`${gone ? "-" : "+"}${path}`));
  v.watch();
  try {
    // macOS starts watching a moment after watch() returns, a second or more on a busy machine,
    // and misses what changes before: a note written again until it is seen says the watcher is on.
    for (let i = 0; i < 100 && !v.file("Ready.md"); i++) {
      writeFileSync(join(root, "Ready.md"), `${i}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const { renameSync } = await import("node:fs");
    renameSync(join(root, "Apps"), join(root, "Tools"));
    // The rename is taken in a note at a time: on Linux the old and new notes come and go a few
    // milliseconds apart, and later when the machine is busy.
    const notes = () => v.notes().map((n) => n.path).sort();
    const expected = ["Ready.md", "Tools/Deep/Inbox.md", "Tools/Mood.md"];
    for (let i = 0; i < 200 && notes().join() !== expected.join(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(notes(), expected);
    assert.ok(told.includes("-Apps/Mood.md") && told.includes("+Tools/Mood.md"), told.join(" "));
  } finally {
    v.close();
  }
});

test("a frontmatter write keeps the body and is read back at once", async () => {
  const root = vaultDir({ "Apps/X data.md": "---\nn: 1\n---\nKeep me\n" });
  const v = new NodeVault(root);
  await v.scan();
  await v.process("Apps/X data.md", (fm) => { fm.n = 2; fm.list = [{ a: "b" }]; });
  assert.equal(readFileSync(join(root, "Apps/X data.md"), "utf8"), "---\nn: 2\nlist:\n  - a: b\n---\nKeep me\n");
  assert.deepEqual(v.file("Apps/X data.md")?.fm, { n: 2, list: [{ a: "b" }] });
});

const INBOX = { app: "Inbox", panels: [{ view: "form", title: "Add", fields: { task: "text" }, save: "todo", shortcut: "add", alias: "task" }, { view: "number", title: "Open", source: "todo", agg: "count", shortcut: "open" }] };
const LINK_KEY = "k".repeat(32);
const CAPTURE_KEY = "c".repeat(32);

/** A vault with Inbox allowed in Obsidian, its link keys and a capture key in data.json, and gizmod serving it without listening. */
async function served(settings: Record<string, unknown> = {}, inbox: Record<string, unknown> = INBOX) {
  const wanted = permissionsOf(readSpec(inbox, { path: "Apps/Inbox.md" })!.spec!, "Apps/Inbox.md");
  const root = vaultDir({
    "Apps/Inbox.md": { fm: inbox },
    ".obsidian/plugins/gizmo/data.json": JSON.stringify({
      grants: { "Apps/Inbox.md": wanted },
      linkKeys: { "Apps/Inbox.md#add": LINK_KEY, "Apps/Inbox.md#open": LINK_KEY },
      captureKeys: { [CAPTURE_KEY]: { task: "Apps/Inbox.md#add" } },
      ...settings,
    }),
  });
  const home = mkdtempSync(join(tmpdir(), "gizmod-home-"));
  made.push(home);
  const lines: string[] = [];
  const s = await serve({ vault: root, home, listen: false, log: (l) => lines.push(l) });
  const token = await adminToken(home);
  /** One request, as the server would hand it over. */
  const ask = async (method: string, url: string, opts: { auth?: string; body?: unknown; from?: string } = {}) => {
    const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const req = {
      method, url, headers: opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}, socket: { remoteAddress: opts.from ?? "127.0.0.1" },
      async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text); },
    } as unknown as IncomingMessage;
    let status = 0;
    let out = "";
    const res = { writeHead: (st: number) => { status = st; }, end: (t: string) => { out = t; } } as unknown as ServerResponse;
    await s.handle(req, res);
    return { status, body: JSON.parse(out) as Record<string, unknown> };
  };
  const rows = async () => (await s.env.data.ledger!.state("Apps/Inbox data.md")).lists.get("todo")?.rows.map((r) => r.task) ?? [];
  return { s, root, home, token, ask, rows, lines };
}

test("gizmod refuses every write to the policy note, whatever case its path is written in", async () => {
  const t = await served();
  try {
    for (const path of ["Gizmo policy.md", "gizmo POLICY.md"]) {
      await assert.rejects(async () => t.s.env.io.appendLine(path, "- x"), /your Gizmo policy/, path);
      await assert.rejects(async () => t.s.env.io.writeFrontmatter(path, (fm) => { fm.labels = []; }), /your Gizmo policy/, path);
    }
  } finally {
    await t.s.close();
  }
});

test("gizmod pushes an app paused since before it started, once its pause has lasted ten minutes, and lists it in its status", async () => {
  const pushes: string[] = [];
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { pushes.push(body); res.end("ok"); });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const root = vaultDir({
    "Apps/Pause.md": { fm: { app: "Pause", panels: [{ view: "button", label: "Did it", save: "done" }, { view: "number", title: "P", source: "https://example.com/x", pick: "v" }] } },
    // Allowed in Obsidian when it asked for nothing; its weather panel came later.
    ".obsidian/plugins/gizmo/data.json": JSON.stringify({ grants: { "Apps/Pause.md": [] } }),
    ".obsidian/plugins/gizmo/triggers/gzpause1.json": JSON.stringify({ v: 2, fired: { "Apps/Pause.md\npaused:": { paused: Date.now() - 11 * 60_000, reason: "now asks to fetch data from example.com" } } }),
  });
  const home = mkdtempSync(join(tmpdir(), "gizmod-home-"));
  made.push(home);
  writeFileSync(join(home, "devices.json"), JSON.stringify({ [resolve(root)]: "gzpause1" }));
  const s = await serve({ vault: root, home, listen: false, log: () => {}, ntfyUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}/ntfy` });
  try {
    for (let i = 0; i < 20 && !pushes.length; i++) await new Promise((r) => setTimeout(r, 50));
    await s.bg.tick();
    assert.deepEqual(pushes, ["Pause: paused in the background"]);
    assert.deepEqual(s.bg.paused().map((p) => [p.name, p.reason]), [["Pause", "now asks to fetch data from example.com"]]);
  } finally {
    await s.close();
    stub.close();
  }
});

test("over HTTP a shortcut runs only with its link key; a request without a key, or with another, writes nothing", async () => {
  const t = await served();
  try {
    assert.equal((await t.ask("POST", "/run/Inbox/add", { body: { task: "bins" } })).status, 401);
    const wrong = await t.ask("POST", "/run/Inbox/add", { auth: "x".repeat(32), body: { task: "bins" } });
    assert.equal(wrong.status, 403);
    assert.deepEqual(await t.rows(), []);
    const ok = await t.ask("POST", "/run/Inbox/add", { auth: LINK_KEY, body: { task: "bins" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await t.rows(), ["bins"]);
    // The ledger file is gizmod's own.
    const logs = readdirSync(join(t.root, "Apps/Inbox data/log"));
    assert.ok(logs.length === 1 && logs[0].startsWith("gz"), logs.join(", "));
    const answer = await t.ask("GET", "/get/Inbox/open", { auth: LINK_KEY });
    assert.deepEqual([answer.status, answer.body.value, answer.body.shown], [200, 1, "1"]);
    assert.equal((await t.ask("GET", "/get/Nowhere/open", { auth: LINK_KEY })).status, 404);
  } finally {
    await t.s.close();
  }
});

test("a capture key's line whose text took the rest of it, with fields after it, is refused rather than guessed: nothing shows first what it saves", async () => {
  const inbox = { ...INBOX, panels: [{ ...INBOX.panels[0], fields: { task: "text", mins: "number" } }, INBOX.panels[1]] };
  const t = await served({}, inbox);
  try {
    const guessed = await t.ask("POST", "/do", { auth: CAPTURE_KEY, body: { line: "task call mom" } });
    assert.deepEqual([guessed.status, guessed.body.error], [422, "“call mom” would all go in task; put it in quotes, or give mins=… by name"]);
    assert.deepEqual(await t.rows(), []);
    assert.equal((await t.ask("POST", "/do", { auth: CAPTURE_KEY, body: { line: 'task "call mom"' } })).status, 200);
    assert.equal((await t.ask("POST", "/do", { auth: CAPTURE_KEY, body: { line: "task call 10" } })).status, 200);
    assert.deepEqual(await t.rows(), ["call mom", "call"]);
  } finally {
    await t.s.close();
  }
});

test("a capture key runs only the names it was made for; the admin token works only from this computer", async () => {
  const t = await served();
  try {
    const done = await t.ask("POST", "/do", { auth: CAPTURE_KEY, body: { line: "task call mom" } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(await t.rows(), ["call mom"]);
    assert.equal((await t.ask("POST", "/do", { auth: LINK_KEY, body: { line: "task x" } })).status, 403, "a link key isn't a capture key");
    assert.equal((await t.ask("GET", "/status", { auth: t.token, from: "100.101.102.103" })).status, 403);
    const status = await t.ask("GET", "/status", { auth: t.token });
    assert.deepEqual([status.status, status.body.runsBackground, status.body.apps], [200, true, 1]);
    const dry = await t.ask("POST", "/dry/Inbox/add", { auth: t.token, body: { task: "x" } });
    assert.equal(dry.status, 200);
    assert.ok((dry.body.lines as string[]).some((l) => l.includes("x")), JSON.stringify(dry.body));
    assert.deepEqual(await t.rows(), ["call mom"], "a dry run writes nothing");
    const run = await t.ask("POST", "/run/Inbox/add", { auth: t.token, body: { task: "admin" } });
    assert.equal(run.status, 200);
    assert.equal((await t.ask("POST", "/run/Inbox/add", { auth: t.token, from: "100.101.102.103", body: { task: "far" } })).status, 403, "the admin token from afar is just a wrong key");
    assert.deepEqual(await t.rows(), ["call mom", "admin"]);
  } finally {
    await t.s.close();
  }
});

test("an app not allowed in Obsidian doesn't run under gizmod, key or not", async () => {
  const t = await served({ grants: {} });
  try {
    const r = await t.ask("POST", "/run/Inbox/add", { auth: LINK_KEY, body: { task: "bins" } });
    assert.equal(r.status, 403);
    assert.match(String(r.body.error), /allow it/);
  } finally {
    await t.s.close();
  }
});

test("a pushed alert says only where it's from, unless the data policy clears its label for the push host", () => {
  const notice = { app: "Meds", panel: "Missed", text: "Meds: Missed (2 rows)", label: "personal" as const };
  assert.equal(pushText(notice, undefined, "ntfy.sh"), "Meds: Missed");
  const policy = { hash: "h", rules: { labels: [], sinks: { "ntfy.sh": "personal" as const }, release: [], typed: "public" as const } };
  assert.equal(pushText(notice, policy, "ntfy.sh"), "Meds: Missed (2 rows)");
  assert.equal(pushText({ ...notice, label: "private" }, policy, "ntfy.sh"), "Meds: Missed");
  assert.equal(pushText(notice, policy, "push.example.com"), "Meds: Missed", "a host the policy doesn't list gets nothing");
});

test("secrets come from the environment; the launchd files hold no secret", () => {
  assert.equal(secretFromEnv("open-meteo", { GIZMO_SECRET_OPEN_METEO: "s3" }), "s3");
  assert.equal(secretFromEnv("x", {}), null);
  const sh = runScript({ node: "/usr/local/bin/node", script: "/x/gizmod.mjs", vault: "/Users/me/My Vault", home: "/Users/me/.config/gizmod" });
  assert.match(sh, /op run --env-file \.env -- '\/usr\/local\/bin\/node' '\/x\/gizmod\.mjs' serve --vault '\/Users\/me\/My Vault'/);
  assert.match(sh, /security find-generic-password -s gizmod-op -w/);
  const p = plist({ label: "com.gizmo.test", script: "/h/com.gizmo.test.sh", log: "/h/gizmod.log" });
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(p, /TOKEN|op:\/\//);
});

test("gizmod reads data.json again when Obsidian changes it", async () => {
  const t = await served({ grants: {} });
  try {
    assert.equal((await t.ask("POST", "/run/Inbox/add", { auth: LINK_KEY, body: { task: "a" } })).status, 403);
    const path = join(t.root, ".obsidian/plugins/gizmo/data.json");
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    data.grants = { "Apps/Inbox.md": permissionsOf(readSpec(INBOX, { path: "Apps/Inbox.md" })!.spec!, "Apps/Inbox.md") };
    const later = new Date(Date.now() + 5000);
    // Caught half-written first: what it read last holds, and it's read again though the time is the same.
    writeFileSync(path, JSON.stringify(data).slice(0, 20));
    utimesSync(path, later, later);
    assert.equal((await t.ask("POST", "/run/Inbox/add", { auth: LINK_KEY, body: { task: "a" } })).status, 403);
    writeFileSync(path, JSON.stringify(data));
    utimesSync(path, later, later);
    assert.equal((await t.ask("POST", "/run/Inbox/add", { auth: LINK_KEY, body: { task: "a" } })).status, 200);
  } finally {
    await t.s.close();
  }
});

test("gizmod stopping writes what's waiting and says it's leaving, so Obsidian takes over at once", async () => {
  const t = await served();
  await t.s.env.beat.beat(true);
  const beatFile = () => readdirSync(join(t.root, ".obsidian/plugins/gizmo/devices")).map((f) => readBeat(readFileSync(join(t.root, ".obsidian/plugins/gizmo/devices", f), "utf8"))!);
  assert.equal(beatFile()[0].left, undefined);
  await t.s.close();
  const [said] = beatFile();
  assert.equal(said.left, true);
  assert.equal(runnerOf([said, { id: "mac", name: "Mac", host: "", priority: PRIORITY.desktop, seen: Date.now() }], Date.now())?.id, "mac");
});

test("a line gizmod adds to a note someone else is writing keeps their edit", async () => {
  const t = await served();
  try {
    const path = join(t.root, "Daily.md");
    writeFileSync(path, "# Today\n");
    await t.s.env.vault.write("Daily.md", "# Today\n");
    // Another program writes the note between gizmod's read and its write.
    const read = t.s.env.vault.read.bind(t.s.env.vault);
    let reads = 0;
    t.s.env.vault.read = async (p: string) => {
      const text = await read(p);
      if (p === "Daily.md" && ++reads === 1) writeFileSync(path, "# Today\nTyped meanwhile\n");
      return text;
    };
    assert.equal(await t.s.env.io.appendLine("Daily.md", "- from gizmod"), false);
    assert.equal(readFileSync(path, "utf8"), "# Today\nTyped meanwhile\n- from gizmod\n");
  } finally {
    await t.s.close();
  }
});

/**
 * Pills, allowed in Obsidian, with a daily rhythm whose deadline passed two minutes ago; gizmod last
 * decided it a day before, so it finds that window missed as it starts, and pushes it to a stub ntfy.
 */
async function missedPills(tailscaleAddress: () => Promise<string | undefined>, before?: (home: string) => void) {
  const pushes: { body: string; title?: string; actions?: string }[] = [];
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      pushes.push({ body, title: req.headers.title as string | undefined, actions: req.headers.actions as string | undefined });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const due = new Date(Date.now() - 2 * 60_000);
  due.setSeconds(0, 0);
  const by = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
  const pills = { app: "Pills", panels: [{ view: "button", label: "Took", save: "doses", shortcut: "took" }], expect: [{ id: "daily", every: "day", by, source: "doses", say: `nothing by ${by}` }] };
  const root = vaultDir({
    "Apps/Pills.md": { fm: pills },
    ".obsidian/plugins/gizmo/data.json": JSON.stringify({ grants: { "Apps/Pills.md": permissionsOf(readSpec(pills, { path: "Apps/Pills.md" })!.spec!, "Apps/Pills.md") } }),
    ".obsidian/plugins/gizmo/triggers/gzpills1.json": JSON.stringify({ v: 2, fired: { "Apps/Pills.md\nexpect:daily": { decided: Date.now() - 23 * 3_600_000 } } }),
  });
  const home = mkdtempSync(join(tmpdir(), "gizmod-home-"));
  made.push(home);
  writeFileSync(join(home, "devices.json"), JSON.stringify({ [resolve(root)]: "gzpills1" }));
  before?.(home);
  const s = await serve({ vault: root, home, listen: false, log: () => {}, tailscaleAddress, ntfyUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}/ntfy` });
  for (let i = 0; i < 40 && !pushes.length; i++) await new Promise((r) => setTimeout(r, 50));
  const post = async (path: string) => {
    const req = { method: "POST", url: path, headers: {}, socket: { remoteAddress: "100.64.0.20" }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage;
    let status = 0;
    let out = "";
    const res = { writeHead: (st: number) => { status = st; }, end: (t: string) => { out = t; } } as unknown as ServerResponse;
    await s.handle(req, res);
    return { status, body: JSON.parse(out) as Record<string, unknown> };
  };
  const doses = async () => (await s.env.data.ledger!.state("Apps/Pills data.md")).lists.get("doses")?.rows ?? [];
  return { s, stub, pushes, due, by, home, post, doses, close: async () => { await s.close(); stub.close(); } };
}

test("a missed rhythm is pushed with a Done button to gizmod's Tailscale address, whose token logs the dose in that window once", async () => {
  const t = await missedPills(async () => "100.64.0.7");
  try {
    assert.equal(t.pushes.length, 1);
    const [push] = t.pushes;
    assert.deepEqual([push.body, push.title], [`Pills: nothing by ${t.by}`, "Gizmo"]);
    const m = /^http, Done, http:\/\/100\.64\.0\.7:7468(\/answer\/([0-9a-f]{48})), method=POST, clear=true$/.exec(push.actions ?? "");
    assert.ok(m, String(push.actions));
    const kept = readFileSync(join(t.home, "answers.json"), "utf8");
    assert.ok(!kept.includes(m[2]) && kept.includes("took @"), "the token itself isn't kept, only what it runs");
    const ran = await t.post(m[1]);
    assert.deepEqual([ran.status, ran.body.ok], [200, true], JSON.stringify(ran.body));
    assert.deepEqual((await t.doses()).map((r) => r.at), [stampOf(t.due)], "logged at the window's deadline, so the window is met");
    const [entry] = await t.s.env.activity.list("Apps/Pills.md");
    assert.equal(entry?.actor, "link");
    const again = await t.post(m[1]);
    assert.equal(again.status, 410, "a button answers once");
    assert.equal((await t.post(`/answer/${"0".repeat(48)}`)).status, 410);
    assert.equal((await t.doses()).length, 1);
  } finally {
    await t.close();
  }
});

test("a pushed button's token runs only its own line and expires after a day; with no Tailscale address the push has no button", async () => {
  const t = await missedPills(async () => undefined);
  try {
    assert.deepEqual(t.pushes.map((p) => [p.body, p.actions]), [[`Pills: nothing by ${t.by}`, undefined]]);
    const took = { line: "took", path: "Apps/Pills.md", shortcut: "took", params: {} };
    const old = await new AnswerTokens(t.home, () => Date.now() - ANSWER_MS - 60_000).mint(took);
    const fresh = await new AnswerTokens(t.home).mint(took);
    assert.equal((await t.post(`/answer/${old}`)).status, 410, "more than a day old");
    assert.equal((await t.post(`/answer/${fresh}`)).status, 200);
    assert.equal((await t.post(`/answer/${fresh}/x`)).status, 401, "anything else needs a key");
    assert.equal((await t.doses()).length, 1);
  } finally {
    await t.close();
  }
});

test("gizmod asks the network only for what a note names: nothing at all without share:, and a shared kind's relay with it", async () => {
  const calls: { url: string; method: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
  const chore = { kind: "chore", fields: { task: "text" } };
  const root = vaultDir({
    "Kinds/Chore.md": { fm: chore },
    "Kinds/Chore data/log/gzold000-2026-11.jsonl": `${JSON.stringify({ t: "2026-11-18T08:00:00.000Z/0", d: "gzold000", op: "add", l: "chore", row: "0000000000000001", v: { task: "Bins", at: "2026-11-18T08:00" } })}\n`,
    "Apps/Chores.md": { fm: { app: "c", panels: [{ view: "form", save: "[[Chore]]", title: "Did" }, { view: "table", source: "[[Chore]]" }] } },
    ".obsidian/plugins/gizmo/data.json": JSON.stringify({ grants: { "Kinds/Chore.md": [], "Apps/Chores.md": ["kind-write:Kinds/Chore.md", "kind:Kinds/Chore.md"] } }),
  });
  const env = gizmodEnv({ vault: root, device: "gztest01", log: () => {}, fetch });
  await env.vault.scan();
  const bg = new Background(env.bgEnv);
  await env.beat.beat();
  await bg.start();
  await bg.tick();
  assert.equal(calls.length, 0, JSON.stringify(calls));
  bg.stop();

  // The same kind shared, its key in gizmod's environment as op run gives it, and allowed in Obsidian.
  const id = await newIdentity("Ann");
  const shared = { ...chore, share: { relay: "http://127.0.0.1:9", key: { secret: "chore-key" } } };
  writeFileSync(join(root, "Kinds/Chore.md"), `---\n${stringify(shared)}---\n`);
  writeFileSync(join(root, ".obsidian/plugins/gizmo/data.json"), JSON.stringify({ grants: { "Kinds/Chore.md": ["secret:chore-key", "share:Kinds/Chore.md|127.0.0.1:9"] } }));
  process.env.GIZMO_SECRET_CHORE_KEY = identityText(id);
  try {
    const env2 = gizmodEnv({ vault: root, device: "gztest01", log: () => {}, fetch });
    await env2.vault.scan();
    const bg2 = new Background(env2.bgEnv);
    await env2.beat.beat();
    await bg2.start();
    await bg2.tick();
    const topic = (await kindKeys(id.key)).topic;
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.url.startsWith(`http://127.0.0.1:9/${topic}`)), JSON.stringify(calls));
    assert.ok(calls.some((c) => c.method === "GET" && c.url.endsWith("/json?poll=1&since=all")));
    assert.ok(calls.some((c) => c.method === "POST"), "the row logged before is sent");
    bg2.stop();
  } finally {
    delete process.env.GIZMO_SECRET_CHORE_KEY;
  }
});

test("a Done tapped after the window was met logs nothing more; a token runs the shortcut it was made for, while its app may run", async () => {
  const t = await missedPills(async () => "100.64.0.7");
  try {
    const m = /(\/answer\/[0-9a-f]{48})/.exec(t.pushes[0]?.actions ?? "");
    assert.ok(m, String(t.pushes[0]?.actions));
    // The dose was logged meanwhile, in its window (in Obsidian, from Next): the button is stale.
    const own = await t.s.bg.runFrom("Apps/Pills.md", "took", { params: { at: stampOf(t.due) }, trusted: true });
    assert.ok(own.ok, JSON.stringify(own));
    const late = await t.post(m![1]);
    assert.deepEqual([late.status, late.body.error], [409, "that was done already; nothing more was logged"]);
    assert.equal((await t.doses()).length, 1);
    assert.equal((await t.post(m![1])).status, 410, "and it is spent");
    // A token is bound to an app and its shortcut, not to the words of its line: one whose shortcut is gone runs nothing else.
    const elsewhere = await new AnswerTokens(t.home).mint({ line: "took", path: "Apps/Pills.md", shortcut: "taken", params: {} });
    assert.notEqual((await t.post(`/answer/${elsewhere}`)).status, 200);
    assert.equal((await t.doses()).length, 1);
    // An app no longer allowed: refused, and the token isn't spent.
    const later = await new AnswerTokens(t.home).mint({ line: "took", path: "Apps/Gone.md", shortcut: "took", params: {} });
    assert.equal((await t.post(`/answer/${later}`)).status, 403);
    assert.ok(readFileSync(join(t.home, "answers.json"), "utf8").includes("Apps/Gone.md"));
  } finally {
    await t.close();
  }
});

test("a missed window is still pushed when the answers file can't be read or written: without a button when no token can be kept", async () => {
  const unreadable = await missedPills(async () => "100.64.0.7", (home) => writeFileSync(join(home, "answers.json"), "{not json"));
  try {
    assert.equal(unreadable.pushes.length, 1);
    assert.match(unreadable.pushes[0].actions ?? "", /^http, Done, /, "a file that can't be read is read as none");
  } finally {
    await unreadable.close();
  }
  const unwritable = await missedPills(async () => "100.64.0.7", (home) => mkdirSync(join(home, "answers.json", "x"), { recursive: true }));
  try {
    assert.deepEqual(unwritable.pushes.map((p) => [p.body, p.actions]), [[`Pills: nothing by ${unwritable.by}`, undefined]]);
  } finally {
    await unwritable.close();
  }
});
