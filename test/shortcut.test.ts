import assert from "node:assert/strict";
import { test } from "node:test";
import { linkNotice } from "../src/links.ts";
import { fakeBackground } from "./support/fakes.ts";

const MEDS = {
  app: "Log when I take my meds",
  panels: [
    { view: "button", label: "Took meds", save: "doses", shortcut: "took-meds" },
    { view: "button", label: "Skipped", save: "skips" },
    { view: "form", title: "Side effects", fields: { note: "text", severity: ["mild", "bad"], dizzy: "checkbox", hours: "number", on: "date", when: "time" }, save: "effects", notify: "Logged {severity}: {note}", shortcut: "effects" },
  ],
};

function meds(more: Parameters<typeof fakeBackground>[0] = {}) {
  const t = fakeBackground({ "Apps/Meds.md": { fm: MEDS }, ...more });
  const data = (key: string) => t.f.files.get("Apps/Meds data.md")?.fm?.[key] as Record<string, unknown>[] | undefined;
  return { ...t, data };
}

test("each shortcut is a command named after its app and panel; commands follow the apps", async () => {
  const t = meds({ "Apps/Weight.md": { fm: { app: "w", view: "form", fields: { kg: "number" }, save: "weights", shortcut: "weigh-in" } } });
  await t.bg.start();
  assert.deepEqual(t.out.commands, [
    { id: "Apps/Meds.md:effects", name: "Meds: Side effects" },
    { id: "Apps/Meds.md:took-meds", name: "Meds: Took meds" },
    { id: "Apps/Weight.md:weigh-in", name: "Weight: weigh-in" },
  ]);
  t.f.files.get("Apps/Weight.md")!.fm = { app: "w", view: "form", fields: { kg: "number" }, save: "weights" };
  t.changed("Apps/Weight.md");
  assert.deepEqual(t.out.commands.map((c) => c.id), ["Apps/Meds.md:effects", "Apps/Meds.md:took-meds"]);
});

test("a button's command runs its actions without opening the app", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runCommand("Apps/Meds.md:took-meds");
  assert.deepEqual(t.data("doses"), [{ at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.notices, ["Meds: Took meds done"]);
  assert.deepEqual(t.out.apps, []);
});

test("a form's command opens the app to fill it in", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runCommand("Apps/Meds.md:effects");
  assert.deepEqual(t.out.apps, ["Apps/Meds.md"]);
  assert.deepEqual(t.notices, ["Meds: fill in the form"]);
  assert.equal(t.data("effects"), undefined);
});

test("a link fills a form's fields by type; fields not given save as an untouched form; others are ignored", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runUri({ action: "gizmo", app: "Meds", do: "effects", note: "headache", severity: "bad", dizzy: "yes", hours: "2.5", when: "08:30", extra: "ignored" });
  assert.deepEqual(t.data("effects"), [{ note: "headache", severity: "bad", dizzy: true, hours: 2.5, on: "2026-11-18", when: "08:30", at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.notices, ["Logged bad: headache"]);
  await t.bg.runUri({ action: "gizmo", app: "Apps/Meds", do: "effects" });
  assert.deepEqual(t.data("effects")![1], { note: "", severity: "mild", dizzy: false, hours: null, on: "2026-11-18", when: "", at: "2026-11-18T12:00" });
});

test("a value that doesn't fit its field refuses the whole action, naming the field", async () => {
  const t = meds();
  await t.bg.start();
  const tries: [string, string][] = [
    ["hours", "two"], ["hours", "Infinity"], ["severity", "awful"], ["dizzy", "maybe"], ["on", "18/11/2026"], ["when", "25:00"],
  ];
  for (const [field, value] of tries) await t.bg.runUri({ app: "Meds", do: "effects", [field]: value });
  assert.deepEqual(t.notices, [
    "Meds: hours must be a number",
    "Meds: hours must be a number",
    "Meds: severity must be one of mild, bad",
    "Meds: dizzy must be true or false",
    "Meds: on must be a date like 2026-11-18",
    "Meds: when must be a time like 08:30",
  ]);
  assert.equal(t.data("effects"), undefined);
});

test("a link from any web page can't reach a panel without a shortcut, an app not yet allowed, or inject through values", async () => {
  const t = meds();
  await t.bg.start();
  await t.bg.runUri({ app: "Meds", do: "Skipped" });
  await t.bg.runUri({ app: "Meds", do: "skips" });
  assert.equal(t.data("skips"), undefined);

  await t.bg.runUri({ app: "Meds", do: "effects", note: "{secret:demo}" });
  await t.bg.runUri({ app: "Meds", do: "effects", note: "line\nbreak" });
  await t.bg.runUri({ app: "Meds", do: "effects", junk: "x\r\ny" });
  assert.equal(t.data("effects"), undefined);
  // A placeholder in a value is text, never filled again.
  await t.bg.runUri({ app: "Meds", do: "effects", note: "{severity} {secret}", severity: "bad" });
  assert.deepEqual(t.data("effects")!.map((r) => r.note), ["{severity} {secret}"]);

  t.denied.add("Apps/Meds.md");
  await t.bg.runUri({ app: "Meds", do: "took-meds" });
  await t.bg.runCommand("Apps/Meds.md:took-meds");
  assert.equal(t.data("doses"), undefined);
  assert.deepEqual(t.notices, [
    "Meds has no shortcut “Skipped”",
    "Meds has no shortcut “skips”",
    "Meds: $note can't hold a secret or a line break",
    "Meds: $note can't hold a secret or a line break",
    "Meds: $junk can't hold a secret or a line break",
    "Logged bad: {severity} {secret}",
    "Open Meds once to allow it",
    "Open Meds once to allow it",
  ]);
});

test("a link names its app by path or name; none or several is said so", async () => {
  const t = meds({ "Old/Meds.md": { fm: MEDS } });
  await t.bg.start();
  await t.bg.runUri({ app: "Meds", do: "took-meds" });
  await t.bg.runUri({ app: "Vitamins", do: "took-meds" });
  assert.deepEqual(t.notices, ["Several apps are called “Meds”; use its path", "No app called “Vitamins”"]);
  await t.bg.runUri({ app: "Old/Meds.md", do: "took-meds" });
  assert.deepEqual(t.f.files.get("Old/Meds data.md")?.fm?.doses, [{ at: "2026-11-18T12:00" }]);
  assert.equal(t.data("doses"), undefined);
});

test("a shortcut reading $this runs with the app note as $this, as its panel does when the app is open", async () => {
  const fm = {
    app: "Walk", city: "Oslo",
    panels: [
      { view: "button", label: "Walked", save: "walks", row: { city: "$this.city" }, notify: "Walked in $this.city", shortcut: "walked" },
      { view: "form", fields: { km: "number" }, save: "legs", row: { km: "{km}", city: "$this.city" }, shortcut: "leg" },
    ],
  };
  const t = fakeBackground({ "Apps/Walk.md": { fm } });
  await t.bg.start();
  await t.bg.runCommand("Apps/Walk.md:walked");
  await t.bg.runUri({ app: "Walk", do: "leg", km: "3" });
  const data = t.f.files.get("Apps/Walk data.md")?.fm;
  assert.deepEqual(data?.walks, [{ city: "Oslo", at: "2026-11-18T12:00" }]);
  assert.deepEqual(data?.legs, [{ km: 3, city: "Oslo", at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.notices, ["Walked in Oslo", "Walk: leg done"]);
  assert.deepEqual(t.out.apps, [], "nothing opened the app");
});

/** The parameters Obsidian hands the handler for a link: its own `action`, then the query's. */
function paramsOf(link: string): Record<string, string> {
  const url = new URL(link);
  return { action: url.host, ...Object.fromEntries(url.searchParams) };
}

test("each shortcut has the link that runs it, and copying one says how a form's fields are filled", async () => {
  const t = meds({ "Apps/Weight.md": { fm: { app: "w", view: "form", fields: { kg: "number" }, save: "weights", shortcut: "weigh-in" } } });
  t.denied.add("Apps/Weight.md");
  await t.bg.start();
  const links = t.bg.shortcutLinks();
  assert.deepEqual(links.map((l) => [l.path, l.shortcut, l.label, l.fields, l.link, l.allowed]), [
    ["Apps/Meds.md", "effects", "Side effects", ["note", "severity", "dizzy", "hours", "on", "when"], "obsidian://gizmo?app=Meds&do=effects&key=k2", true],
    ["Apps/Meds.md", "took-meds", "Took meds", [], "obsidian://gizmo?app=Meds&do=took-meds&key=k1", true],
    ["Apps/Weight.md", "weigh-in", "weigh-in", ["kg"], "obsidian://gizmo?app=Weight&do=weigh-in&key=k3", false],
  ]);
  assert.equal(linkNotice(links[1]), "Copied the link to “Took meds” in Meds.");
  assert.equal(linkNotice(links[2]), "Copied the link to “weigh-in” in Weight. Add &kg=… to fill the form. Open Weight once to allow it; until then the link is refused.");

  await t.bg.runUri(paramsOf(links[1].link));
  await t.bg.runUri(paramsOf(`${links[0].link}&note=${encodeURIComponent("a bit sick")}&severity=mild`));
  assert.deepEqual(t.data("doses"), [{ at: "2026-11-18T12:00" }]);
  assert.equal(t.data("effects")![0].note, "a bit sick");
});

test("a shortcut's link names its app by path when another app has its name, and a name with spaces is encoded", async () => {
  const t = meds({ "Old/Meds.md": { fm: MEDS }, "Apps/Med log.md": { fm: { ...MEDS, panels: [MEDS.panels[0]] } } });
  await t.bg.start();
  const link = (path: string) => t.bg.shortcutLinks().find((l) => l.path === path && l.shortcut === "took-meds")!.link;
  const key = (path: string) => `&key=${t.linkKeys.get(`${path}#took-meds`)}`;
  assert.equal(link("Apps/Meds.md"), `obsidian://gizmo?app=Apps%2FMeds&do=took-meds${key("Apps/Meds.md")}`);
  assert.equal(link("Old/Meds.md"), `obsidian://gizmo?app=Old%2FMeds&do=took-meds${key("Old/Meds.md")}`);
  assert.equal(link("Apps/Med log.md"), `obsidian://gizmo?app=Med%20log&do=took-meds${key("Apps/Med log.md")}`);
  await t.bg.runUri(paramsOf(link("Old/Meds.md")));
  await t.bg.runUri(paramsOf(link("Apps/Med log.md")));
  assert.deepEqual(t.f.files.get("Old/Meds data.md")?.fm?.doses, [{ at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.f.files.get("Apps/Med log data.md")?.fm?.doses, [{ at: "2026-11-18T12:00" }]);
  assert.equal(t.data("doses"), undefined);
});

test("a link's own parameters (action, app, do) never fill a form's fields of those names", async () => {
  const fm = { app: "Jobs", view: "form", fields: { do: "text", app: "text", action: "text", who: "text" }, save: "jobs", shortcut: "job" };
  const t = fakeBackground({ "Apps/Jobs.md": { fm } });
  await t.bg.start();
  await t.bg.runUri({ action: "gizmo", app: "Jobs", do: "job", who: "me" });
  const jobs = t.f.files.get("Apps/Jobs data.md")?.fm?.jobs as Record<string, unknown>[];
  assert.deepEqual(jobs, [{ do: "", app: "", action: "", who: "me", at: "2026-11-18T12:00" }]);
  const [link] = t.bg.shortcutLinks();
  assert.equal(linkNotice(link), "Copied the link to “job” in Jobs. Add &who=… to fill the form. A link can't fill do, app, action; rename those fields to fill them.");
});

test("a copied link carries its shortcut's key and runs unattended; without it, or with a wrong one, it asks first, and Cancel writes nothing", async () => {
  const t = meds();
  await t.bg.start();
  const link = t.bg.shortcutLinks().find((l) => l.shortcut === "took-meds")!.link;
  assert.match(link, /^obsidian:\/\/gizmo\?app=Meds&do=took-meds&key=[\w-]+$/);
  await t.bg.runUri(paramsOf(link));
  assert.deepEqual(t.out.asked, []);
  assert.equal(t.data("doses")?.length, 1);
  // Any web page, email or chat message can send a link, but none of them knows the key.
  t.ask.answer = false;
  await t.bg.runUri({ action: "gizmo", app: "Meds", do: "took-meds" });
  await t.bg.runUri({ action: "gizmo", app: "Meds", do: "took-meds", key: "guessed" });
  await t.bg.runUri({ action: "gizmo", app: "Meds", do: "effects", note: "Pay the invoice at https://pay.example", severity: "bad" });
  assert.equal(t.data("doses")?.length, 1);
  assert.equal(t.data("effects"), undefined);
  // Each window says what the link would change, worked out by a dry run that writes nothing.
  assert.deepEqual(t.out.asked, [
    { title: "A link asks to run “Took meds” in Meds", lines: [], effects: ["Save a row to doses in Meds data"] },
    { title: "A link asks to run “Took meds” in Meds", lines: [], effects: ["Save a row to doses in Meds data"] },
    {
      title: "A link asks to run “Side effects” in Meds",
      lines: ["note: Pay the invoice at https://pay.example", "severity: bad"],
      effects: ["Save note Pay the invoice at https://pay.example, severity bad, dizzy false, … to effects in Meds data", "Tell you: Logged bad: Pay the invoice at https://pay.example"],
    },
  ]);
  // Run, once the person has read what it asks.
  t.ask.answer = true;
  await t.bg.runUri({ action: "gizmo", app: "Meds", do: "took-meds" });
  assert.equal(t.data("doses")?.length, 2);
});

test("a link runs a shortcut at most 20 times an hour, key or not", async () => {
  const t = meds();
  await t.bg.start();
  const link = paramsOf(t.bg.shortcutLinks().find((l) => l.shortcut === "took-meds")!.link);
  for (let i = 0; i < 21; i++) await t.bg.runUri(link);
  assert.equal(t.data("doses")?.length, 20);
  assert.equal(t.notices.at(-1), "Meds: stopped running “Took meds” from links: it ran 20 times this hour");
  // A command isn't a link, and isn't counted.
  await t.bg.runCommand("Apps/Meds.md:took-meds");
  assert.equal(t.data("doses")?.length, 21);
  t.advance(3_600_000);
  await t.bg.runUri(link);
  assert.equal(t.data("doses")?.length, 22);
});

test("while one link waits for an answer, other links without the key are dropped", async () => {
  const t = meds();
  await t.bg.start();
  let answer!: (yes: boolean) => void;
  t.ask.wait = () => new Promise((resolve) => { answer = resolve; });
  const first = t.bg.runUri({ action: "gizmo", app: "Meds", do: "took-meds" });
  await t.bg.runUri({ action: "gizmo", app: "Meds", do: "took-meds" });
  assert.deepEqual(t.notices, ["Ignored a link to “Took meds” in Meds while another link waits for an answer"]);
  // The first window opens once its dry run is worked out.
  for (let i = 0; i < 50 && !answer; i++) await new Promise((r) => setTimeout(r, 1));
  answer(true);
  await first;
  assert.equal(t.data("doses")?.length, 1);
  assert.equal(t.out.asked.length, 1);
});

test("a link's key is the link's own, never a form field called key", async () => {
  const fm = { app: "Jobs", view: "form", fields: { key: "text", who: "text" }, save: "jobs", shortcut: "job" };
  const t = fakeBackground({ "Apps/Jobs.md": { fm } });
  await t.bg.start();
  const [link] = t.bg.shortcutLinks();
  assert.equal(linkNotice(link), "Copied the link to “job” in Jobs. Add &who=… to fill the form. A link can't fill key; rename that field to fill it.");
  await t.bg.runUri({ ...paramsOf(link.link), who: "me" });
  assert.deepEqual(t.f.files.get("Apps/Jobs data.md")?.fm?.jobs, [{ key: "", who: "me", at: "2026-11-18T12:00" }]);
  assert.deepEqual(t.out.asked, []);
});

test("running a shortcut gives its result: the activity entry it kept, or why it didn't run", async () => {
  const t = meds();
  await t.bg.start();
  const ran = await t.bg.runCommand("Apps/Meds.md:took-meds");
  assert.equal(ran.ok, true);
  const [entry] = await t.activity.list("Apps/Meds.md");
  assert.equal(ran.entryId, entry.id);
  const form = await t.bg.runCommand("Apps/Meds.md:effects");
  assert.deepEqual(form, { ok: false, error: "the form needs its values" });
  const missing = await t.bg.runCommand("Apps/Meds.md:nope");
  assert.deepEqual(missing, { ok: false, error: "Meds has no shortcut “nope”" });
});

test("a shortcut that answers tells its value", async () => {
  const t = fakeBackground({
    "Apps/Meds.md": { fm: { app: "m", panels: [{ view: "number", title: "Doses", source: "doses", agg: "count", shortcut: "doses" }] } },
    "Apps/Meds data.md": { fm: { doses: [{ at: "2026-11-18T08:00" }, { at: "2026-11-18T09:00" }] } },
  });
  await t.bg.start();
  const r = await t.bg.runCommand("Apps/Meds.md:doses");
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(t.notices, ["Meds: Doses: 2"]);
});
