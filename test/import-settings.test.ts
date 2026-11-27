import assert from "node:assert/strict";
import { test } from "node:test";
import { importFiles, importNow, importWays } from "../src/import.ts";
import { devicesNow, secretsWanted } from "../src/settings-model.ts";
import { runtimeOn } from "./support/runtime.ts";

// What Import rows into a kind and the settings read of the runtime, on any host: Obsidian's
// command and settings tab and the standalone app's pickers and Settings page say the same.

const SPEND = {
  kind: "spend",
  fields: { amount: "number", memo: "text" },
  import: { bank: { folder: "Inbox/Bank", amount: "-Amount", at: "Posted Date", memo: "Description" }, card: { amount: "Amount", at: "Date" } },
};
const CSV = ["Posted Date,Description,Amount", "11/17/2026,CORNER CAFE,-14.50", "11/18/2026,CITY POWER,-82.10", ""].join("\n");

test("Import: every kind's maps with their folder; the files a map can read, its folder's first; a file read in says what it did", async () => {
  const t = await runtimeOn({ "Kinds/Spend.md": { fm: SPEND, body: "" }, "Apps/Notes.md": { fm: { app: "Notes", panels: [{ view: "value", value: 1 }] }, body: "" } });
  await t.runtime.start();
  const ways = importWays(t.runtime);
  assert.deepEqual(ways, [
    { kind: "Kinds/Spend.md", name: "Spend", map: "bank", folder: "Inbox/Bank" },
    { kind: "Kinds/Spend.md", name: "Spend", map: "card" },
  ]);
  const paths = ["Downloads/nov.csv", "Inbox/Bank/oct.csv", "Apps/Notes.md", "Inbox/Bank/notes.txt", "cal.ics", "Inbox/Bank/a.json"];
  assert.deepEqual(importFiles(paths, ways[0]), ["Inbox/Bank/a.json", "Inbox/Bank/oct.csv", "Downloads/nov.csv", "cal.ics"]);
  assert.deepEqual(importFiles(paths, ways[1]), ["Downloads/nov.csv", "Inbox/Bank/a.json", "Inbox/Bank/oct.csv", "cal.ics"]);

  t.f.others.set("Downloads/nov.csv", CSV);
  const done = await importNow(t.runtime, ways[0], "Downloads/nov.csv");
  assert.equal(done.text, "Imported 2 rows from nov.csv into Spend");
  assert.ok(done.entry, "an entry an Undo takes back");
  assert.equal((await importNow(t.runtime, ways[0], "Downloads/nov.csv")).text, "Nothing new in nov.csv for Spend; 2 rows already imported");
  assert.match((await importNow(t.runtime, ways[0], "Downloads/gone.csv")).text, /^Couldn't import gone\.csv: /);
});

test("Settings: where background work runs and the other devices; the secrets the apps use, by the apps that use them", async () => {
  const weather = { app: "Weather", panels: [{ view: "number", source: "https://api.example.com/w?key={secret:weather-key}", pick: "t" }] };
  const news = { app: "News", panels: [{ view: "list", source: "https://news.example.com/top", headers: { authorization: "Bearer {secret:news-token}", "x-key": "{secret:weather-key}" } }] };
  const chore = { kind: "chore", fields: { task: "text" }, share: { relay: "https://ntfy.sh", key: { secret: "chore-key" } } };
  const t = await runtimeOn({ "Apps/Weather.md": { fm: weather, body: "" }, "Apps/News.md": { fm: news, body: "" }, "Kinds/Chore.md": { fm: chore, body: "" } });
  await t.runtime.start();
  assert.deepEqual([...secretsWanted(t.runtime)], [["chore-key", ["Chore"]], ["news-token", ["News"]], ["weather-key", ["News", "Weather"]]]);

  const { background, others } = devicesNow(t.runtime, new Date());
  // The only device: background work runs here, and there are no others.
  assert.equal(background, "Runs on this device: records, and the thens alerts run. Shortcuts, links, pins and alert notices work on every device.");
  assert.deepEqual(others, []);
});
