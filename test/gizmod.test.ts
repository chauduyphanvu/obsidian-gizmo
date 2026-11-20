import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stringify } from "yaml";
import { adminToken, plist, runScript, serve } from "../src/node/gizmod.ts";
import { pushText, secretFromEnv } from "../src/node/host.ts";
import { NodeVault, inlineTags, splitNote } from "../src/node/vault.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";

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
    const { renameSync } = await import("node:fs");
    renameSync(join(root, "Apps"), join(root, "Tools"));
    for (let i = 0; i < 40 && !v.file("Tools/Deep/Inbox.md"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(v.notes().map((n) => n.path).sort(), ["Tools/Deep/Inbox.md", "Tools/Mood.md"]);
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
async function served(settings: Record<string, unknown> = {}) {
  const wanted = permissionsOf(readSpec(INBOX, { path: "Apps/Inbox.md" })!.spec!, "Apps/Inbox.md");
  const root = vaultDir({
    "Apps/Inbox.md": { fm: INBOX },
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
