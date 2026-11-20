import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { cacheKey } from "../src/datalayer.ts";
import { PAST } from "../src/ledger-store.ts";
import { pastEnv } from "../src/replay.ts";
import { fakeEnv } from "./support/fakes.ts";

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const HOUR = 3_600_000;
const T0 = 1_000_000;
const RAIN = "https://api.example.com/rain";
const started: AppController[] = [];
afterEach(() => { for (const c of started.splice(0)) c.dispose(); });

const APP = {
  app: "Weather and weight",
  panels: [
    { view: "number", title: "Last", source: "weight", field: "kg", agg: "last" },
    { view: "number", title: "Rain", source: RAIN, pick: "rain" },
    { view: "form", title: "Log", fields: { kg: "number" }, save: "weight" },
    { view: "list", title: "Notes", source: "notes", from: "Notes", item: "{name}" },
  ],
};

/** Two weights an hour apart and two kept answers an hour apart; the network now says 9. */
async function history() {
  const t = fakeEnv({ "Apps/W.md": { fm: APP }, "Notes/A.md": { fm: {} } }, { [RAIN]: { rain: 9 } });
  const store = t.env.store!("Apps/W data.md", "Apps/W.md");
  await store.add("weight", { kg: 80 });
  await t.f.keep(cacheKey(RAIN, undefined), JSON.stringify({ rain: 1 }), T0);
  t.f.advance(HOUR);
  await store.add("weight", { kg: 79 });
  await t.f.keep(cacheKey(RAIN, undefined), JSON.stringify({ rain: 2 }), T0 + HOUR);
  return t;
}

function open(env: Parameters<typeof pastEnv>[0]) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = new AppController(root, "Apps/W.md", env);
  started.push(c);
  c.load();
  const big = (title: string) => text([...root.querySelectorAll(".gz-panel")].find((p) => p.textContent?.startsWith(title))?.querySelector(".gz-big"));
  return { root, big };
}

test("an app as of a past time shows its lists and web answers as they were then, says so, and what is shown as now", async () => {
  const t = await history();
  const past = open(pastEnv(t.env, T0 + HOUR / 2));
  await settle();
  assert.deepEqual([past.big("Last"), past.big("Rain")], ["80", "1"]);
  assert.match(text(past.root.querySelector(".gz-past")), /^As of .*: read only\. Shown as they are now, since their notes keep no history: Notes\.$/);
  const later = open(pastEnv(t.env, T0 + 2 * HOUR));
  await settle();
  assert.deepEqual([later.big("Last"), later.big("Rain")], ["79", "2"]);
  // Before anything was kept, the answer says so rather than showing today's.
  const before = open(pastEnv(t.env, T0 - HOUR));
  await settle();
  assert.match(text(before.root.querySelector(".gz-error")), /nothing kept from api\.example\.com by then/);
});

test("the same time twice gives the same page; the live app beside it shows now, and the past can't be written", async () => {
  const t = await history();
  const a = open(pastEnv(t.env, T0 + HOUR / 2));
  const live = open(t.env);
  await settle();
  const b = open(pastEnv(t.env, T0 + HOUR / 2));
  await settle();
  assert.equal(a.root.innerHTML, b.root.innerHTML);
  assert.deepEqual([live.big("Last"), live.big("Rain")], ["79", "9"]);
  assert.equal(live.root.querySelector(".gz-past"), null);
  (a.root.querySelector("form input") as HTMLInputElement).value = "70";
  a.root.querySelector("form")!.dispatchEvent(new window.Event("submit"));
  await settle();
  assert.ok(t.notices.some((n) => n.includes(PAST)), t.notices.join(" | "));
  assert.deepEqual((await t.env.store!("Apps/W data.md", "Apps/W.md").rows("weight")).map((r) => r.kg), [80, 79]);
});

test("a replay keeps the newest rows of a recorded list as the live app does", async () => {
  const t = await history();
  t.env.data.ledger!.setCaps("Apps/W data.md", { weight: 1 });
  const past = open(pastEnv(t.env, T0 + 2 * HOUR));
  await settle();
  assert.equal(past.big("Last"), "79");
  const rows = await pastEnv(t.env, T0 + 2 * HOUR).store!("Apps/W data.md", "Apps/W.md").rows("weight");
  assert.deepEqual(rows.map((r) => r.kg), [79]);
});
