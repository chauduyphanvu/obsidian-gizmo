import assert from "node:assert/strict";
import { test } from "node:test";
import { answerParams, readCallbacks, readLink, withParams } from "../src/links.ts";
import { permissionsOf, describePermission } from "../src/permissions.ts";
import { readSpec } from "../src/spec.ts";
import { fakeBackground } from "./support/fakes.ts";

const MEDS = {
  app: "Meds",
  panels: [
    { view: "button", label: "Took meds", save: "doses", shortcut: "took-meds" },
    { view: "number", title: "Doses today", source: "doses", agg: "count", shortcut: "doses-today" },
    { view: "number", title: "Outside", source: "https://api.example.com/now", field: "current.t", unit: "°C", shortcut: "outside" },
    { view: "number", title: "Broken", source: "https://api.example.com/fail", field: "t", shortcut: "broken" },
  ],
};
const notes = () => ({
  "Apps/Meds.md": { fm: structuredClone(MEDS) },
  "Apps/Meds data.md": { fm: { doses: [{ at: "2026-11-18T08:00" }, { at: "2026-11-18T09:00" }] } },
});
const OK = "shortcuts://x-callback-url/run-shortcut?name=Meds";

async function started() {
  const t = fakeBackground(notes());
  await t.bg.start();
  const key = (shortcut: string) => t.bg.shortcutLinks().find((l) => l.shortcut === shortcut)!.link.split("key=")[1];
  return { t, key };
}

test("a link's callbacks: never form values, only allowed schemes, all to one app", () => {
  assert.deepEqual(readLink({ app: "Meds", do: "x", key: "k", "x-success": OK, "x-error": OK, "x-cancel": OK, "x-source": "Shortcuts", note: "hi" }).fields, { note: "hi" });
  assert.deepEqual(readCallbacks({ "x-success": OK }), { success: OK, to: "shortcuts://x-callback-url" });
  assert.deepEqual(readCallbacks({}), {});
  for (const bad of ["javascript:alert(1)", "obsidian://gizmo?app=Meds&do=took-meds", "file:///etc/passwd", "data:text/html,hi", "http://example.com/x", "smb://host/share"]) {
    assert.ok("problem" in readCallbacks({ "x-success": bad }), bad);
  }
  assert.ok("problem" in readCallbacks({ "x-success": "not a link" }));
  assert.deepEqual(readCallbacks({ "x-success": OK, "x-error": "raycast://extensions/x" }), { problem: "x-success, x-error and x-cancel must all go to one app" });
  assert.deepEqual(readCallbacks({ "x-success": OK, "x-error": OK }), { success: OK, error: OK, to: "shortcuts://x-callback-url" });
  assert.equal(withParams(OK, { result: "2", value: "2" }), `${OK}&result=2&value=2`);
  assert.equal(withParams("https://example.com/cb?result=old", { result: "new" }), "https://example.com/cb?result=new");
});

test("an answer is a plain value and its text, cut short; anything else sends only the text", () => {
  assert.deepEqual(answerParams("2 doses", 2), { result: "2 doses", value: "2" });
  assert.equal(answerParams("x".repeat(500), 1).result.length, 200);
  assert.deepEqual(answerParams("[object]", { a: 1 }), { result: "[object]" });
  assert.deepEqual(answerParams("long", "y".repeat(300)), { result: "long" });
});

test("a number panel's shortcut asks to send its value: the prompt says so, and adding one asks again", () => {
  const spec = readSpec(MEDS, { path: "Apps/Meds.md" })!.spec!;
  const perms = permissionsOf(spec, "Apps/Meds.md");
  assert.ok(perms.includes("answer:doses-today") && perms.includes("answer:outside"));
  assert.ok(!perms.includes("answer:took-meds"), "a button acts; it doesn't answer");
  assert.equal(describePermission("answer:doses-today"), "Send its “doses-today” value to the app that opens its link");
  const linkOf = (t: Awaited<ReturnType<typeof started>>["t"]) => t.bg.shortcutLinks().find((l) => l.shortcut === "doses-today");
  return started().then(({ t }) => assert.equal(linkOf(t)?.answers, true));
});

test("an answer's command tells its value in a notice; a then can't run it", async () => {
  const { t } = await started();
  await t.bg.runCommand("Apps/Meds.md:doses-today");
  assert.equal(t.notices.at(-1), "Meds: Doses today: 2");
});

test("a keyed answer link asks once where its value goes; Always is remembered, and the value goes back with its text", async () => {
  const { t, key } = await started();
  t.ask.choice = 2;
  await t.bg.runUri({ app: "Meds", do: "doses-today", key: key("doses-today"), "x-success": OK });
  assert.equal(t.out.chose.length, 1);
  assert.match(t.out.chose[0].title, /Meds would send its value \(Doses today\) to shortcuts:\/\/x-callback-url/);
  assert.deepEqual(t.out.opened, [`${OK}&result=2&value=2`]);
  t.ask.choice = undefined;
  await t.bg.runUri({ app: "Meds", do: "doses-today", key: key("doses-today"), "x-success": `${OK}&again=1` });
  assert.equal(t.out.chose.length, 1, "the remembered app isn't asked about again");
  assert.equal(t.out.opened.length, 2);
  const log = await t.activity.list();
  assert.deepEqual(log[0].sent, { to: "shortcuts://x-callback-url", shown: "2" });
  assert.deepEqual(log[0].changes, []);
});

test("Once sends this time only; Cancel opens x-cancel and sends nothing", async () => {
  const { t, key } = await started();
  t.ask.choice = 1;
  await t.bg.runUri({ app: "Meds", do: "doses-today", key: key("doses-today"), "x-success": OK });
  await t.bg.runUri({ app: "Meds", do: "doses-today", key: key("doses-today"), "x-success": OK });
  assert.equal(t.out.chose.length, 2, "Once isn't remembered");
  t.ask.choice = undefined;
  const cancel = "shortcuts://x-callback-url/cancelled";
  await t.bg.runUri({ app: "Meds", do: "doses-today", key: key("doses-today"), "x-success": OK, "x-cancel": cancel });
  assert.deepEqual(t.out.opened.slice(2), [cancel]);
});

test("a link without its key asks before anything is fetched, and never says why it failed", async () => {
  const { t } = await started();
  t.ask.answer = false;
  await t.bg.runUri({ app: "Meds", do: "outside", "x-success": OK, "x-error": OK });
  assert.equal(t.out.asked.length, 1, JSON.stringify(t.notices));
  assert.deepEqual(t.out.asked[0], { title: "A link asks for “Outside” from Meds", lines: ["Its value goes to shortcuts://x-callback-url"] });
  assert.deepEqual(t.f.requests, [], "nothing fetched while it asks, or after Cancel");
  assert.deepEqual(t.out.opened, [], "and nothing goes back");
  await t.bg.runUri({ app: "Nobody", do: "outside", "x-error": OK });
  await t.bg.runUri({ app: "Meds", do: "nothing", "x-error": OK });
  t.ask.answer = true;
  await t.bg.runUri({ app: "Meds", do: "broken", "x-error": OK });
  assert.deepEqual(t.out.opened, [], "no x-error for a link without its key");
  await t.bg.runUri({ app: "Meds", do: "outside", "x-success": OK });
  assert.deepEqual(t.out.opened, [`${OK}&result=7+%C2%B0C&value=7`]);
});

test("a keyed answer that can't be worked out goes to x-error with why", async () => {
  const { t, key } = await started();
  t.ask.choice = 2;
  const err = "shortcuts://x-callback-url/failed";
  await t.bg.runUri({ app: "Meds", do: "broken", key: key("broken"), "x-success": OK.replace("name=Meds", "name=Err"), "x-error": err });
  assert.deepEqual(t.out.opened, [`${err}?errorMessage=api.example.com+answered+503`]);
});

test("a refused callback refuses the whole link", async () => {
  const { t, key } = await started();
  await t.bg.runUri({ app: "Meds", do: "took-meds", key: key("took-meds"), "x-success": "javascript:alert(1)" });
  assert.equal((t.f.files.get("Apps/Meds data.md")!.fm!.doses as unknown[]).length, 2, "nothing saved");
  assert.match(t.notices.at(-1)!, /^Refused a link to “took-meds” in Meds: x-success goes to javascript:/);
});

test("an action shortcut tells its callback it ran, with no data; without the key only after Run", async () => {
  const { t, key } = await started();
  t.ask.choice = 2;
  await t.bg.runUri({ app: "Meds", do: "took-meds", key: key("took-meds"), "x-success": OK });
  assert.deepEqual(t.out.opened, [`${OK}&result=done`]);
  assert.equal((t.f.files.get("Apps/Meds data.md")!.fm!.doses as unknown[]).length, 3);
  await t.bg.runUri({ app: "Meds", do: "took-meds", "x-success": OK });
  assert.deepEqual(t.out.asked.at(-1)!.lines, ["Then it tells shortcuts://x-callback-url it ran"]);
  assert.equal(t.out.opened.length, 2);
});

test("another app's then can't run an answer", async () => {
  const t = fakeBackground({
    ...notes(),
    "Apps/Other.md": { fm: { app: "Other", panels: [{ view: "button", label: "Go", save: "x", then: { app: "[[Meds]]", do: "doses-today" } }] } },
  });
  await t.bg.start();
  await t.bg.runThen("Apps/Other.md", { app: "[[Meds]]", do: "doses-today" }, {});
  assert.equal(t.notices.at(-1), "Meds: “doses-today” answers links with a value; a then can't run it");
});
