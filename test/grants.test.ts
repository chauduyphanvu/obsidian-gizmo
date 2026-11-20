import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppController } from "../src/app.ts";
import { isAllowed, isPaused, migrateGrants, sameGrant } from "../src/grants.ts";
import { fakeEnv } from "./support/fakes.ts";

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };

test("a grant is a set: order doesn't matter, a permission no longer wanted takes nothing away, a new one asks", () => {
  const grants = { "A.md": ["net:b.example", "net:a.example"] };
  assert.equal(isAllowed(grants, "A.md", ["net:a.example", "net:b.example"], true), true, "order");
  assert.equal(isAllowed(grants, "A.md", ["net:a.example"], true), true, "one dropped by an edit");
  assert.equal(isAllowed(grants, "A.md", ["net:a.example", "net:c.example"], true), false, "one added asks");
  assert.equal(sameGrant(grants, "A.md", ["net:a.example", "net:b.example"]), true);
  assert.equal(sameGrant(grants, "A.md", ["net:a.example"]), false);
});

test("paused means allowed once and now asking for more; no entry is revoked or never allowed, never paused", () => {
  const grants = { "A.md": ["net:a.example"], "B.md": [] as string[] };
  assert.equal(isPaused(grants, "A.md", ["net:a.example", "net:c.example"]), true);
  assert.equal(isPaused(grants, "A.md", ["net:a.example"]), false);
  assert.equal(isPaused(grants, "A.md", []), false);
  assert.equal(isPaused(grants, "B.md", ["write:Daily.md"]), true, "allowed when it asked for nothing, then asks for a write");
  assert.equal(isPaused(grants, "C.md", ["net:a.example"]), false, "never allowed");
  // Under a policy only what the policy leaves to ask counts.
  assert.equal(isPaused(grants, "A.md", ["net:a.example", "read:Books"], ["net:a.example"]), false);
  assert.equal(isPaused(grants, "A.md", ["net:a.example", "read:Books"], ["read:Books"]), true);
});

test("a permission given a new wording is added beside the old, never in its place, so an older Gizmo reading the same grants keeps working", () => {
  const renamed = (p: string) => (p.startsWith("fetch:") ? `net:${p.slice(6)}` : undefined);
  const grants = { "A.md": ["fetch:a.example", "read:Books"], "B.md": ["read:Books"] };
  assert.equal(migrateGrants(grants, [renamed]), true);
  assert.deepEqual(grants, { "A.md": ["fetch:a.example", "read:Books", "net:a.example"], "B.md": ["read:Books"] });
  assert.equal(migrateGrants(grants, [renamed]), false, "applied once");
  assert.equal(isAllowed(grants, "A.md", ["net:a.example", "read:Books"], true), true, "the new Gizmo");
  assert.equal(isAllowed(grants, "A.md", ["fetch:a.example", "read:Books"], true), true, "the old one");
});

test("an app opened in its own tab drops from its grant what it no longer asks for, so asking for it again later asks again", async () => {
  const weather = { app: "Weather", view: "number", title: "Rain", source: "https://api.open-meteo.com/v1/forecast?lat=1", pick: "rain" };
  const t = fakeEnv({ "Apps/Weather.md": { fm: weather } }, { "https://api.open-meteo.com/v1/forecast?lat=1": { rain: 2 } });
  t.grants["Apps/Weather.md"] = ["net:api.open-meteo.com", "net:old.example.com"];
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, "Apps/Weather.md", t.env);
  app.load();
  await settle();
  assert.deepEqual(t.grants["Apps/Weather.md"], ["net:api.open-meteo.com"]);
  assert.ok(!root.textContent!.includes("needs your OK"), "it ran without asking");
  assert.ok(root.querySelector(".gz-panel"), "its panel is drawn");
  app.dispose();
});
