import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { aheadEnv, aheadLines, addWhatIf, branchName, defaultHorizon, discard, keep, lookAhead, parseWhatIf, whatIfLine, whatIfNotes, whatIfRows, AHEAD_MS } from "../src/ahead.ts";
import { AppController, type AppEnv } from "../src/app.ts";
import { undoEntry } from "../src/activity.ts";
import { MAX_STEPS } from "../src/backtest.ts";
import { captureTargets } from "../src/capture.ts";
import { cacheKey, DataLayer } from "../src/datalayer.ts";
import { logFolder } from "../src/ledger.ts";
import { AHEAD, Ledger, rowIdOf, type LedgerIO, type LedgerState } from "../src/ledger-store.ts";
import { isWhatIf } from "../src/row-marks.ts";
import { pastText } from "../src/replay.ts";
import { readSpec, type AppSpec } from "../src/spec.ts";
import { calendarOf, stampOf } from "../src/time.ts";
import { STEP_MS, TimeRail, aheadEnd, aheadLabel, railModel, snapAhead, stepAhead } from "../src/rail.ts";
import { addLine, said, typeLine } from "./support/addline.ts";
import { fakeEnv } from "./support/fakes.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 1, 8, 0);
const DATA = "Apps/Budget data.md";
const enc = new TextEncoder();

/** Files in memory shared by every device, as a synced folder. */
function vault() {
  const files = new Map<string, string>();
  const fms = new Map<string, Record<string, unknown>>();
  const io: LedgerIO = {
    filesIn: (folder) => [...files.keys()].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")),
    readFile: async (p) => {
      if (!files.has(p)) throw new Error(`Can't find ${p}`);
      return files.get(p)!;
    },
    append: async (p, text) => { files.set(p, (files.get(p) ?? "") + text); },
    writeFile: async (p, text) => { files.set(p, text); },
    frontmatter: (p) => fms.get(p),
    size: (p) => (files.has(p) ? enc.encode(files.get(p)!).length : undefined),
  };
  const writeNote = async (fn: (fm: Record<string, unknown>) => void) => {
    const fm = structuredClone(fms.get(DATA) ?? {});
    fn(fm);
    fms.set(DATA, fm);
  };
  const copy = () => {
    const c = vault();
    for (const [k, v] of files) c.files.set(k, v);
    for (const [k, v] of fms) c.fms.set(k, structuredClone(v));
    return c;
  };
  return { files, fms, io, writeNote, copy };
}

const seen = (st: LedgerState) => ({
  lists: [...st.lists].map(([k, l]) => [k, l.rows.map((r) => [rowIdOf(r), { ...r }]), l.conflicts]),
  ticked: [...st.ticked], undone: [...st.undone].sort(),
});

/** Spending over 40 days on device a, snapshotted every few days, so the data note and a checkpoint exist. */
async function history() {
  const v = vault();
  const clock = { now: T0 };
  const a = new Ledger(v.io, () => "a", () => clock.now);
  for (let i = 0; i < 40; i++) {
    clock.now = T0 + i * DAY;
    await a.write(DATA, [{ op: "add", l: "spend", row: `s${i}`, v: { amount: i, at: new Date(clock.now).toISOString().slice(0, 16) } }]);
    if (i % 5 === 4) await a.snapshot(DATA, {}, v.writeNote);
  }
  return { v, clock };
}

test("a what-if branch beside the logs leaves the live ledger as it is: its lists, its checkpoint files and the data note, byte for byte", async () => {
  const { v, clock } = await history();
  const branched = v.copy();
  const ahead = new Ledger(branched.io, () => "a", () => clock.now, undefined, "Budget");
  await ahead.write(DATA, [{ op: "add", l: "spend", row: ahead.newRowId(), v: { amount: 900, at: "2026-12-03T12:00" } }]);
  const [whatIf] = (await ahead.state(DATA)).lists.get("spend")!.rows.filter(isWhatIf);
  await ahead.write(DATA, [{ op: "set", l: "spend", row: rowIdOf(whatIf)!, f: "amount", v: 950, from: 900 }]);
  const branch = `${logFolder(DATA)}/a.Budget.branch`;
  assert.ok(branched.files.get(branch)!.length > 0);
  assert.deepEqual([...branched.files.keys()].filter((p) => !v.files.has(p)), [branch], "the branch is the only new file");

  // A device reading each copy, then writing the next snapshot (and checkpoint) from it.
  const live = async (w: ReturnType<typeof vault>) => {
    const b = new Ledger(w.io, () => "b", () => clock.now + 8 * DAY);
    const st = seen(await b.state(DATA));
    await b.write(DATA, [{ op: "add", l: "spend", row: "late", v: { amount: 1 } }]);
    await b.snapshot(DATA, {}, w.writeNote);
    const kept = Object.fromEntries([...w.files].filter(([p]) => p !== branch));
    return { st, after: seen(await b.state(DATA)), kept, note: JSON.stringify(w.fms.get(DATA)) };
  };
  const plain = await live(v);
  const withBranch = await live(branched);
  assert.deepEqual(withBranch.st, plain.st);
  assert.deepEqual(withBranch.after, plain.after);
  assert.ok(Object.keys(plain.kept).some((p) => p.includes("/checkpoint-b.json")), "b wrote a checkpoint");
  assert.deepEqual(withBranch.kept, plain.kept, "every log and checkpoint file the same");
  assert.equal(withBranch.note, plain.note, "the data note the same, its gizmo-hash and snapshot mark included");
  assert.ok(!withBranch.note.includes("950"));
});

test("the branch folds onto the live lists; its rows are marked as what-ifs, it writes only its own file, and Discard empties it", async () => {
  const { v, clock } = await history();
  const ahead = new Ledger(v.io, () => "a", () => clock.now, undefined, "Budget");
  const before = new Set(v.files.keys());
  const [event] = await ahead.write(DATA, [{ op: "add", l: "spend", row: "w1", v: { amount: 900 } }]);
  // Its events name the branch as their writer, so they can't share an id with the device's own.
  assert.match(event, /^a\.Budget@/);
  assert.deepEqual([...v.files.keys()].filter((p) => !before.has(p)), [`${logFolder(DATA)}/a.Budget.branch`]);
  const st = await ahead.state(DATA);
  const rows = st.lists.get("spend")!.rows;
  assert.equal(rows.length, 41);
  assert.deepEqual(rows.filter(isWhatIf).map((r) => rowIdOf(r)), ["w1"]);
  // The live ledger beside it never sees the what-if.
  const live = new Ledger(v.io, () => "a", () => clock.now);
  assert.equal((await live.state(DATA)).lists.get("spend")!.rows.length, 40);
  // Another device's branch isn't this one's.
  const other = new Ledger(v.io, () => "b", () => clock.now, undefined, "Budget");
  assert.equal((await other.state(DATA)).lists.get("spend")!.rows.length, 40);
  await ahead.discard(DATA);
  assert.equal(v.files.get(`${logFolder(DATA)}/a.Budget.branch`), "");
  assert.equal((await ahead.state(DATA)).lists.get("spend")!.rows.length, 40);
  // A data note with no branch file gets none from Discard.
  await ahead.discard("Apps/Other data.md");
  assert.ok(![...v.files.keys()].some((p) => p.startsWith("Apps/Other data/")));
});

test("a real change that syncs in while a what-if is open reaches the branch's lists", async () => {
  const { v, clock } = await history();
  const ahead = new Ledger(v.io, () => "a", () => clock.now, undefined, "Budget");
  await ahead.write(DATA, [{ op: "add", l: "spend", row: "w1", v: { amount: 900 } }]);
  assert.equal((await ahead.state(DATA)).lists.get("spend")!.rows.length, 41);
  const c = new Ledger(v.io, () => "c", () => clock.now + 1000);
  const [path] = await c.write(DATA, [{ op: "add", l: "spend", row: "c1", v: { amount: 3 } }]).then(() => [...v.files.keys()].filter((p) => p.includes("/c-")));
  ahead.fileChanged(path);
  const rows = (await ahead.state(DATA)).lists.get("spend")!.rows;
  assert.deepEqual(rows.slice(-2).map((r) => rowIdOf(r)), ["w1", "c1"]);
  assert.deepEqual(rows.filter(isWhatIf).map((r) => rowIdOf(r)), ["w1"]);
});

// ---- The app shown ahead ------------------------------------------------------------------------

const KIND = "Kinds/Spend.md";
const KIND_DATA = "Kinds/Spend data.md";
const APP = "Apps/Budget.md";
const SPEND = { kind: "spend", shortcut: "spend", fields: { amount: "number", category: ["food", "home", "travel"], memo: "text" } };
const BUDGET = {
  app: "Budget",
  panels: [
    { view: "number", title: "Spent this month", source: "[[Spend]]", field: "amount", agg: "sum", where: { at: "this month" }, alert: "> 1000" },
    { view: "form", title: "Spend", save: "[[Spend]]", label: "Add" },
    { view: "table", title: "Rows", source: "[[Spend]]", edit: ["amount"] },
  ],
};
/** The fake vault's now: Wed Nov 18 2026, 12:00. */
const NOW = new Date(2026, 10, 18, 12, 0);
const at = (m: number, d: number, h = 12, mi = 0) => stampOf(new Date(2026, m - 1, d, h, mi));
const END_OF_NOVEMBER = new Date(2026, 10, 30, 23, 59).getTime();

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const started: { dispose(): void }[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

/** Budget over the Spend kind, with 600 spent on Nov 5 and, when asked, a planned rent. */
async function budget(extra: Record<string, { fm: Record<string, unknown> }> = {}) {
  const t = fakeEnv({ [KIND]: { fm: SPEND }, [APP]: { fm: BUDGET }, ...extra });
  await t.env.store!(KIND_DATA, KIND).add("spend", { amount: 600, category: "home", memo: "rent", at: at(11, 5) });
  return t;
}

/** The app at `at` (end of November unless said), on a what-if layer that hears the vault's changes as the view's does. */
function ahead(t: ReturnType<typeof fakeEnv>, path = APP, when = END_OF_NOVEMBER, name = "Budget") {
  const data = new DataLayer(t.f.host, { like: t.data, ahead: { name, at: when } });
  data.ledger!.onWrite = (p) => {
    data.fileChanged(p);
    t.f.flush();
  };
  started.push({ dispose: t.data.follow(data) });
  const shown: number[] = [];
  let back = 0;
  const env = aheadEnv(t.env, data, when, { show: (x) => shown.push(x), back: () => { back++; } });
  return { env, data, shown, back: () => back };
}

function mount(env: AppEnv, path = APP) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, path, env);
  started.push(c);
  c.load();
  const big = (title: string) => text([...root.querySelectorAll(".gz-panel")].find((x) => x.textContent?.startsWith(title))?.querySelector(".gz-big"));
  const card = () => text(root.querySelector(".gz-ahead"));
  const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>(".gz-ahead button")].find((b) => b.textContent === label);
  return { root, big, card, button };
}

test("a what-if row added on the add line counts in every panel at the time shown, the forward list names the day the limit is crossed, and nothing real changes", async () => {
  const t = await budget();
  const live = mount(t.env);
  const a = ahead(t);
  const app = mount(a.env);
  await settle();
  assert.equal(app.big("Spent this month"), "600");
  assert.match(app.card(), new RegExp(`^What if: as of ${pastText(END_OF_NOVEMBER)}\\. Rows added here are what-ifs; nothing real changes until Keep\\.`));
  assert.match(app.card(), /No what-if rows yet/);
  const note = JSON.stringify(t.f.files.get(KIND_DATA)?.fm);
  const logs = [...t.f.others].filter(([p]) => p.endsWith(".jsonl"));
  typeLine(app.root, "900 travel flight @2026-11-25");
  assert.equal([...app.root.querySelectorAll(".gz-pv")].map(text).at(-1), "what ifWed Nov 25, 12:00");
  addLine(app.root, "900 travel flight @2026-11-25");
  await settle();
  assert.equal(said(app.root), "Added 900 to spend as a what-if for Wed Nov 25, 12:00; nothing real changed");
  assert.equal(app.big("Spent this month"), "1,500");
  assert.match(app.card(), /1 what-if row.*spend: 900 · travel · flight · Wed Nov 25, 12:00/);
  assert.match(app.card(), /On the way there“Spent this month” \(> 1000\) would go on Wed Nov 25/);
  // The row is a what-if, in the branch only: the live app, the data note and the logs are as they were.
  assert.equal(live.big("Spent this month"), "600");
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => r.amount), [600]);
  assert.equal(JSON.stringify(t.f.files.get(KIND_DATA)?.fm), note);
  assert.deepEqual([...t.f.others].filter(([p]) => p.endsWith(".jsonl")), logs);
  assert.deepEqual([...t.f.others.keys()].filter((p) => p.endsWith(".branch")), [`${logFolder(KIND_DATA)}/d1mac000.Budget.branch`]);
  // Nothing went to the activity log.
  assert.equal((await t.activity.list()).length, 0);
});

test("a button, and a panel with its own notify, say what they did was a what-if", async () => {
  const fm = {
    app: "b",
    panels: [
      { view: "number", title: "Spent this month", source: "[[Spend]]", field: "amount", agg: "sum", where: { at: "this month" } },
      { view: "button", label: "Coffee", save: "[[Spend]]", row: { amount: "4", category: "food" } },
      { view: "form", title: "Spend", save: "[[Spend]]", label: "Add", notify: "Spent {amount}" },
    ],
  };
  const t = await budget({ [APP]: { fm } });
  const app = mount(ahead(t).env);
  await settle();
  (app.root.querySelector("button.gz-verb") as HTMLButtonElement).click();
  await settle();
  assert.equal(said(app.root.querySelector(".gz-view-button")!), "Added to spend as a what-if; nothing real changed");
  addLine(app.root.querySelector(".gz-view-form")!, "12 food lunch");
  await settle();
  assert.equal(said(app.root.querySelector(".gz-view-form")!), "What if: Spent 12; nothing real changed");
  assert.equal(app.big("Spent this month"), "616");
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => r.amount), [600]);
});

test("the table's what-if rows can be changed and removed, which updates all of it; a real row can't be changed there", async () => {
  const t = await budget();
  const a = ahead(t);
  const app = mount(a.env);
  await settle();
  addLine(app.root, "900 travel flight @2026-11-25");
  await settle();
  const notes = whatIfNotes(readSpec(BUDGET, { notes: t.env.notes, path: APP })!.spec!, APP, "Apps/Budget data.md");
  const [r] = await whatIfRows(a.data.ledger!, notes, t.env.frontmatter);
  // Changing the what-if row's amount, as the table's edit does.
  const store = a.env.store!(KIND_DATA, KIND);
  await store.set("spend", { id: rowIdOf(r.row), shown: r.row }, "amount", 300);
  await settle();
  assert.equal(app.big("Spent this month"), "900");
  assert.match(app.card(), /None of the app's alerts or rules would go off/);
  // A real row is refused, in plain words.
  const [real] = (await store.rows("spend")).filter((x) => !isWhatIf(x));
  await assert.rejects(store.set("spend", { id: rowIdOf(real), shown: real }, "amount", 1), new RegExp(AHEAD));
  await assert.rejects(store.delete("spend", { id: rowIdOf(real), shown: real }), new RegExp(AHEAD));
  // Remove on the card takes the what-if away.
  [...app.root.querySelectorAll<HTMLButtonElement>(".gz-ahead-rows button")][0].click();
  await settle();
  assert.equal(app.big("Spent this month"), "600");
  assert.match(app.card(), /No what-if rows yet/);
});

test("a planned row counts at the time shown once its time has come; one a logged row settled, or one after the time shown, doesn't", async () => {
  const t = await budget();
  const ledger = t.data.ledger!;
  await ledger.write(KIND_DATA, [
    { op: "add", l: "spend", row: "p1", v: { amount: 200, category: "home", memo: "power", at: at(11, 24), line: "planned" } },
    // Settled by a row logged the month before, so it counts in no total of this month.
    { op: "add", l: "spend", row: "l2", v: { amount: 50, category: "food", memo: "lunch", at: at(10, 31) } },
    { op: "add", l: "spend", row: "p2", v: { amount: 50, category: "food", memo: "lunch", at: at(11, 10), line: "planned", matched: "l2" } },
    { op: "add", l: "spend", row: "p3", v: { amount: 70, category: "food", memo: "later", at: at(12, 2), line: "planned" } },
  ]);
  const live = mount(t.env);
  const end = mount(ahead(t).env);
  const before = mount(ahead(t, APP, new Date(2026, 10, 20, 23, 59).getTime()).env);
  await settle();
  assert.equal(live.big("Spent this month"), "600");
  assert.equal(end.big("Spent this month"), "800");
  assert.equal(before.big("Spent this month"), "600", "the power bill isn't due by the 20th");
});

test("ahead, a planned row whose time has come reads as logged in a formula too, as lines read it; one still to come stays planned", async () => {
  const fm = {
    app: "b",
    panels: [
      { view: "number", title: "Spent", source: "[[Spend]]", lines: ["logged", "planned"], compute: { spent: 'if(line == "planned", 0, amount)' }, field: "spent", agg: "sum" },
      { view: "number", title: "To come", source: "[[Spend]]", lines: ["logged", "planned"], compute: { left: 'if(line == "planned", amount, 0)' }, field: "left", agg: "sum" },
    ],
  };
  const t = await budget({ [APP]: { fm } });
  await t.data.ledger!.write(KIND_DATA, [
    { op: "add", l: "spend", row: "p1", v: { amount: 200, category: "home", memo: "power", at: at(11, 24), line: "planned" } },
    { op: "add", l: "spend", row: "p3", v: { amount: 70, category: "food", memo: "later", at: at(12, 2), line: "planned" } },
  ]);
  const live = mount(t.env);
  const end = mount(ahead(t).env);
  await settle();
  assert.deepEqual([live.big("Spent"), live.big("To come")], ["600", "270"]);
  assert.deepEqual([end.big("Spent"), end.big("To come")], ["800", "70"], "by the end of November the power bill has happened");
  // The row itself is as it was: still planned, for real.
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).find((r) => r.memo === "power")!.line, "planned");
});

test("Keep makes a kind's what-if rows planned rows, for real, in one undoable change, and empties the branch; a second Keep adds nothing", async () => {
  const t = await budget();
  const a = ahead(t);
  const app = mount(a.env);
  await settle();
  addLine(app.root, "900 travel flight @2026-11-25");
  await settle();
  const branch = `${logFolder(KIND_DATA)}/d1mac000.Budget.branch`;
  const saved = t.f.others.get(branch)!;
  const [whatIf] = (await a.env.store!(KIND_DATA, KIND).rows("spend")).filter(isWhatIf);
  app.button("Keep as planned")!.click();
  await settle();
  assert.match(app.card(), /Kept 1 row as planned\./);
  const rows = await t.env.store!(KIND_DATA, KIND).rows("spend");
  assert.deepEqual(rows.map((r) => [r.amount, r.line, r.at]), [[600, undefined, at(11, 5)], [900, "planned", at(11, 25)]]);
  assert.equal(rowIdOf(rows[1]), rowIdOf(whatIf), "under the what-if row's id");
  assert.equal(t.f.others.get(branch), "");
  // Still counted once at the time shown: now as a planned row.
  assert.equal(app.big("Spent this month"), "1,500");
  assert.match(app.card(), /No what-if rows yet/);
  const [entry] = await t.activity.list(APP);
  assert.equal(entry.what, "Kept a what-if row as planned");
  // A retry, or a Keep from a branch that wasn't emptied, finds the row there and adds nothing.
  t.f.others.set(branch, saved);
  a.data.fileChanged(branch);
  const notes = whatIfNotes(readSpec(BUDGET, { notes: t.env.notes, path: APP })!.spec!, APP, "Apps/Budget data.md");
  const shown = await whatIfRows(a.data.ledger!, notes, t.env.frontmatter);
  const again = await keep(a.env, APP, shown);
  assert.deepEqual([again.kept, again.already], [0, 1]);
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 2);
  // Undo takes the planned row back. Its id then stays out, as an undone add's does: the what-if
  // doesn't come back, and a Keep from a view still showing it adds nothing.
  await undoEntry(entry, t.undoIO);
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 1);
  t.f.others.set(branch, saved);
  a.data.fileChanged(branch);
  assert.deepEqual(await whatIfRows(a.data.ledger!, notes, t.env.frontmatter), []);
  const undone = await keep(a.env, APP, shown);
  assert.deepEqual([undone.kept, undone.gone], [0, 1]);
  assert.equal((await t.env.store!(KIND_DATA, KIND).rows("spend")).length, 1);
});

test("Discard empties the branch; for an app's own list Keep isn't offered, and the card says why", async () => {
  const OWN = { app: "Own", panels: [{ view: "number", title: "Total", source: "spend", field: "amount", agg: "sum" }, { view: "form", title: "Spent", save: "spend", fields: { amount: "number", memo: "text" } }] };
  const t = fakeEnv({ "Apps/Own.md": { fm: OWN } });
  const a = ahead(t, "Apps/Own.md", END_OF_NOVEMBER, "Own");
  const app = mount(a.env, "Apps/Own.md");
  await settle();
  addLine(app.root, "40 books @2026-11-28");
  await settle();
  assert.equal(app.big("Total"), "40");
  assert.match(app.card(), /Keep isn't offered for spend: planned rows need a kind\./);
  assert.equal(app.button("Keep as planned"), undefined);
  // A time after the one shown is a what-if too; it counts once its time comes.
  addLine(app.root, "60 tea @2026-12-04");
  await settle();
  assert.equal(app.big("Total"), "40");
  assert.match(app.card(), /tea · Fri Dec 4, 12:00 \(after .*, so not counted yet\)/);
  app.button("Discard")!.click();
  await settle();
  assert.equal(app.big("Total"), "0");
  assert.equal(t.f.others.get(`Apps/Own data/log/d1mac000.Own.branch`), "");
  assert.equal(t.f.files.get("Apps/Own data.md"), undefined, "no data note was made");
});

test("ahead, nothing but rows is written: a checklist, a save: this form and a note can't be changed, and say so", async () => {
  const MIXED = {
    app: "Mixed",
    panels: [
      { view: "checklist", title: "Packed", items: ["Passport"] },
      { view: "form", title: "Mood", save: "this", fields: { mood: ["ok", "good"] } },
      { view: "button", title: "Log", label: "Log", append: "Daily" },
    ],
  };
  const t = fakeEnv({ "Apps/Mixed.md": { fm: MIXED } });
  const a = ahead(t, "Apps/Mixed.md", END_OF_NOVEMBER, "Mixed");
  const app = mount(a.env, "Apps/Mixed.md");
  await settle();
  app.root.querySelector(".gz-view-checklist input[type=checkbox]")!.dispatchEvent(new window.Event("change"));
  await settle();
  assert.ok(t.notices.some((n) => n === `Couldn't save: ${AHEAD}`), t.notices.join(" | "));
  assert.deepEqual(t.writes, []);
  assert.equal(t.f.files.get("Daily.md"), undefined);
});

test("web panels read the latest answer kept, and one with a secret says it can't be read, as the past does; the banner names them", async () => {
  const RAIN = "https://api.example.com/rain";
  const WEATHER = {
    app: "Weather",
    panels: [
      { view: "number", title: "Rain", source: RAIN, pick: "rain" },
      { view: "number", title: "Secret", source: "https://api.example.com/x?k={secret:demo}", pick: "x" },
      { view: "list", title: "Notes", source: "notes", from: "Notes", item: "{name}" },
    ],
  };
  const t = fakeEnv({ "Apps/W.md": { fm: { ...WEATHER, secrets: ["demo"] } } }, { [RAIN]: { rain: 9 } });
  await t.f.keep(cacheKey(RAIN, undefined), JSON.stringify({ rain: 2 }), 1_000_000);
  const app = mount(ahead(t, "Apps/W.md", END_OF_NOVEMBER, "W").env, "Apps/W.md");
  await settle();
  assert.equal(app.big("Rain"), "2");
  assert.match(text(app.root.querySelector(".gz-error")), /answers aren't kept: the request uses a secret or sends a body/);
  assert.match(app.card(), /Shown as they are now: Notes\. Shown with the latest answer kept: Rain, Secret\./);
  assert.deepEqual(t.f.requests, [], "nothing asked of the network");
});

test("the time shown first is the end of the headline's window, moved on to the latest what-if row's, never more than a year ahead", () => {
  const read = (fm: Record<string, unknown>) => readSpec(fm, { path: APP, notes: { resolve: () => KIND, frontmatter: () => SPEND } })!.spec as AppSpec;
  const now = NOW.getTime();
  assert.equal(defaultHorizon(read(BUDGET), now), END_OF_NOVEMBER);
  assert.equal(defaultHorizon(read(BUDGET), now, new Date(2026, 11, 3, 12).getTime()), new Date(2026, 11, 31, 23, 59).getTime());
  const weekly = { ...BUDGET, panels: [{ ...BUDGET.panels[0], where: { at: "this week" } }] };
  assert.equal(defaultHorizon(read(weekly), now), new Date(2026, 10, 22, 23, 59).getTime(), "Sunday's last minute");
  const plain = { app: "Plain", panels: [{ view: "table", source: "spend" }] };
  assert.equal(defaultHorizon(read(plain), now), END_OF_NOVEMBER, "the end of the month when it reads no window");
  assert.equal(defaultHorizon(read(BUDGET), now, now + 2 * AHEAD_MS), now + AHEAD_MS);
});

test("the look ahead keeps its earliest steps when there are too many, steps at each midnight and deadline where the person is, and names a then", async () => {
  const RHYTHM = { ...BUDGET, expect: [{ id: "log", every: "day", by: "10:00", source: "[[Spend]]", say: "nothing spent by 10:00", then: { app: "[[Errands]]", do: "add" } }] };
  const t = await budget({ [APP]: { fm: RHYTHM } });
  const a = ahead(t, APP, new Date(2026, 10, 20, 23, 59).getTime());
  const spec = readSpec(RHYTHM, { path: APP, notes: t.env.notes, now: NOW })!.spec!;
  const files = { appPath: APP, dataPath: "Apps/Budget data.md" };
  const notes = whatIfNotes(spec, APP, files.dataPath);
  const zone = "Asia/Tokyo";
  const env = { ...a.env, ahead: { ...a.env.ahead!, zone } };
  const r = (await lookAhead(env, t.data, spec, files, notes))!;
  const tokyo = (d: number) => calendarOf(zone).at(2026, 10, d, 10, 0);
  // Tokyo's 10:00 on the 19th and 20th come after now and by the 20th's end here; the 21st's may too, by zone.
  assert.deepEqual(r.after.map((f) => f.at).slice(0, 2), [tokyo(19), tokyo(20)].filter((x) => x > NOW.getTime()).slice(0, 2));
  assert.deepEqual(aheadLines(r, spec, NOW)[0].replace(/\d+ times, first \w+ \w+ \d+/, "N"), "“nothing spent by 10:00” would be told N; it would run “add” in Errands");
  // Far more what-if times than steps allowed: the nearest are kept.
  const many = Array.from({ length: MAX_STEPS + 500 }, (_, i) => NOW.getTime() + (i + 1) * 1000);
  const ledger = a.data.ledger!;
  const rows = many.slice(0, 1).map((x) => ({ op: "add" as const, l: "spend", row: `w${x}`, v: { amount: 1, at: stampOf(new Date(x)), line: "planned" } }));
  await ledger.write(KIND_DATA, rows);
  const { backtest } = await import("../src/backtest.ts");
  const cut = (await backtest({ layer: a.data, appPath: APP, dataPath: files.dataPath, after: spec, to: END_OF_NOVEMBER, ahead: { from: NOW.getTime(), times: many } }))!;
  assert.equal(cut.steps, MAX_STEPS);
  assert.equal(cut.cut, true);
  assert.equal(cut.from, NOW.getTime());
  assert.equal(cut.to, many[MAX_STEPS - 2], "the earliest kept, the last of them the end");
});

test("a Do… line that starts with what if reads as Do… does, a time still to come allowed on any shortcut, and saves a what-if row through it", async () => {
  assert.equal(whatIfLine("what if spend 900 travel flight @2026-12-03"), "spend 900 travel flight @2026-12-03");
  assert.equal(whatIfLine("What If  spend 1"), "spend 1");
  assert.equal(whatIfLine("spend 900"), undefined);
  assert.equal(whatIfLine("whatif spend"), undefined);
  const t = await budget();
  const kindSpec = readSpec(SPEND, { path: KIND, notes: t.env.notes })!.spec!;
  const index = captureTargets([{ path: KIND, name: "Spend", shortcuts: new Map(kindSpec.panels.filter((ps) => ps.panel.shortcut).map((ps) => [ps.panel.shortcut!, ps])) }]);
  const p = parseWhatIf("spend 900 travel flight @2026-12-03", index, NOW);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.at?.getTime(), new Date(2026, 11, 3, 12, 0).getTime());
  const a = ahead(t);
  const done = await addWhatIf(a.env, { path: KIND, dataPath: KIND_DATA, spec: kindSpec, shortcut: p.target.shortcut }, p.params!, NOW);
  assert.deepEqual(done, { ok: true });
  const rows = (await a.env.store!(KIND_DATA, KIND).rows("spend")).filter(isWhatIf);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ amount: 900, category: "travel", memo: "flight", at: at(12, 3), line: "planned" }]);
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => r.amount), [600]);
  // Without @, the row is for now.
  const now = parseWhatIf("spend 5 food tea", index, NOW);
  assert.ok(now.ok);
  await addWhatIf(a.env, { path: KIND, dataPath: KIND_DATA, spec: kindSpec, shortcut: now.target.shortcut }, now.params!, NOW);
  assert.equal((await a.env.store!(KIND_DATA, KIND).rows("spend")).filter(isWhatIf).at(-1)!.at, stampOf(NOW));
  await discard(a.env, whatIfNotes(kindSpec, KIND, KIND_DATA));
  assert.equal((await a.env.store!(KIND_DATA, KIND).rows("spend")).filter(isWhatIf).length, 0);
});

test("a shortcut or alias can't be what, nor an alias start with what if: Do… reads that line as a what-if", () => {
  const WHY = 'Do… reads a line that starts with "what if" as a what-if';
  const errors = (panel: Record<string, unknown>) => readSpec({ app: "x", panels: [{ view: "form", save: "log", fields: { n: "number" }, ...panel }] }, { path: APP })!.errors;
  assert.deepEqual(errors({ shortcut: "what" }), [`panel 1: shortcut can't be "what": ${WHY}`]);
  assert.deepEqual(errors({ alias: "What" }), [`panel 1: alias can't be "What": ${WHY}`]);
  assert.deepEqual(errors({ alias: "what if" }), [`panel 1: alias can't be "what if": ${WHY}`]);
  assert.deepEqual(errors({ alias: "What if I ate" }), [`panel 1: alias can't be "What if I ate": ${WHY}`]);
  for (const fine of [{ shortcut: "what-if" }, { shortcut: "whatever" }, { alias: "what now" }, { alias: "whatif" }]) assert.deepEqual(errors(fine), [], JSON.stringify(fine));
  const kind = readSpec({ ...SPEND, shortcut: "what" }, { path: KIND })!;
  assert.deepEqual(kind.errors, [`shortcut can't be "what": ${WHY}`]);
  assert.deepEqual(kind.spec!.panels.map((ps) => ps.panel.view), ["form", "table"], "the kind still shows, its line without the word");
  assert.equal(kind.spec!.panels[0].panel.shortcut, undefined);
});

// ---- The time rail, reaching ahead -------------------------------------------------------------

test("ahead, the rail reaches a third again past the time shown; a drag past now picks a day's last minute, near now is now, before it a change", () => {
  const now = NOW.getTime();
  const at = END_OF_NOVEMBER;
  const end = aheadEnd(now, at);
  assert.equal(end, at + Math.round((at - now) / 3));
  assert.equal(aheadEnd(now, now + 3_600_000), now + 3_600_000 + 3 * DAY, "three days at least");
  assert.equal(aheadEnd(now, now + AHEAD_MS), now + AHEAD_MS, "a year at most");
  const m = railModel([], now, end);
  assert.equal(snapAhead(m, new Date(2026, 10, 25, 9).getTime()), new Date(2026, 10, 25, 23, 59).getTime());
  assert.equal(snapAhead(m, now + 1000), undefined);
  assert.equal(snapAhead(m, end + DAY), end, "never past the track's end");
  assert.equal(snapAhead(m, now - 10 * DAY), m.start, "before now, the window's start when nothing changed");
  assert.equal(stepAhead(m, at, -1), new Date(2026, 10, 29, 23, 59).getTime());
  assert.equal(stepAhead(m, at, 1), new Date(2026, 11, 1, 23, 59).getTime());
  assert.equal(stepAhead(m, new Date(2026, 10, 19, 23, 59).getTime(), -1), new Date(2026, 10, 18, 23, 59).getTime(), "today's last minute is still ahead");
  assert.equal(stepAhead(m, new Date(2026, 10, 18, 23, 59).getTime(), -1), undefined, "back past today is now");
  assert.equal(aheadLabel(new Date(2026, 10, 19, 23, 59).getTime(), now).slice(0, 23), "What if, as of Tomorrow");
  assert.match(aheadLabel(at, now), /^What if, as of Mon Nov 30, /);
});

test("the rail shown ahead marks the what-if rows, says how many, puts its handle at the time shown, and steps a day at a time", async () => {
  const now = NOW.getTime();
  const pastShown: (number | undefined)[] = [];
  const r = new TimeRail((t) => pastShown.push(t), now);
  document.body.appendChild(r.el);
  r.update([], now);
  const aheadShown: number[] = [];
  const nov25 = new Date(2026, 10, 25, 12).getTime();
  r.ahead(END_OF_NOVEMBER, [nov25], (t) => aheadShown.push(t), now);
  const q = (sel: string) => r.el.querySelector<HTMLElement>(sel);
  assert.ok(r.el.classList.contains("is-ahead"));
  assert.equal(q(".gz-rail-label")?.textContent, aheadLabel(END_OF_NOVEMBER, now));
  assert.equal(q(".gz-rail-count")?.textContent, "1 what-if row");
  assert.equal(r.el.querySelectorAll(".gz-rail-mark").length, 1);
  const m = railModel([], now, aheadEnd(now, END_OF_NOVEMBER));
  const pctOf = (t: number) => Math.round(((t - m.start) / (m.end! - m.start)) * 100 * 1000) / 1000;
  assert.equal(q(".gz-rail-handle")?.style.left, `${pctOf(END_OF_NOVEMBER)}%`);
  assert.equal(q(".gz-rail-mark")?.style.left, `${pctOf(nov25)}%`);
  assert.deepEqual([...r.el.querySelectorAll(".gz-rail-scale span")].map((x) => x.textContent), ["Oct 20", "Today", "Dec 5"]);
  r.mark([]);
  assert.equal(q(".gz-rail-count")?.textContent, "No what-if rows");
  r.step(-1);
  await new Promise((done) => setTimeout(done, STEP_MS + 50));
  assert.deepEqual(aheadShown, [new Date(2026, 10, 29, 23, 59).getTime()]);
  q("button.gz-rail-now")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(pastShown, [undefined], "Back to now");
  r.sync(undefined);
  assert.ok(!r.el.classList.contains("is-ahead"));
  assert.equal(r.el.querySelectorAll(".gz-rail-mark").length, 0);
  r.dispose();
  r.el.remove();
});

test("a streak counts the days a what-if fills on the way to the time shown, as the clock moved there", async () => {
  const HABIT = { app: "Habit", panels: [{ view: "number", title: "Streak", source: "[[Spend]]", group: "at", per: "day", agg: "streak" }, { view: "form", title: "Spend", save: "[[Spend]]", label: "Add" }] };
  const t = fakeEnv({ [KIND]: { fm: SPEND }, "Apps/Habit.md": { fm: HABIT } });
  for (const d of [17, 18]) await t.env.store!(KIND_DATA, KIND).add("spend", { amount: 1, category: "food", memo: "tea", at: at(11, d, 9) });
  const live = mount(t.env, "Apps/Habit.md");
  const a = ahead(t, "Apps/Habit.md", new Date(2026, 10, 20, 23, 59).getTime(), "Habit");
  const app = mount(a.env, "Apps/Habit.md");
  await settle();
  // Shown at the 20th, with nothing after today the run is broken.
  assert.equal(app.big("Streak"), "0");
  addLine(app.root, "1 food tea @2026-11-19 09:00");
  await settle();
  addLine(app.root, "1 food tea @2026-11-20 09:00");
  await settle();
  assert.equal(app.big("Streak"), "4");
  assert.equal(live.big("Streak"), "2");
});

test("ahead, a table's edit or delete of a real row is refused in plain words and the table shows the row as it is again", async () => {
  const { AppWrites } = await import("../src/app-writes.ts");
  const t = await budget();
  const a = ahead(t);
  // Budget saves to Spend, so it asks to change Spend's rows.
  const site = { appPath: APP, hostPath: APP, dataPath: () => "Apps/Budget data.md", checklistName: (k: string) => k, expect: () => [], writesKind: () => true };
  const table = readSpec(BUDGET, { notes: t.env.notes, path: APP })!.spec!.panels[2].panel;
  const [real] = await a.env.store!(KIND_DATA, KIND).rows("spend");
  let reloads = 0;
  await new AppWrites(a.env, site).editRow({ p: table }, real, "amount", 1, () => { reloads++; });
  assert.deepEqual([t.notices, reloads], [[`Couldn't save: ${AHEAD}`], 1]);
  assert.equal(await new AppWrites(a.env, site).deleteRow({ p: table }, real, () => {}), undefined);
  assert.deepEqual(t.notices.at(-1), `Couldn't delete: ${AHEAD}`);
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => r.amount), [600]);
});

test("Keep keeps the rows the card showed as they are when it runs, and only those leave the branch: a what-if added meanwhile stays one", async () => {
  const t = await budget();
  const a = ahead(t);
  const store = a.env.store!(KIND_DATA, KIND);
  await store.add("spend", { amount: 900, category: "travel", memo: "flight", at: at(11, 25) });
  const notes = whatIfNotes(readSpec(BUDGET, { notes: t.env.notes, path: APP })!.spec!, APP, "Apps/Budget data.md");
  const shown = await whatIfRows(a.data.ledger!, notes, t.env.frontmatter);
  // While Keep is on its way: the row shown is changed, and another what-if is added.
  await store.set("spend", { id: rowIdOf(shown[0].row), shown: shown[0].row }, "amount", 950);
  await store.add("spend", { amount: 40, category: "food", memo: "dinner", at: at(11, 27) });
  const k = await keep(a.env, APP, shown);
  assert.equal(k.kept, 1);
  assert.deepEqual((await t.env.store!(KIND_DATA, KIND).rows("spend")).map((r) => [r.amount, r.line]), [[600, undefined], [950, "planned"]]);
  assert.deepEqual((await whatIfRows(a.data.ledger!, notes, t.env.frontmatter)).map((r) => r.row.memo), ["dinner"]);
});

test("two apps of one name in two folders keep two what-ifs", () => {
  assert.notEqual(branchName("Work/Budget.md"), branchName("Home/Budget.md"));
  assert.match(branchName("Work/Budget.md"), /^Budget-[0-9a-f]{8}$/);
});
