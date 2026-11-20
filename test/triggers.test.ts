import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeActor } from "../src/activity.ts";
import { AppController } from "../src/app.ts";
import { MAX_RUNS_PER_HOUR } from "../src/background.ts";
import { readSpec } from "../src/spec.ts";
import { describePermission, permissionsOf } from "../src/permissions.ts";
import { fakeBackground } from "./support/fakes.ts";
import { vaultNote } from "./support/yaml.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };

type Notes = Parameters<typeof fakeBackground>[0];

/** An inbox whose form adds a task, by shortcut. */
const INBOX = { app: "Inbox", panels: [{ view: "form", title: "Add", fields: { task: "text", due: "date" }, save: "todo", shortcut: "add" }] };
const tasks = (t: ReturnType<typeof fakeBackground>) => t.f.files.get("Apps/Inbox data.md")?.fm?.todo as Record<string, unknown>[] | undefined;

/** Renewals: deadlines, and a number counting those due within two weeks that adds a task for each new one. */
function renewals(deadlines: Record<string, unknown>[], then: Record<string, unknown> = { app: "[[Inbox]]", do: "add", fill: { task: "Renew {what}", due: "{due}" } }): Notes {
  return {
    "Apps/Renewals.md": {
      fm: {
        app: "Renewals",
        data: { deadlines: { source: "deadlines", compute: { days: "days(today(), due)" } } },
        panels: [{ view: "number", title: "Due soon", source: "deadlines", agg: "count", alert: { days: "<= 14" }, then }],
      },
    },
    "Apps/Renewals data.md": { fm: { deadlines } },
    "Apps/Inbox.md": { fm: INBOX },
  };
}

test("then asks to run the shortcut it names, by the name typed, and is checked where it's written", () => {
  const read = (fm: Record<string, unknown>, host?: { scope: string }) => readSpec({ app: "x", ...fm }, { path: "Apps/X.md", host });
  const ok = read({ panels: [{ view: "button", label: "Go", row: { who: "Mom" }, then: { app: "[[Task inbox]]", do: "add", fill: { task: "Call {who}" } } }] })!;
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(permissionsOf(ok.spec!, "Apps/X.md"), ["run:Task inbox#add"]);
  assert.equal(describePermission("run:Task inbox#add"), "Run “add” in Task inbox");
  assert.deepEqual(ok.spec!.panels[0].panel.then, { app: "[[Task inbox]]", do: "add", fill: { task: "Call {who}" } });

  const errors = (fm: Record<string, unknown>, host?: { scope: string }) => read(fm, host)!.errors;
  assert.deepEqual(errors({ panels: [{ view: "number", source: "x", then: { app: "A", do: "go" } }] }), ["panel 1: then on a number needs alert: it runs when the alert turns true"]);
  assert.deepEqual(errors({ panels: [{ view: "button", then: { app: "A", do: "Go Now" } }] }), ["panel 1: then: do must be the other app's shortcut: lowercase letters, digits and -"]);
  assert.deepEqual(errors({ panels: [{ view: "button", then: { app: "[[]]", do: "go" } }] }), ['panel 1: then: app must name an app, e.g. "[[Task inbox]]"']);
  assert.match(errors({ panels: [{ view: "button", then: { app: "A" } }] })[0], /"then" has the wrong type/);
  assert.match(errors({ panels: [{ view: "button", then: { app: "A", do: "go", when: "now" } }] })[0], /"then" has the wrong type/);
  assert.match(errors({ panels: [{ view: "table", source: "x", alert: { n: "> 1" }, then: { app: "A", do: "go" } }] })[0], /"then" doesn't apply to table/);
  assert.deepEqual(errors({ panels: [{ view: "button", then: { app: "A", do: "go" } }] }, { scope: "Books" }), ["panel 1: then works in an app note, not in an embed or a lens"]);
});

test("a shortcut's then fills the other app's form from the row it saved, and both runs are kept as theirs", async () => {
  const t = fakeBackground({
    "Apps/Calls.md": { fm: { app: "Calls", panels: [{ view: "form", fields: { who: "text" }, save: "calls", shortcut: "call", then: { app: "[[Inbox]]", do: "add", fill: { task: "Call {who} back", due: "{date}" } } }] } },
    "Apps/Inbox.md": { fm: INBOX },
  });
  await t.bg.start();
  await t.bg.runUri({ app: "Calls", do: "call", who: "Mom" });
  assert.deepEqual(tasks(t), [{ task: "Call Mom back", due: "2026-11-18", at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.notices, ["Calls: call done", "Inbox: Add done for Calls"]);
  const log = await t.activity.list();
  assert.deepEqual(log.map((e) => [e.app, describeActor(e.actor)]), [["Apps/Calls.md", "A link"], ["Apps/Inbox.md", "Triggered by Calls"]].reverse());
});

test("then never opens an app: a form without fill, a button given fill, a missing or unallowed app are told", async () => {
  const go = (then: Record<string, unknown>) => ({ view: "button", label: "Go", shortcut: "go", then });
  const t = fakeBackground({
    "Apps/A.md": { fm: { app: "A", panels: [go({ app: "Inbox", do: "add" })] } },
    "Apps/B.md": { fm: { app: "B", panels: [go({ app: "C", do: "ping", fill: { x: "1" } })] } },
    "Apps/C.md": { fm: { app: "C", panels: [{ view: "button", label: "Ping", save: "pings", shortcut: "ping" }] } },
    "Apps/D.md": { fm: { app: "D", panels: [go({ app: "[[Nowhere]]", do: "add" })] } },
    "Apps/E.md": { fm: { app: "E", panels: [go({ app: "Inbox", do: "add", fill: { task: "x" } })] } },
    "Apps/Inbox.md": { fm: INBOX },
  });
  await t.bg.start();
  for (const app of ["A", "B", "D"]) await t.bg.runCommand(`Apps/${app}.md:go`);
  t.denied.add("Apps/Inbox.md");
  await t.bg.runCommand("Apps/E.md:go");
  assert.deepEqual(t.notices, [
    "A: Go done",
    "Inbox: “add” is a form; give A's then a fill with its values",
    "B: Go done",
    "C: “ping” is a button and takes no values; take fill out of B's then",
    "D: Go done",
    "D: no app called “Nowhere” to run “add” in",
    "E: Go done",
    "Open Inbox once to allow it",
  ]);
  assert.deepEqual(t.out.apps, [], "nothing was opened");
  assert.equal(tasks(t), undefined);
});

test("then stops a loop between apps, a chain longer than four, and one that runs too often in an hour", async () => {
  const hop = (name: string, next: string) => ({ fm: { app: name, panels: [{ view: "button", label: "Hop", save: "hops", shortcut: "hop", then: { app: next, do: "hop" } }] } });
  const t = fakeBackground({ "Apps/A.md": hop("A", "B"), "Apps/B.md": hop("B", "A") });
  await t.bg.start();
  await t.bg.runCommand("Apps/A.md:hop");
  assert.deepEqual(t.notices, ["A: Hop done", "B: Hop done for A", "B: stopped a loop: A → B → A"]);

  const u = fakeBackground({ "Apps/A.md": hop("A", "B"), "Apps/B.md": hop("B", "C"), "Apps/C.md": hop("C", "D"), "Apps/D.md": hop("D", "E"), "Apps/E.md": hop("E", "F") });
  await u.bg.start();
  await u.bg.runCommand("Apps/A.md:hop");
  assert.deepEqual(u.notices.at(-1), "D: stopped after 4 apps in a row: A → B → C → D → E");
  assert.equal(u.f.files.get("Apps/E data.md"), undefined);

  const v = fakeBackground({ "Apps/A.md": hop("A", "B"), "Apps/B.md": { fm: { app: "B", panels: [{ view: "button", label: "Hop", save: "hops", shortcut: "hop" }] } } });
  await v.bg.start();
  for (let i = 0; i <= MAX_RUNS_PER_HOUR; i++) await v.bg.runCommand("Apps/A.md:hop");
  assert.equal((v.f.files.get("Apps/B data.md")?.fm?.hops as unknown[]).length, MAX_RUNS_PER_HOUR);
  assert.equal(v.notices.at(-1), `A: stopped running “hop” in B: it ran ${MAX_RUNS_PER_HOUR} times this hour`);
  v.advance(3_600_001);
  await v.bg.runCommand("Apps/A.md:hop");
  assert.equal((v.f.files.get("Apps/B data.md")?.fm?.hops as unknown[]).length, MAX_RUNS_PER_HOUR + 1, "an hour on, it runs again");
});

test("a row alert's then runs once for each row that newly matches, never for what was due when it started, nor again after a restart", async () => {
  const passport = { what: "passport", due: "2026-11-25", at: "2026-10-01T09:00" };
  const t = fakeBackground(renewals([passport, { what: "lease", due: "2027-06-01", at: "2026-10-02T09:00" }]));
  await t.bg.start();
  await settle();
  assert.equal(tasks(t), undefined, "already due when it started: noted, not run");
  assert.deepEqual(t.notices, ["Renewals: Due soon (1 row)"]);

  const fm = t.f.files.get("Apps/Renewals data.md")!.fm!;
  const insurance = { what: "insurance", due: "2026-11-30", at: "2026-11-18T12:00" };
  fm.deadlines = [...fm.deadlines as unknown[], insurance];
  t.changed("Apps/Renewals data.md");
  await settle();
  assert.deepEqual(tasks(t), [{ task: "Renew insurance", due: "2026-11-30", at: "2026-11-18T12:00" }]);

  // Checked again, with nothing new: nothing runs.
  t.changed("Apps/Renewals data.md");
  await settle();
  assert.equal(tasks(t)!.length, 1);

  // A restart with the same vault: what ran is remembered.
  // The vault as it is, the Inbox's ledger with it.
  const logs = Object.fromEntries([...t.f.others].map(([path, raw]) => [path, { raw }]));
  const again = fakeBackground({ ...renewals([]), ...logs, "Apps/Renewals data.md": t.f.files.get("Apps/Renewals data.md")!, "Apps/Inbox data.md": t.f.files.get("Apps/Inbox data.md")! }, {}, { triggers: t.triggers });
  await again.bg.start();
  await settle();
  assert.equal(tasks(again)!.length, 1);

  // A row that stops matching and matches again runs again.
  const moved = again.f.files.get("Apps/Renewals data.md")!.fm!;
  moved.deadlines = (moved.deadlines as Record<string, unknown>[]).map((d) => (d.what === "passport" ? { ...d, due: "2027-02-01" } : d));
  again.changed("Apps/Renewals data.md");
  await settle();
  moved.deadlines = (moved.deadlines as Record<string, unknown>[]).map((d) => (d.what === "passport" ? { ...d, due: "2026-11-28" } : d));
  again.changed("Apps/Renewals data.md");
  await settle();
  assert.deepEqual(tasks(again)!.map((r) => r.task), ["Renew insurance", "Renew passport"]);
});

test("two runners at once (a handover not yet heard of) run a row's then on both, and it saves one row", async () => {
  const passport = { what: "passport", due: "2026-11-25", at: "2026-10-01T09:00" };
  const t = fakeBackground(renewals([passport]));
  await t.bg.start();
  await settle();
  // What the other runner kept: the passport noted, nothing since.
  const noted = t.triggers.text;
  const fm = t.f.files.get("Apps/Renewals data.md")!.fm!;
  fm.deadlines = [passport, { what: "insurance", due: "2026-11-30", at: "2026-11-18T12:00" }];
  t.changed("Apps/Renewals data.md");
  await settle();
  assert.equal(tasks(t)!.length, 1);
  // The other device, on the same files, sees the new row as new too and runs the then itself.
  const logs = Object.fromEntries([...t.f.others].map(([path, raw]) => [path, { raw }]));
  const other = fakeBackground({ ...renewals([]), ...logs, "Apps/Renewals data.md": t.f.files.get("Apps/Renewals data.md")!, "Apps/Inbox data.md": t.f.files.get("Apps/Inbox data.md")! }, {}, { triggers: { text: noted } });
  other.f.host.device = () => "phone000";
  await other.bg.start();
  await settle();
  assert.ok(other.notices.includes("Inbox: Add done for Renewals"), "the other runner ran it too");
  const rows = (await other.data.ledger!.state("Apps/Inbox data.md")).lists.get("todo")!.rows;
  assert.deepEqual(rows.map((r) => r.task), ["Renew insurance"]);
});

test("editing an alert's then, or allowing the app, notes what is due without running it", async () => {
  const t = fakeBackground(renewals([{ what: "passport", due: "2026-11-25", at: "2026-10-01T09:00" }]));
  t.denied.add("Apps/Renewals.md");
  await t.bg.start();
  await settle();
  t.denied.delete("Apps/Renewals.md");
  t.bg.opened("Apps/Renewals.md");
  await settle();
  assert.equal(tasks(t), undefined, "allowed with one already due: nothing runs");

  const app = t.f.files.get("Apps/Renewals.md")!.fm!;
  const panel = (app.panels as Record<string, unknown>[])[0];
  app.panels = [{ ...panel, then: { app: "[[Inbox]]", do: "add", fill: { task: "Sort out {what}" } } }];
  t.changed("Apps/Renewals.md");
  await settle();
  assert.equal(tasks(t), undefined, "an edited then starts over");
});

test("a value alert's then runs when the value crosses, with {value}", async () => {
  const notes: Notes = {
    "Apps/Spend.md": {
      fm: {
        app: "Spend",
        panels: [{ view: "number", title: "Spent", source: "spend", field: "amount", agg: "sum", alert: "> 100", then: { app: "Inbox", do: "add", fill: { task: "Spent {value} this month" } } }],
      },
    },
    "Apps/Spend data.md": { fm: { spend: [{ amount: 120, at: "2026-11-01T09:00" }] } },
    "Apps/Inbox.md": { fm: INBOX },
  };
  const t = fakeBackground(notes);
  await t.bg.start();
  await settle();
  assert.equal(tasks(t), undefined, "already over at the start");
  t.f.files.get("Apps/Spend data.md")!.fm!.spend = [{ amount: 50, at: "2026-11-01T09:00" }];
  t.changed("Apps/Spend data.md");
  await settle();
  t.f.files.get("Apps/Spend data.md")!.fm!.spend = [{ amount: 50, at: "2026-11-01T09:00" }, { amount: 70.5, at: "2026-11-18T12:00" }];
  t.changed("Apps/Spend data.md");
  await settle();
  assert.deepEqual(tasks(t)!.map((r) => r.task), ["Spent 120.5 this month"]);
});

test("a form in an open app runs its then once it has saved", async () => {
  const t = fakeBackground({
    "Apps/Calls.md": { fm: { app: "Calls", panels: [{ view: "form", fields: { who: "text" }, save: "calls", then: { app: "[[Inbox]]", do: "add", fill: { task: "Call {who} back" } } }] } },
    "Apps/Inbox.md": { fm: INBOX },
  });
  await t.bg.start();
  t.env.trigger = (from, then, ctx) => t.bg.runThen(from, then, ctx);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, "Apps/Calls.md", t.env);
  c.load();
  await settle();
  (root.querySelector("input") as HTMLInputElement).value = "Sam";
  root.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  c.dispose();
  assert.deepEqual(t.f.files.get("Apps/Calls data.md")?.fm?.calls, [{ who: "Sam", at: "2026-11-18T12:00" }]);
  assert.deepEqual(tasks(t)!.map((r) => r.task), ["Call Sam back"]);
});

test("the test vault's Calls adds a call-back errand to Errands, and one for each call-back that goes overdue", async () => {
  const notes: Notes = { "Apps/Calls.md": { fm: vaultNote("Apps/Calls.md").fm }, "Apps/Errands.md": { fm: vaultNote("Apps/Errands.md").fm } };
  const t = fakeBackground(notes);
  assert.deepEqual(permissionsOf(readSpec(notes["Apps/Calls.md"].fm, { path: "Apps/Calls.md" })!.spec!, "Apps/Calls.md"), ["run:Errands#add"]);
  await t.bg.start();
  await settle();
  await t.bg.runUri({ action: "gizmo", app: "Calls", do: "log", who: "Sam", back: "2026-11-20" });
  const errands = () => (t.f.files.get("Apps/Errands data.md")?.fm?.errands as Record<string, unknown>[] | undefined)?.map((e) => e.errand);
  assert.deepEqual(errands(), ["Call Sam back by 2026-11-20"]);
  t.advance(3 * 86_400_000);
  t.changed("Apps/Calls data.md");
  await settle();
  assert.deepEqual(errands(), ["Call Sam back by 2026-11-20", "Overdue: call Sam"]);
});

test("then names its app as a link does: two notes of that name go to the one the link finds from the app, not a refusal", async () => {
  const t = fakeBackground({
    "Apps/Calls.md": { fm: { app: "Calls", panels: [{ view: "button", label: "Call", save: "calls", shortcut: "call", then: { app: "[[Inbox]]", do: "add", fill: { task: "Call back" } } }] } },
    "Apps/Inbox.md": { fm: INBOX },
    "Old/Inbox.md": { fm: INBOX },
    "Notes/Plain.md": { fm: { tags: ["x"] } },
    "Apps/Points.md": { fm: { app: "Points", panels: [{ view: "button", label: "Go", shortcut: "go", then: { app: "[[Plain]]", do: "add", fill: { task: "x" } } }] } },
  });
  await t.bg.start();
  await t.bg.runCommand("Apps/Calls.md:call");
  assert.deepEqual(tasks(t)?.map((r) => r.task), ["Call back"]);
  assert.equal(t.f.files.get("Old/Inbox data.md"), undefined);
  await t.bg.runCommand("Apps/Points.md:go");
  assert.deepEqual(t.notices, ["Calls: Call done", "Inbox: Add done for Calls", "Points: Go done", "Points: “Plain” isn't an app, so it can't run “add”"]);
});

test("then's fill is checked where it's written: a secret, or on a form or button a {name} the run never has, is an error", () => {
  const errors = (panel: Record<string, unknown>) => readSpec({ app: "x", panels: [panel] }, { path: "Apps/X.md" })!.errors;
  const then = (fill: Record<string, string>) => ({ app: "[[Errands]]", do: "add", fill });
  // What a form's run has: its fields, row keys, the time it ran, and the note a save to a folder made.
  assert.deepEqual(errors({ view: "form", fields: { who: "text" }, save: "Calls/", row: { kind: "call" }, then: then({ errand: "Call {who} ({kind}) {date} {time} {at} [[{path}]]" }) }), []);
  assert.deepEqual(errors({ view: "form", fields: { who: "text" }, save: "calls", then: then({ errand: "Call {whoo} back" }) }),
    ["panel 1: then: fill reads {whoo}, which this form never has (it has who, and date, time, at)"]);
  assert.deepEqual(errors({ view: "button", label: "Go", save: "goes", then: then({ errand: "Went at {time}, {mood}" }) }),
    ["panel 1: then: fill reads {mood}, which this button never has (it has date, time, at)"]);
  assert.deepEqual(errors({ view: "form", fields: { who: "text" }, save: "calls", then: then({ errand: "{who}", token: "{secret:api}" }) }),
    ["panel 1: then: fill can't use {secret:api}; secrets only go into web requests"]);
  // A form whose fields come from the block it saves to has those fields.
  const blockForm = readSpec({ app: "x", data: { calls: { source: "calls", fields: { who: "text", back: "date" } } }, panels: [{ view: "form", save: "calls", then: then({ errand: "Call {who} by {back}" }) }] }, { path: "Apps/X.md" })!;
  assert.deepEqual(blockForm.errors, []);
  // An alert's rows can hold anything, so a name there that a row lacks fills as empty, as notify does.
  assert.deepEqual(errors({ view: "number", source: "calls", agg: "count", alert: { back: "past" }, then: then({ errand: "Overdue: {who} {anything}" }) }), []);
});

test("what alerts ran for, kept in an older form, is started over rather than read, so no then runs again for every row", async () => {
  const passport = { what: "passport", due: "2026-11-25", at: "2026-10-01T09:00" };
  const first = fakeBackground(renewals([passport]));
  await first.bg.start();
  await settle();
  const kept = JSON.parse(first.triggers.text!) as { v: number; fired: Record<string, { rows: string[] }> };
  assert.equal(kept.v, 2);
  const forgot = Object.fromEntries(Object.keys(kept.fired).map((k) => [k, { rows: [] }]));
  // In the kept form, a row it never ran for runs once the app starts again…
  const current = fakeBackground(renewals([passport]), {}, { triggers: { text: JSON.stringify({ v: 2, fired: forgot }) } });
  await current.bg.start();
  await settle();
  assert.deepEqual(tasks(current)?.map((r) => r.task), ["Renew passport"]);
  // …but kept as before versions, it's noted, not run.
  const old = fakeBackground(renewals([passport]), {}, { triggers: { text: JSON.stringify(forgot) } });
  await old.bg.start();
  await settle();
  assert.equal(tasks(old), undefined);
});
