import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { DataLayer } from "../src/datalayer.ts";
import { readSpec, resolvePanel, type Panel } from "../src/spec.ts";
import { fakeEnv, fakeHost } from "./support/fakes.ts";

const API = "https://api.example.com/q";
const NOW = new Date(2026, 10, 18, 12);
const FILES = { appPath: "Apps/Q.md", dataPath: "Apps/Q data.md" };
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };
const NOT_ALLOWED = /This app wasn't allowed the secret "demo"/;

test("the data layer fills only the secrets a request was allowed, wherever they are written", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  await assert.rejects(dl.fetch(`${API}?k={secret:demo}`, undefined, 60_000), NOT_ALLOWED);
  await assert.rejects(dl.fetch(API, { Authorization: "Bearer {secret:demo}" }, 60_000, false, undefined, ["other"]), NOT_ALLOWED);
  await assert.rejects(dl.fetch(API, undefined, 60_000, false, { auth: { token: "{secret:demo}" } }), NOT_ALLOWED);
  await assert.rejects(dl.fetch(API, undefined, 60_000, false, "token={secret:demo}"), NOT_ALLOWED);
  assert.deepEqual(f.requests, [], "nothing was sent");
  await dl.fetch(API, { Authorization: "Bearer {secret:demo}" }, 60_000, false, { token: "{secret:demo}" }, ["demo"]);
  assert.equal(f.calls[0].headers.Authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(f.calls[0].body!), { token: "s3cret" });
});

test("a response fetched with a secret isn't handed to a request that wasn't allowed it, from memory or from disk", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const url = `${API}?k={secret:demo}`;
  await dl.fetch(url, undefined, 60_000, false, undefined, ["demo"]);
  await assert.rejects(dl.fetch(url, undefined, 60_000), NOT_ALLOWED);
  await settle(1);
  const p: Panel = { view: "text", source: url, text: "{current.t}" };
  assert.equal(await dl.cachedPanelData(url, p, FILES, NOW), undefined);
  assert.ok(await dl.cachedPanelData(url, { ...p, secrets: ["demo"] }, FILES, NOW));
  assert.equal(f.requests.length, 1);
});

test("a panel may fill the secrets typed whole in its own keys, and no other", () => {
  const panel = (keys: Record<string, unknown>) => readSpec({ app: "x", inputs: { q: "text", k: ["a", "b"] }, panels: [keys] })!.spec!.panels[0]?.panel;
  assert.deepEqual(panel({ view: "text", source: `${API}?k={secret:demo}&q=$q`, headers: { A: "{secret:hkey}" }, body: { t: "{secret:btok}", q: "$q" }, text: "x" }).secrets,
    ["btok", "demo", "hkey"]);
  // Text beside a name only starts a placeholder; a value can't finish it.
  assert.equal(panel({ view: "text", source: `${API}?x=$q`, headers: { F: "{$q}" }, text: "x" }).secrets, undefined);
  assert.equal(panel({ view: "text", source: `${API}?x=$q`, text: "x" }).secrets, undefined);
  // The list is the plugin's to make, never typed.
  const typed = readSpec({ app: "x", panels: [{ view: "text", source: `${API}?x={$q}`, secrets: ["demo"], text: "x" }] })!;
  assert.deepEqual(typed.errors, ['panel 1: unknown key "secrets"']);
  assert.equal(typed.spec!.panels[0].panel.secrets, undefined);
});

test("typed text that completes a secret placeholder beside a literal brace is never filled", async () => {
  const fm = { app: "Q", inputs: { q: "text" }, panels: [{ view: "text", title: "T", source: `${API}?x=$q`, headers: { "X-Filter": "{$q}" }, text: "{current.t}" }] };
  const t = fakeEnv({ "Apps/Q.md": { fm } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  new AppController(root, "Apps/Q.md", t.env).load();
  await settle(2);
  const box = root.querySelector("input.na-search") as HTMLInputElement;
  box.value = "secret:demo}";
  const e = new (globalThis as unknown as { window: { Event: typeof Event } }).window.Event("keydown", { bubbles: true }) as Event & { key: string };
  e.key = "Enter";
  box.dispatchEvent(e);
  await settle();
  assert.ok(!JSON.stringify(t.f.calls).includes("s3cret"), JSON.stringify(t.f.calls));
  assert.match(root.querySelector(".na-panel.na-error")?.textContent ?? "", /secret/);
});

test("text a value completes into a secret placeholder is the panel's error, in headers or a body, typed or picked", () => {
  const read = (fm: Record<string, unknown>) => readSpec({ app: "Q", ...fm }, { path: "Apps/Q.md" })!;
  const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
    [{ inputs: { q: "text" }, panels: [{ view: "text", source: `${API}?x=$q`, headers: { "X-Filter": "{$q}" }, text: "x" }] }, { q: "secret:demo}" }, "$q"],
    [{ inputs: { q: "text" }, panels: [{ view: "text", source: API, body: { filter: "{$q}" }, text: "x" }] }, { q: "secret:demo}" }, "$q"],
    [{ inputs: { q: "text" }, panels: [{ view: "text", source: API, body: { deep: ["{$q}"] }, text: "x" }] }, { q: "secret:demo}" }, "$q"],
    [{ panels: [
      { view: "list", source: "books", select: "book" },
      { view: "text", source: API, headers: { "X-Id": "{$book.id}" }, text: "x" },
    ] }, { book: { id: "secret:demo}" } }, "$book"],
    [{ panels: [
      { view: "list", source: "books", select: "book" },
      { view: "text", source: API, body: { id: "{$book.id}" }, text: "x" },
    ] }, { book: { id: "secret:demo}" } }, "$book"],
  ];
  for (const [fm, values, name] of cases) {
    const r = read(fm);
    assert.deepEqual(r.errors, [], JSON.stringify(fm));
    const ps = r.spec!.panels.at(-1)!;
    assert.deepEqual(resolvePanel(ps, values), { errors: [`${name} can't name a secret`] }, JSON.stringify(fm));
    // Other values are fine, a brace included.
    const fine = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? "dune}" : { id: "dune}" }]));
    assert.deepEqual(resolvePanel(ps, fine).errors, []);
  }
  // A secret typed whole stays usable beside a value.
  const typed = read({ inputs: { q: "text" }, panels: [{ view: "text", source: API, headers: { A: "Bearer {secret:demo}", F: "{$q}" }, text: "x" }] });
  assert.deepEqual(resolvePanel(typed.spec!.panels[0], { q: "dune" }).errors, []);
  assert.deepEqual(resolvePanel(typed.spec!.panels[0], { q: "secret:demo}" }).errors, []);
  // A choice is checked before anything runs.
  const choice = read({ inputs: { k: ["secret:demo}", "plain"] }, panels: [{ view: "text", source: API, headers: { F: "{$k}" }, text: "x" }] });
  assert.deepEqual(choice.errors, ["panel 1: $k can't name a secret"]);
});
