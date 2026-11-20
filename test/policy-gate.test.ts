import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { previewInstall } from "../src/bundle.ts";
import { checkFlows, flowContext } from "../src/flows.ts";
import { planCopy } from "../src/gallery.ts";
import { isAllowedUnder } from "../src/grants.ts";
import { buildMap } from "../src/map.ts";
import { permissionsOf } from "../src/permissions.ts";
import { readPolicy, type Policy } from "../src/policy.ts";
import { readSpec } from "../src/spec.ts";
import { dataPathOf } from "../src/store.ts";
import { fakeBackground, fakeEnv } from "./support/fakes.ts";
import { parseYaml } from "./support/yaml.ts";

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const NOW = new Date(2026, 10, 19, 10, 0);

const POLICY: Policy = readPolicy({
  labels: { "Health/**": "private" },
  sinks: { "api.open-meteo.com": "public" },
  release: [{ app: "Health/Meds", panel: "Doses today", to: ["pin"] }],
}).policy!;

const MEDS = {
  app: "m",
  panels: [
    { view: "button", label: "Took meds", save: "doses", shortcut: "took" },
    { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", pin: "status" },
    { view: "number", title: "Doses this week", source: "doses", where: { at: "this week" }, agg: "count", pin: "status" },
  ],
};
const WEATHER = { app: "w", view: "number", title: "Rain", source: "https://api.open-meteo.com/v1/forecast?lat=1&lon=2", pick: "rain", pin: "status" };

test("under a policy an app is allowed when what it still asks for was allowed; what it no longer wants takes nothing away", () => {
  const asked = ["edit:Books"];
  assert.equal(isAllowedUnder({ a: ["edit:Books", "net:openlibrary.org", "read:Books"] }, "a", asked), true, "a grant from before the policy still holds");
  assert.equal(isAllowedUnder({ a: ["edit:Books"] }, "a", asked), true);
  assert.equal(isAllowedUnder({ a: ["net:openlibrary.org"] }, "a", asked), false, "what it still asks for wasn't allowed");
  assert.equal(isAllowedUnder({ a: ["edit:Books", "write:Daily"] }, "a", asked), true, "allowed something it no longer wants: still allowed");
  assert.equal(isAllowedUnder({}, "a", []), true, "covered entirely, it needs no OK in a tab");
  assert.equal(isAllowedUnder({}, "a", [], true), false, "but the background acts only for an app opened once");
  assert.equal(isAllowedUnder({ a: [] }, "a", [], true), true);
  assert.equal(isAllowedUnder({ constructor: [] } as Record<string, string[]>, "toString", [], true), false);
});

test("the background runs nothing for an app the policy blocks, and starts or stops it when the policy changes", async () => {
  const t = fakeBackground({
    "Health/Meds.md": { fm: MEDS },
    "Apps/Weather.md": { fm: WEATHER },
  }, { "https://api.open-meteo.com/": { rain: 2 } });
  await t.bg.start();
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.text).sort(), ["Doses this week: 0", "Doses today: 0", "Rain: 2"]);

  t.policy.rules = POLICY;
  t.bg.policyChanged();
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Rain: 2"], "Meds pins a private count it wasn't released for");
  const r = await t.bg.runCommand("Health/Meds.md:took");
  assert.equal(r.ok, false);
  assert.equal(t.f.files.get("Health/Meds data.md"), undefined, "its shortcut writes nothing");

  t.policy.rules = undefined;
  t.bg.policyChanged();
  await settle();
  assert.equal(t.out.status.length, 3);
});

test("in Obsidian, an app the policy covers entirely runs in the background once opened, without an OK", async () => {
  const t = fakeBackground({ "Apps/Weather.md": { fm: WEATHER } }, { "https://api.open-meteo.com/": { rain: 2 } }, { seen: true, policy: POLICY });
  t.grants["Apps/Weather.md"] = [];
  await t.bg.start();
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Rain: 2"]);
  const without = fakeBackground({ "Apps/Weather.md": { fm: WEATHER } }, { "https://api.open-meteo.com/": { rain: 2 } }, { seen: true });
  without.grants["Apps/Weather.md"] = [];
  await without.bg.start();
  await settle();
  assert.deepEqual(without.out.status, [], "without a policy it still needs net:api.open-meteo.com allowed");
});

/** An app opened in its own tab under a policy: its grants are kept, and checked as Obsidian checks them. */
function underPolicy(notes: Parameters<typeof fakeEnv>[0], path: string, policy: Policy | undefined = POLICY) {
  const t = fakeEnv(notes);
  t.env.isGranted = (p, wanted, asked) => isAllowedUnder(t.grants, p, asked ?? wanted);
  t.env.verdict = (spec, wanted, where) => (policy ? checkFlows(spec, wanted, flowContext(policy, where, t.env.notes, t.env.storePath, () => [])) : undefined);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, path, t.env);
  app.load();
  return { ...t, root, app };
}

test("an app the policy blocks shows each flow it refuses and draws no panel", async () => {
  const t = underPolicy({ "Health/Meds.md": { fm: MEDS } }, "Health/Meds.md");
  await settle();
  assert.equal(text(t.root.querySelector(".gz-blocked .gz-title")), "Blocked by your data policy");
  assert.deepEqual([...t.root.querySelectorAll(".gz-blocked li")].map(text), ["Doses this week: Meds data (private) → the status bar (personal)"]);
  assert.equal(t.root.querySelectorAll(".gz-panel").length, 0);
  assert.deepEqual(t.grants, {});
});

test("the prompt asks only for what the policy doesn't cover, says how much it covers, and Allow keeps just that", async () => {
  const fm = {
    app: "b", inputs: { q: "text" },
    panels: [
      { view: "table", title: "Rain", source: "https://api.open-meteo.com/v1/forecast?q=$q", pick: "hourly" },
      { view: "table", title: "Shelf", source: "notes", from: "Books", edit: ["status"] },
    ],
  };
  const t = underPolicy({ "Apps/B.md": { fm }, "Books/Dune.md": { fm: { status: "reading" } } }, "Apps/B.md");
  await settle();
  const items = [...t.root.querySelectorAll(".gz-card li")].map(text);
  assert.deepEqual(items, ["Change properties of notes in Books"]);
  assert.equal(text(t.root.querySelector(".gz-covered")), "Your data policy covers 3 more.");
  const allow = [...t.root.querySelectorAll("button")].find((b) => b.textContent === "Allow")!;
  allow.click();
  await settle();
  assert.deepEqual(t.grants["Apps/B.md"], ["edit:Books"]);
  assert.equal(t.root.querySelectorAll(".gz-panel").length, 2);
});

test("an app the policy covers entirely opens with no prompt, and is kept as seen", async () => {
  const t = underPolicy({ "Apps/Weather.md": { fm: WEATHER } }, "Apps/Weather.md");
  await settle();
  assert.equal(t.root.querySelectorAll(".gz-panel").length, 1);
  assert.deepEqual(t.grants["Apps/Weather.md"], []);
});

test("no app may write the policy note: store and append can't name it, and a copied note can't take its name", () => {
  const store = readSpec({ app: "a", store: "[[Gizmo policy]]", view: "button", label: "x", save: "d" }, { now: NOW, path: "Apps/A.md" })!;
  assert.deepEqual(store.errors, ["store can't be Gizmo policy, your data policy; name a note that only holds data"]);
  const append = readSpec({ app: "a", view: "button", label: "x", append: "Gizmo policy", line: "- typed: secret" }, { now: NOW, path: "Apps/A.md" })!;
  assert.deepEqual(append.errors, ["append can't write Gizmo policy, your data policy; change it by hand"]);
  const plan = planCopy({ path: "Gizmo policy.md", text: "---\napp: x\n---\n" }, [], {});
  assert.deepEqual(plan, { refusal: "“Gizmo policy” is the name of your data policy's note, which a copied note can't take" });
});

test("the install preview says how a shared app fares under the policy, and asks only for what it doesn't cover", () => {
  const text = (fm: string) => `---\n${fm}\n---\n`;
  const target = (policy: Policy | undefined) => ({
    folder: "Health", existing: () => [], parse: parseYaml,
    notes: { resolve: () => undefined, frontmatter: () => undefined },
    judge: policy && ((spec: Parameters<typeof permissionsOf>[0], path: string) => checkFlows(spec, permissionsOf(spec, path), flowContext(policy, {
      appPath: path, dataPath: dataPathOf(spec.store, path, (s) => `${s}.md`), hostPath: path,
    }, { resolve: () => undefined, frontmatter: () => undefined }, (s) => `${s}.md`, () => []))),
  });
  const meds = [{ name: "Meds", text: text("app: m\npanels:\n  - {view: button, label: Took, save: doses}\n  - {view: number, title: Doses this week, source: doses, agg: count, pin: status}") }];
  const blocked = previewInstall(meds, target(POLICY));
  assert.ok(!("error" in blocked));
  assert.deepEqual(blocked.policy?.violations, ["Doses this week: Meds data (private) → the status bar (personal)"]);
  const weather = [{ name: "Rain", text: text("app: w\nview: number\nsource: https://api.open-meteo.com/v1/x\npick: rain") }];
  const fits = previewInstall(weather, target(POLICY));
  assert.ok(!("error" in fits));
  assert.deepEqual(fits.policy, { violations: [], covered: ["Fetch data from api.open-meteo.com"] });
  assert.deepEqual(fits.asks, []);
  const none = previewInstall(weather, target(undefined));
  assert.ok(!("error" in none) && none.policy === undefined && none.asks.length === 1);
});

test("the map shows an app the policy blocks, and which of its asks the policy grants", () => {
  const spec = (fm: Record<string, unknown>, path: string) => readSpec(fm, { now: NOW, path })!.spec!;
  const summary = (fm: Record<string, unknown>, path: string) => {
    const s = spec(fm, path);
    const wanted = permissionsOf(s, path);
    const dataPath = dataPathOf(s.store, path, (x) => `${x}.md`);
    return {
      path, name: path.split("/").pop()!.replace(".md", ""), description: "", dataPath, wanted,
      verdict: checkFlows(s, wanted, flowContext(POLICY, { appPath: path, dataPath, hostPath: path }, { resolve: () => undefined, frontmatter: () => undefined }, (x) => `${x}.md`, () => [])),
      askers: new Map(), shortcuts: [], records: [], alerts: [], thens: [], writesSelf: false,
    };
  };
  const map = buildMap([summary(MEDS, "Health/Meds.md"), summary(WEATHER, "Apps/Weather.md")], { "Apps/Weather.md": [] }, [], []);
  const [meds, weather] = [map.apps.find((a) => a.name === "Meds")!, map.apps.find((a) => a.name === "Weather")!];
  assert.equal(meds.state, "blocked");
  assert.deepEqual(meds.policy?.violations, ["Doses this week: Meds data (private) → the status bar (personal)"]);
  assert.equal(weather.state, "allowed");
  assert.deepEqual(weather.asks.map((a) => [a.perm, a.covered ?? false, a.isNew]), [["net:api.open-meteo.com", true, false]]);
});

test("the background checks an app against the policy each time it acts, so a tag added to its data note stops it", async () => {
  const policy = readPolicy({ labels: { "#health": "private" } }).policy!;
  const t = fakeBackground({
    "Apps/Doses.md": { fm: { app: "d", view: "number", title: "Doses", source: "doses", agg: "count", pin: "status" } },
    "Apps/Doses data.md": { fm: { doses: [{ at: "2026-11-18T09:00" }] } },
  }, {}, { policy });
  await t.bg.start();
  await settle();
  assert.deepEqual(t.out.status.map((s) => s.text), ["Doses: 1"]);
  t.f.files.get("Apps/Doses data.md")!.tags = ["#health"];
  t.changed("Apps/Doses data.md");
  t.advance(11 * 60_000);
  await t.bg.tick();
  await settle();
  assert.deepEqual(t.out.status, []);
});

test("the install preview reads a then target shipped in the same share as it will be once installed", () => {
  const policy = readPolicy({ labels: { "Health/**": "private" } }).policy!;
  const watch = "---\napp: w\nview: number\ntitle: Due\nsource: notes\nfrom: Health\nalert: {due: past}\nthen: {app: \"[[Med log]]\", do: log, fill: {med: \"{med}\"}}\n---\n";
  const log = "---\napp: m\nview: form\nfields: {med: text}\nsave: doses\nshortcut: log\nnotify: Logged {med}\n---\n";
  const p = previewInstall([{ name: "Watch", text: watch }, { name: "Med log", text: log }], {
    folder: "Apps", existing: () => [], parse: parseYaml,
    notes: { resolve: () => undefined, frontmatter: () => undefined },
    judge: (spec, path, notes) => checkFlows(spec, permissionsOf(spec, path), flowContext(policy, {
      appPath: path, dataPath: dataPathOf(spec.store, path, (s) => `${s}.md`), hostPath: path,
    }, notes, (s) => `${s}.md`, () => [])),
  });
  assert.ok(!("error" in p));
  assert.ok(p.policy?.violations.includes("Due: notes in Health: med (private) → Med log (through then) (personal)"), JSON.stringify(p.policy));
});

test("gizmod answers a value only when the policy clears its label, an untitled panel's too; a label it can't find isn't taken for public", async () => {
  const COUNT = { app: "c", panels: [{ view: "button", label: "Took", save: "doses", shortcut: "took" }, { view: "number", source: "doses", agg: "count", shortcut: "count" }] };
  // Health may be answered to a link (personal), but gizmod's answers are cleared for public data only.
  const policy = readPolicy({ labels: { "Health/**": "personal", "Apps/**": "public" }, sinks: { gizmod: "public" } }).policy!;
  const t = fakeBackground({ "Health/Count.md": { fm: COUNT }, "Apps/Open.md": { fm: { ...COUNT, app: "o" } } }, {}, { policy });
  await t.bg.start();
  // Copying the links makes their keys.
  t.bg.shortcutLinks();
  const health = await t.bg.runFrom("Health/Count.md", "count", { key: t.linkKeys.get("Health/Count.md#count") });
  assert.equal(health.ok, false);
  assert.match(health.error ?? "", /your data policy keeps/);
  const open = await t.bg.runFrom("Apps/Open.md", "count", { trusted: false, key: t.linkKeys.get("Apps/Open.md#count") });
  assert.deepEqual([open.ok, open.value], [true, 0]);
});
