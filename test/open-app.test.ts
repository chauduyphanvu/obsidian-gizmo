import assert from "node:assert/strict";
import { test } from "node:test";
import { orderApps, type AppItem } from "../src/open-app.ts";

const item = (name: string): AppItem => ({ name, description: `About ${name}`, path: `Apps/${name}.md` });
const APPS = ["Weight", "Budget", "Watchlist", "Aurora watch", "Task inbox"].map(item);
const names = (list: AppItem[]) => list.map((a) => a.name);

test("with nothing opened and no activity, the apps are listed by name", () => {
  assert.deepEqual(names(orderApps(APPS, [], new Map())), ["Aurora watch", "Budget", "Task inbox", "Watchlist", "Weight"]);
});

test("apps opened lately come first, newest first, as Obsidian keeps them; other notes there don't count", () => {
  const recent = ["Notes/Daily.md", "Apps/Watchlist.md", "Apps/Budget.md"];
  assert.deepEqual(names(orderApps(APPS, recent, new Map())), ["Watchlist", "Budget", "Aurora watch", "Task inbox", "Weight"]);
});

test("then apps by their newest activity, then the rest by name", () => {
  const active = new Map([["Apps/Weight.md", 200], ["Apps/Task inbox.md", 500]]);
  assert.deepEqual(names(orderApps(APPS, ["Apps/Budget.md"], active)), ["Budget", "Task inbox", "Weight", "Aurora watch", "Watchlist"]);
});

test("the list it is given is left as it was", () => {
  const before = names(APPS);
  orderApps(APPS, ["Apps/Weight.md"], new Map());
  assert.deepEqual(names(APPS), before);
});
