import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsFile, type SettingsIO, type StoredData } from "../src/stored.ts";

// data.json written by two programs on one vault at once (Obsidian and the standalone app): a save
// lands only over what it just read, so what the other wrote in between is merged, not lost.

/** data.json on a disk that another program may write between this one's read and its write. */
function disk(first: StoredData) {
  let text = JSON.stringify(first);
  let read = text;
  let meddle: (() => void) | undefined;
  const writes: string[] = [];
  const io: SettingsIO = {
    load: async () => {
      read = text;
      return JSON.parse(text);
    },
    save: async (data) => {
      text = JSON.stringify(data);
      writes.push("over");
    },
    saveOver: async (data) => {
      // The other program writes just before this one does.
      meddle?.();
      meddle = undefined;
      if (text !== read) return false;
      text = JSON.stringify(data);
      writes.push("checked");
      return true;
    },
  };
  return {
    io, writes,
    now: () => JSON.parse(text) as StoredData,
    other: (fn: (d: StoredData) => void) => { meddle = () => { const d = JSON.parse(text) as StoredData; fn(d); text = JSON.stringify(d); }; },
  };
}

test("a save that loses the race to another program reads data.json again and keeps both changes", async () => {
  const d = disk({ grants: { "Apps/A.md": [] } });
  const file = new SettingsFile(d.io);
  await file.open();
  file.data.grants["Apps/B.md"] = ["fetch:example.com"];
  d.other((o) => { o.linkKeys = { "Apps/A.md#add": "k".repeat(32) }; });
  await file.save();
  assert.deepEqual(d.now(), { grants: { "Apps/A.md": [], "Apps/B.md": ["fetch:example.com"] }, linkKeys: { "Apps/A.md#add": "k".repeat(32) } });
  assert.deepEqual(d.writes, ["checked"], "written once, over what it read the second time");
  assert.deepEqual(file.data.linkKeys, { "Apps/A.md#add": "k".repeat(32) }, "and what the other wrote is in use here");
});

test("a host whose writes can't check saves as before", async () => {
  const d = disk({ grants: {} });
  delete d.io.saveOver;
  const file = new SettingsFile(d.io);
  await file.open();
  file.data.grants["Apps/A.md"] = [];
  await file.save();
  assert.deepEqual(d.writes, ["over"]);
  assert.deepEqual(d.now().grants, { "Apps/A.md": [] });
});
