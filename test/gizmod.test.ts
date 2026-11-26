import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, test } from "node:test";
import { stringify } from "yaml";
import { ANSWER_MS, AnswerTokens, adminToken, deviceOf, ownHost, plist, runScript, serve, type ExtraRoute, type ServeOptions } from "../scripts/gizmod/gizmod.ts";
import { gizmodEnv, pushText } from "../scripts/gizmod/host.ts";
import { KeychainSecrets, gizmodSecrets, passwordOf, secretFromEnv, type Security } from "../scripts/gizmod/secrets.ts";
import { identityText, kindKeys, newIdentity } from "../src/share-crypto.ts";
import { NodeVault, nodePath } from "../scripts/gizmod/vault.ts";
import { inlineTags, splitNote } from "../src/note-text.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { PRIORITY, readBeat, runnerOf } from "../src/device.ts";
import { stampOf } from "../src/time.ts";
import { textHash } from "../src/hash.ts";

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

// What follows pins what a real Obsidian answered in test/live/parity.mjs (Obsidian 1.15).

test("tags as Obsidian reads them: a code block ends only on its own fence, HTML comments hide tags, %% comments don't", () => {
  assert.deepEqual(inlineTags("````\n```\n#inner\n```\n````\n#after4\n~~~\n#tilde\n~~~\n#aftertilde\n```js\n#lang\n```\n#afterlang"), ["#after4", "#aftertilde", "#afterlang"]);
  assert.deepEqual(inlineTags("%% #pct %%\n<!-- #html -->\n%%\n#pctblock\n%%\n<!--\n#htmlblock\n-->\ntext #after\nkept #a <!-- #b --> #c <!-- #d\n#e --> #f"), ["#pct", "#pctblock", "#after", "#a", "#c", "#f"]);
});

test("a note that starts with a byte order mark has its frontmatter read", async () => {
  const root = vaultDir({ "Bom.md": "﻿---\nbom: 1\ntags: [bomtag]\n---\nbody #bominline" });
  const v = new NodeVault(root);
  await v.scan();
  assert.deepEqual(v.file("Bom.md")?.fm, { bom: 1, tags: ["bomtag"] });
  assert.deepEqual(v.file("Bom.md")?.tags, ["#bomtag", "#bominline"]);
});

test("a name written decomposed on disk is the vault's under its NFC path: listed, linked, read and written", async () => {
  const nfd = "Café";
  const nfc = "Café";
  const root = vaultDir({ [`${nfd}.md`]: "---\nn: 1\n---\nbody" });
  const v = new NodeVault(root);
  await v.scan();
  assert.deepEqual(v.notes().map((n) => n.path), [`${nfc}.md`]);
  assert.equal(v.resolve(nfc, ""), `${nfc}.md`);
  assert.equal(v.resolve(nfd, ""), `${nfc}.md`);
  assert.equal(nodePath(`./Notes//${nfd}.md`), `Notes/${nfc}.md`);
  assert.match(await v.read(`${nfd}.md`), /body/);
  await v.process(`${nfc}.md`, (fm) => { fm.n = 2; });
  assert.deepEqual(readdirSync(root).filter((f) => f.endsWith(".md")), [`${nfd}.md`], "written in place, under the name it has");
  assert.deepEqual(v.file(`${nfc}.md`)?.fm, { n: 2 });
});

test("a relative link resolves case aside, and never outside the vault", async () => {
  const root = vaultDir({ "Inbox.md": "", "Notes/Near.md": "", "Notes/Linker.md": "" });
  const v = new NodeVault(root);
  await v.scan();
  assert.equal(v.resolve("./near", "Notes/Linker.md"), "Notes/Near.md");
  assert.equal(v.resolve("./NEAR", "Notes/Linker.md"), "Notes/Near.md");
  assert.equal(v.resolve("../inbox", "Notes/Linker.md"), "Inbox.md");
  assert.equal(v.resolve("../../elsewhere", "Notes/Linker.md"), undefined);
});

test("a folder reached through a symlink is read; a symlinked note isn't", async () => {
  const root = vaultDir({ "Inbox.md": "inbox" });
  const outside = mkdtempSync(join(tmpdir(), "gizmod-outside-"));
  made.push(outside);
  mkdirSync(join(outside, "Shared"));
  writeFileSync(join(outside, "Shared", "Far.md"), "---\nfar: 1\n---\n#far");
  symlinkSync(join(outside, "Shared"), join(root, "Shared"));
  symlinkSync(join(root, "Inbox.md"), join(root, "Alias.md"));
  // A folder linked into itself is read once.
  symlinkSync(join(outside, "Shared"), join(outside, "Shared", "Loop"));
  const v = new NodeVault(root);
  await v.scan();
  assert.deepEqual(v.notes().map((n) => n.path).sort(), ["Inbox.md", "Shared/Far.md"]);
  assert.deepEqual(v.file("Shared/Far.md")?.tags, ["#far"]);
});

test("a frontmatter edit replaces only the YAML: the block's own lines are kept, a block left empty goes, a BOM note gets a block of its own", async () => {
  const root = vaultDir({
    "Crlf.md": "---\r\nx: 1\r\n---\r\nbody\r\n",
    "Drop.md": "---\na: 1\n---\nbody\n",
    "Empty.md": "---\n---\nbody\n",
    "None.md": "body\n",
    "Bom.md": "﻿---\nx: 1\n---\nbody\n",
  });
  const v = new NodeVault(root);
  await v.scan();
  const text = (p: string) => readFileSync(join(root, p), "utf8");
  await v.process("Crlf.md", (fm) => { fm.a = 1; });
  assert.equal(text("Crlf.md"), "---\r\nx: 1\na: 1\n---\r\nbody\r\n");
  await v.process("Drop.md", (fm) => { delete fm.a; });
  assert.equal(text("Drop.md"), "body\n");
  await v.process("Empty.md", (fm) => { fm.a = 1; });
  assert.equal(text("Empty.md"), "---\na: 1\n---\nbody\n");
  await v.process("None.md", () => {});
  assert.equal(text("None.md"), "body\n");
  // Obsidian's own edits don't see a block behind a byte order mark (its reading does).
  await v.process("Bom.md", (fm) => { fm.a = 1; });
  assert.equal(text("Bom.md"), "---\na: 1\n---\n﻿---\nx: 1\n---\nbody\n");
});

test("a rescan reads what changed while nobody watched: a new note, an edited one, one removed", async () => {
  const root = vaultDir({ "Kept.md": "kept", "Edited.md": "---\nn: 1\n---\n", "Gone.md": "gone" });
  const v = new NodeVault(root);
  await v.scan();
  const told: string[] = [];
  v.onChange((path, gone) => told.push(`${gone ? "-" : "+"}${path}`));
  writeFileSync(join(root, "New.md"), "new");
  writeFileSync(join(root, "Edited.md"), "---\nn: 2\n---\n");
  utimesSync(join(root, "Edited.md"), new Date(), new Date(Date.now() + 5000));
  unlinkSync(join(root, "Gone.md"));
  await v.rescan();
  assert.deepEqual(told.sort(), ["+Edited.md", "+New.md", "-Gone.md"]);
  assert.deepEqual(v.file("Edited.md")?.fm, { n: 2 });
  assert.equal(v.file("Gone.md"), undefined);
});

test("a template note is found from the app that uses it, as Obsidian finds it", async () => {
  const root = vaultDir({ "Projects/Deep/Visit.md": "---\napp: Visit\n---\n", "Projects/Deep/Tpl.md": "beside the app", "Old/Tpl.md": "old one" });
  const env = gizmodEnv({ vault: root, device: "gztest01", log: () => {} });
  await env.vault.scan();
  assert.equal((await env.runtime.host.actionIO("Projects/Deep/Visit.md")!.readBody("Tpl")).trim(), "beside the app");
  assert.equal((await env.runtime.host.actionIO("Notes/Other.md")!.readBody("Tpl")).trim(), "old one", "from elsewhere, the shortest path");
});

const INBOX = { app: "Inbox", panels: [{ view: "form", title: "Add", fields: { task: "text" }, save: "todo", shortcut: "add", alias: "task" }, { view: "number", title: "Open", source: "todo", agg: "count", shortcut: "open" }] };
const LINK_KEY = "k".repeat(32);
const CAPTURE_KEY = "c".repeat(32);

/** A vault with Inbox allowed in Obsidian, its link keys and a capture key in data.json, and gizmod serving it without listening. */
async function served(settings: Record<string, unknown> = {}, inbox: Record<string, unknown> = INBOX, extra: Pick<ServeOptions, "pages" | "routes"> = {}) {
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
  const s = await serve({ vault: root, home, listen: false, log: (l) => lines.push(l), ...extra });
  const token = await adminToken(home);
  /** One request, as the server would hand it over. */
  const ask = async (method: string, url: string, opts: { auth?: string; body?: unknown; from?: string; host?: string } = {}) => {
    const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const req = {
      method, url, headers: { ...(opts.auth && { authorization: `Bearer ${opts.auth}` }), ...(opts.host && { host: opts.host }) }, socket: { remoteAddress: opts.from ?? "127.0.0.1" },
      async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text); },
    } as unknown as IncomingMessage;
    let status = 0;
    let out = "";
    const res = { writeHead: (st: number) => { status = st; }, end: (t: string) => { out = t; } } as unknown as ServerResponse;
    await s.handle(req, res);
    return { status, body: JSON.parse(out) as Record<string, unknown> };
  };
  const rows = async () => (await s.env.runtime.dataLayer.ledger!.state("Apps/Inbox data.md")).lists.get("todo")?.rows.map((r) => r.task) ?? [];
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
    assert.equal((await t.ask("GET", "/get/Nowhere/open", { auth: LINK_KEY })).status, 403);
    assert.equal((await t.ask("GET", "/get/Nowhere/open", { auth: t.token })).status, 404, "this computer's own user hears what isn't there");
  } finally {
    await t.s.close();
  }
});

test("a caller with no key that runs the shortcut hears one answer, whatever is there: no app, shortcut, field, choice or item is named", async () => {
  const meds = { app: "Inbox", panels: [
    { view: "checklist", title: "Today", items: ["Lisinopril 10mg", "Metformin 500mg"], shortcut: "open" },
    { view: "form", title: "Log", fields: { dose: "number", drug: ["Lisinopril", "Metformin"] }, save: "todo", shortcut: "add" },
  ] };
  const t = await served({}, meds);
  try {
    const from = { auth: "x".repeat(32), from: "100.64.0.9" };
    const probes = [
      await t.ask("POST", "/run/Nope/x", from),
      await t.ask("POST", "/run/Inbox/nope", from),
      await t.ask("POST", "/run/Inbox/open", { ...from, body: { item: "zzz" } }),
      await t.ask("POST", "/run/Inbox/add", { ...from, body: { drug: "zzz" } }),
      await t.ask("POST", "/run/Inbox/add", { ...from, body: { dose: "zzz" } }),
      await t.ask("GET", "/get/Inbox/open", from),
      await t.ask("POST", "/dry/Inbox/add", { ...from, body: { dose: "1" } }),
      await t.ask("POST", "/dry/Nope/add", from),
      // The admin token from another computer is no key at all.
      await t.ask("POST", "/run/Inbox/add", { auth: t.token, from: "100.64.0.9", body: { drug: "zzz" } }),
    ];
    for (const p of probes) assert.deepEqual([p.status, p.body], [403, { ok: false, error: "that key doesn't run this" }]);
    // A key's holder still hears why a run didn't go.
    const mine = await t.ask("POST", "/run/Inbox/add", { auth: LINK_KEY, from: "100.64.0.9", body: { drug: "zzz" } });
    assert.deepEqual([mine.status, mine.body.error], [422, "Inbox: drug must be one of Lisinopril, Metformin"]);
    assert.deepEqual(await t.rows(), []);
  } finally {
    await t.s.close();
  }
});

test("gizmod answers only at its own address: a web page's name pointed at this computer is refused", async () => {
  assert.deepEqual(
    [undefined, "127.0.0.1:7468", "localhost:7468", "LOCALHOST", "100.64.0.1:7468", "mac.tail1234.ts.net:7468", "macbook:7468", "evil.example:7468", "127.0.0.1.evil.example", "100.64.0.2:7468", "ts.net.evil.example:7468", "localhost.evil.example:7468"]
      .map((h) => ownHost(h, ["127.0.0.1", "100.64.0.1"], 7468)),
    [true, true, true, true, true, true, true, false, false, false, false, false],
  );
  const t = await served();
  try {
    const req = { method: "GET", url: "/status", headers: { authorization: `Bearer ${t.token}`, host: "evil.example:7468" }, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage;
    let status = 0;
    await t.s.handle(req, { writeHead: (st: number) => { status = st; }, end: () => {} } as unknown as ServerResponse);
    assert.equal(status, 403);
  } finally {
    await t.s.close();
  }
});

test("gizmod reads and writes only the vault's own files: not beside the vault, not in the config folder, and the policy note under no spelling", async () => {
  const t = await served();
  try {
    writeFileSync(join(t.root, "..", `${basename(t.root)}-outside.json`), "[]");
    made.push(join(t.root, "..", `${basename(t.root)}-outside.json`));
    writeFileSync(join(t.root, "Gizmo policy.md"), "---\nlabels: {}\n---\n");
    for (const path of [`../${basename(t.root)}-outside.json`, ".obsidian/plugins/gizmo/data.json", "Apps/../../x.json", "/etc/hosts"]) {
      await assert.rejects(async () => t.s.env.host.readFile(path), /isn't a file in this vault/, path);
      assert.equal(t.s.env.host.fileSize!(path), undefined, path);
    }
    for (const path of ["./Gizmo policy.md", "Apps/../Gizmo policy.md", "Gizmo policy.md/", ".//gizmo POLICY.md"]) {
      await assert.rejects(async () => t.s.env.io.appendLine(path, "- x"), /your Gizmo policy|isn't a path in this vault/, path);
    }
    for (const path of ["../outside.md", ".obsidian/x.md", "/tmp/x.md"]) {
      await assert.rejects(async () => t.s.env.io.appendLine(path, "- x"), /isn't a (path|file) in this vault/, path);
    }
    assert.equal(readFileSync(join(t.root, "Gizmo policy.md"), "utf8"), "---\nlabels: {}\n---\n");
    // Another spelling of a note's own path writes that note.
    await t.s.env.io.appendLine("./Notes//Daily.md", "- x");
    assert.equal(readFileSync(join(t.root, "Notes/Daily.md"), "utf8"), "- x\n");
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

test("gizmod's settings say when data.json changed since last asked, so the runtime is told of it", async () => {
  const root = vaultDir({ ".obsidian/plugins/gizmo/data.json": JSON.stringify({ grants: {} }) });
  const env = gizmodEnv({ vault: root, device: "gztest01", log: () => {} });
  assert.equal(env.settings.changed(), false, "as it was when gizmod started");
  const path = join(root, ".obsidian/plugins/gizmo/data.json");
  writeFileSync(path, JSON.stringify({ grants: { "Apps/A.md": [] } }));
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
  assert.equal(env.settings.changed(), true);
  assert.equal(env.settings.changed(), false, "told once");
  assert.deepEqual(Object.keys(env.settings.data.grants), ["Apps/A.md"]);
});

test("a Keychain secret: read with -g (plain or hex), kept five minutes, a miss looked for again; a value goes to security on its input, never its arguments", () => {
  assert.equal(passwordOf('keychain: "x"\npassword: "va l"ue x"\n'), 'va l"ue x');
  assert.equal(passwordOf('password: 0x636166C3A9  "caf\\303\\251"'), "café");
  assert.equal(passwordOf("nothing"), undefined);
  const calls: { args: string[]; input?: string }[] = [];
  const store = new Map<string, string>();
  const security: Security = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "find-generic-password") {
      const v = store.get(args[args.indexOf("-a") + 1]);
      return v === undefined ? { status: 44, stdout: "", stderr: "not found" } : { status: 0, stdout: "", stderr: `password: "${v}"\n` };
    }
    if (args[0] === "-i") {
      const m = /-a (\S+) .* -w "((?:[^"\\]|\\.)*)"/.exec(input!)!;
      store.set(m[1], m[2].replace(/\\(.)/g, "$1"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "delete-generic-password") return { status: store.delete(args[args.indexOf("-a") + 1]) ? 0 : 44, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  let clock = 0;
  const k = new KeychainSecrets({ security, available: true, now: () => clock, keychain: "/tmp/test.keychain-db" });
  assert.equal(k.get("api-key"), null);
  k.set("api-key", 'sk "1" \\ 2');
  assert.ok(calls.every((c) => !c.args.join(" ").includes("sk ")), "the value is never an argument");
  assert.match(calls.find((c) => c.args[0] === "-i")!.input!, / "\/tmp\/test.keychain-db"\n$/);
  const asked = calls.length;
  assert.equal(k.get("api-key"), 'sk "1" \\ 2');
  assert.equal(calls.length, asked, "read back when kept, then from what's kept");
  clock += 5 * 60_000;
  assert.equal(k.get("api-key"), 'sk "1" \\ 2');
  assert.equal(calls.length, asked + 1, "read again after five minutes");
  assert.throws(() => k.set("Bad_Id", "x"), /lowercase letters, digits and dashes/);
  assert.throws(() => k.set("ok", "two\nlines"), /one line/);
  assert.equal(k.delete("api-key"), true);
  assert.equal(k.get("api-key"), null);

  // The environment first, as op run gives it; then the Keychain; and what to say of one found in neither.
  store.set("both", "from keychain");
  const s = gizmodSecrets(k, { GIZMO_SECRET_BOTH: "from env" });
  assert.equal(s.secret("both"), "from env");
  assert.equal(gizmodSecrets(k, {}).secret("both"), "from keychain");
  assert.match(s.where("gone"), /secret set gone.*GIZMO_SECRET_GONE/);
  const none = gizmodSecrets(new KeychainSecrets({ available: false, security }), {});
  assert.equal(none.secret("both"), null, "no Keychain off macOS");
  assert.doesNotMatch(none.where("gone"), /secret set/);
  assert.throws(() => new KeychainSecrets({ available: false }).set("x", "y"), /no Keychain here/);
});

test("gizmod's name: kept per vault with its id, \"gizmod\" until named; an id kept alone from before still reads", async () => {
  const home = mkdtempSync(join(tmpdir(), "gizmod-home-"));
  made.push(home);
  writeFileSync(join(home, "devices.json"), JSON.stringify({ "/vaults/old": "gzold01" }));
  assert.deepEqual(await deviceOf(home, "/vaults/old"), { id: "gzold01", name: "gizmod" });
  assert.deepEqual(await deviceOf(home, "/vaults/old", "Studio Mac"), { id: "gzold01", name: "Studio Mac" });
  assert.deepEqual(await deviceOf(home, "/vaults/old"), { id: "gzold01", name: "Studio Mac" }, "kept for next time");
  const fresh = await deviceOf(home, "/vaults/new");
  assert.match(fresh.id, /^gz[0-9a-f]{6}$/);
  assert.equal(fresh.name, "gizmod");
  assert.deepEqual(await deviceOf(home, "/vaults/new"), fresh);

  const root = vaultDir({});
  const env = gizmodEnv({ vault: root, device: "gzname01", name: "Studio Mac", log: () => {} });
  await env.runtime.beat.beat(true);
  assert.equal(readBeat(readFileSync(join(root, ".obsidian/plugins/gizmo/devices/gzname01.json"), "utf8"))!.name, "Studio Mac");
});

test("gizmod stopping writes what's waiting and says it's leaving, so Obsidian takes over at once", async () => {
  const t = await served();
  await t.s.env.runtime.beat.beat(true);
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
  const doses = async () => (await s.env.runtime.dataLayer.ledger!.state("Apps/Pills data.md")).lists.get("doses")?.rows ?? [];
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
    const [entry] = await t.s.env.runtime.activity.list("Apps/Pills.md");
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
  const bg = env.runtime.background;
  await env.runtime.beat.beat();
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
    const bg2 = env2.runtime.background;
    await env2.runtime.beat.beat();
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

test("gizmod seals as the device running background work: a sealed kind once allowed, its hash sent to the authority it was allowed to ask", async () => {
  const ev = (t: number, row: string) => `${JSON.stringify({ op: "add", l: "dose", row, v: { what: "morning" }, t: `${new Date(t).toISOString()}/0`, d: "gztest01" })}\n`;
  const root = vaultDir({
    "Kinds/Dose.md": { fm: { kind: "dose", fields: { what: "text" }, seal: { authority: "https://tsa.example.com/tsr" } } },
    "Kinds/Dose data/log/gztest01-2026-11.jsonl": ev(Date.UTC(2026, 10, 19), "00000000000000a1"),
    ".obsidian/plugins/gizmo/data.json": JSON.stringify({ grants: { "Kinds/Dose.md": [] } }),
  });
  const posts: { url: string; type: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    posts.push({ url, type: new Headers(init?.headers).get("content-type") });
    return new Response(new Uint8Array([0]), { status: 503 });
  }) as typeof globalThis.fetch;
  const env = gizmodEnv({ vault: root, device: "gztest01", log: () => {}, fetch, now: () => Date.UTC(2026, 10, 22) });
  await env.vault.scan();
  await env.runtime.beat.beat();
  assert.equal(env.runtime.beat.isRunner(), true);
  await env.runtime.sealDue();
  const seals = () => readdirSync(join(root, "Kinds/Dose data/log")).filter((f) => f.endsWith(".seals")).map((f) => readFileSync(join(root, "Kinds/Dose data/log", f), "utf8").trim().split("\n").length);
  assert.deepEqual(seals(), [], "a kind runs nothing of its own until allowed what it asks for");
  assert.deepEqual(posts, []);

  // Allowed in Obsidian to ask its authority: the seal is made and its hash goes there (which answers 503 here).
  writeFileSync(join(root, ".obsidian/plugins/gizmo/data.json"), JSON.stringify({ grants: { "Kinds/Dose.md": ["seal:Kinds/Dose.md|tsa.example.com"] } }));
  const later = gizmodEnv({ vault: root, device: "gztest01", log: () => {}, fetch, now: () => Date.UTC(2026, 10, 23, 1) });
  await later.vault.scan();
  await later.runtime.beat.beat();
  await later.runtime.sealDue();
  assert.deepEqual(posts, [{ url: "https://tsa.example.com/tsr", type: "application/timestamp-query" }]);
  assert.deepEqual(seals(), [1], "sealed without a time stamp when the authority fails");
  await later.runtime.sealDue();
  assert.deepEqual(seals(), [1], "not again within the day");
});

test("gizmod's host: no answer at all is the network's failure, naming the host; a missing secret says which variable to set", async () => {
  const root = vaultDir({});
  const fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof globalThis.fetch;
  const env = gizmodEnv({ vault: root, device: "gztest01", log: () => {}, fetch });
  await assert.rejects(env.host.fetch("https://api.example.com/w", {}), (e: Error & { kind?: string; host?: string }) => e.kind === "network" && e.host === "api.example.com");
  assert.match(env.host.whereSecrets!("api-key"), /GIZMO_SECRET_API_KEY/);
});

test("gizmod makes a note only where none is, and undoing a note it made moves it to the vault's .trash while it is unchanged", async () => {
  const root = vaultDir({ "Daily.md": "# Today\n" });
  const env = gizmodEnv({ vault: root, device: "gztest01", log: () => {} });
  await env.vault.scan();
  await assert.rejects(env.vault.create("Daily.md", "over"), /EEXIST/);
  assert.equal(readFileSync(join(root, "Daily.md"), "utf8"), "# Today\n");

  const made = await env.io.createNote("Notes/Idea.md", {}, "an idea\n");
  assert.equal(typeof made, "string");
  const entry = await env.runtime.activity.add({ app: "Apps/Ideas.md", actor: "you", what: "Made a note", changes: [{ kind: "note-created", path: "Notes/Idea.md", hash: textHash(made as string) }] });
  assert.equal((await env.runtime.undo(entry!)).undone, 1);
  assert.equal(existsSync(join(root, "Notes/Idea.md")), false);
  assert.equal(readFileSync(join(root, ".trash/Idea.md"), "utf8"), "an idea\n");
  // A second note of that name in the trash keeps both.
  const again = await env.io.createNote("Notes/Idea.md", {}, "another\n");
  const second = await env.runtime.activity.add({ app: "Apps/Ideas.md", actor: "you", what: "Made a note", changes: [{ kind: "note-created", path: "Notes/Idea.md", hash: textHash(again as string) }] });
  await env.runtime.undo(second!);
  assert.deepEqual(readdirSync(join(root, ".trash")).sort(), ["Idea 2.md", "Idea.md"]);
});

test("what the commands' helpers ask of gizmod: new notes at the root, a raw create that never overwrites, whether a path is there, and secrets kept in its store", async () => {
  const root = vaultDir({ "Apps/Inbox.md": { fm: INBOX }, "Notes/Plain.md": "plain\n" });
  const kept = new Map<string, string>();
  const security: Security = (args, input) => {
    if (args[0] === "find-generic-password") {
      const v = kept.get(args[args.indexOf("-a") + 1]);
      return v === undefined ? { status: 44, stdout: "", stderr: "not found" } : { status: 0, stdout: "", stderr: `password: "${v}"\n` };
    }
    if (args[0] === "-i") {
      const m = /-a (\S+) .* -w "((?:[^"\\]|\\.)*)"/.exec(input!)!;
      kept.set(m[1], m[2].replace(/\\(.)/g, "$1"));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  const env = gizmodEnv({ vault: root, device: "gzhelp01", log: () => {}, keychain: new KeychainSecrets({ security, available: true }) });
  const host = env.runtime.host;
  assert.equal(host.newNotesFolder(), "");
  assert.equal(host.exists("Apps/Inbox.md"), true);
  assert.equal(host.exists("Apps"), true, "a folder is there too");
  assert.equal(host.exists("Apps/Gone.md"), false);
  assert.equal(host.exists("../outside.md"), false, "nothing outside the vault");

  assert.equal(await host.writes.createText("Notes/Plain.md", "over\n"), false);
  assert.equal(readFileSync(join(root, "Notes/Plain.md"), "utf8"), "plain\n", "never overwritten");
  const text = "---\nkind: chore\n---\n---not frontmatter\n";
  assert.equal(await host.writes.createText("Kinds/Chore.md", text), true);
  assert.equal(readFileSync(join(root, "Kinds/Chore.md"), "utf8"), text, "exactly the text, and its folder made");
  await host.whenIndexed("Kinds/Chore.md");
  assert.equal(env.runtime.dataLayer.host.frontmatter("Kinds/Chore.md")?.kind, "chore", "read into the index as it's written");

  assert.equal(host.secrets!.get("chore-key"), null);
  host.secrets!.set("chore-key", "gzk1.value");
  assert.equal(kept.get("chore-key"), "gzk1.value", "kept in the Keychain");
  assert.equal(host.secrets!.get("chore-key"), "gzk1.value");
});

test("a program built on gizmod adds its own answers: pages to anyone at gizmod's address, routes to this computer's own user only", async () => {
  const reply = (body: unknown): ExtraRoute => async (_req, res, url) => {
    if (!url.pathname.startsWith("/app")) return false;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return true;
  };
  const t = await served({}, INBOX, { pages: reply({ page: true }), routes: reply({ route: true }) });
  try {
    assert.deepEqual(await t.ask("GET", "/app/index.html"), { status: 200, body: { page: true } }, "a page needs no key");
    assert.equal((await t.ask("GET", "/app/index.html", { host: "evil.example.com" })).status, 403, "past the host check only");
    assert.deepEqual(await t.ask("POST", "/app/api", { auth: t.token }), { status: 200, body: { route: true } });
    assert.equal((await t.ask("POST", "/app/api")).status, 401);
    assert.equal((await t.ask("POST", "/app/api", { auth: LINK_KEY })).status, 404, "a link key reaches no route");
    assert.equal((await t.ask("POST", "/app/api", { auth: t.token, from: "100.64.0.9" })).status, 404, "nor the token from another computer");
    assert.equal((await t.ask("GET", "/status", { auth: t.token })).status, 200, "gizmod's own answers come first");
  } finally {
    await t.s.close();
  }
});
