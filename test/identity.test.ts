import assert from "node:assert/strict";
import { test } from "node:test";
import { dropKeys, fingerprint, moveKeys } from "../src/identity.ts";
import { mergeSettings, type StoredData } from "../src/stored.ts";

const stored = (): StoredData => ({
  grants: { "Apps/Meds.md": ["write:Daily.md"], "Apps/Meds.md#9f3a": [], "Apps/Other.md": [] },
  linkKeys: { "Apps/Meds.md#took": "k1", "Apps/Other.md#go": "k2" },
  answerTo: { "Apps/Meds.md#took": ["shortcuts://"] },
  captureKeys: { c1: { took: "Apps/Meds.md#took", go: "Apps/Other.md#go" }, c2: { pill: "Apps/Meds.md#took" } },
});

test("a rename moves everything data.json keeps for the app: grants, its embeds', link keys, answers and capture keys' targets", () => {
  const s = stored();
  assert.equal(moveKeys(s, "Apps/Meds.md", "Health/Pills.md"), true);
  assert.deepEqual(s, {
    grants: { "Health/Pills.md": ["write:Daily.md"], "Health/Pills.md#9f3a": [], "Apps/Other.md": [] },
    linkKeys: { "Apps/Other.md#go": "k2", "Health/Pills.md#took": "k1" },
    answerTo: { "Health/Pills.md#took": ["shortcuts://"] },
    captureKeys: { c1: { took: "Health/Pills.md#took", go: "Apps/Other.md#go" }, c2: { pill: "Health/Pills.md#took" } },
  });
  assert.equal(moveKeys(s, "Apps/Nothing.md", "Apps/Else.md"), false);
});

test("a renamed kind keeps the apps that read it allowed: what they were allowed on its note follows the note", () => {
  const s: StoredData = {
    grants: {
      "Apps/Budget.md": ["answer:spent", "kind-write:Kinds/Spend.md", "kind:Kinds/Spend.md"],
      "Apps/Bills.md": ["kind:Kinds/Spend.md", "kind:Kinds/Spend.md.bak", "kind:Kinds/Renewal.md"],
      "Kinds/Spend.md": ["read:Inbox/Bank", "secret:spend-key", "share:Kinds/Spend.md|ntfy.sh"],
    },
  };
  assert.equal(moveKeys(s, "Kinds/Spend.md", "Money/Spend.md"), true);
  assert.deepEqual(s.grants, {
    "Apps/Budget.md": ["answer:spent", "kind-write:Money/Spend.md", "kind:Money/Spend.md"],
    "Apps/Bills.md": ["kind:Money/Spend.md", "kind:Kinds/Spend.md.bak", "kind:Kinds/Renewal.md"],
    "Money/Spend.md": ["read:Inbox/Bank", "secret:spend-key", "share:Money/Spend.md|ntfy.sh"],
  });
});

test("a delete drops what data.json keeps for the app; a capture key keeps its other names, and goes when it has none", () => {
  const s = stored();
  assert.equal(dropKeys(s, "Apps/Meds.md"), true);
  assert.deepEqual(s, { grants: { "Apps/Other.md": [] }, linkKeys: { "Apps/Other.md#go": "k2" }, answerTo: {}, captureKeys: { c1: { go: "Apps/Other.md#go" } } });
});

test("an app note's fingerprint is its keys, whatever order they were read in", () => {
  assert.equal(fingerprint({ app: "Meds", view: "button" }), fingerprint({ view: "button", app: "Meds" }));
  assert.notEqual(fingerprint({ app: "Meds" }), fingerprint({ app: "Pills" }));
});

test("saving merges entry by entry: what another device saved meanwhile stays, what this one changed wins", () => {
  const base: StoredData = { grants: { a: ["net:x"], b: [] }, linkKeys: { "a#go": "k1" }, folded: { L: true } };
  // Another device allowed c, made a link key for b and unfolded L; this one allowed d and revoked b.
  const disk: StoredData = { grants: { a: ["net:x"], b: [], c: ["read:Books"] }, linkKeys: { "a#go": "k1", "b#go": "k9" }, folded: {} };
  const local: StoredData = { grants: { a: ["net:x"], d: [] }, linkKeys: { "a#go": "k1" }, folded: { L: true } };
  assert.deepEqual(mergeSettings(base, disk, local), {
    grants: { a: ["net:x"], c: ["read:Books"], d: [] },
    linkKeys: { "a#go": "k1", "b#go": "k9" },
    folded: {},
  });
});

test("when both devices changed one entry, this one's wins, a grant allowed differently on each keeps both, and a delete loses to a change", () => {
  const base: StoredData = { grants: { a: ["net:x"], b: ["net:y"] }, linkKeys: { "a#go": "k1" }, policy: { hash: "1", rules: { labels: [], sinks: {}, release: [], typed: "public" } } };
  const disk: StoredData = { grants: { a: ["net:x", "read:B"] }, linkKeys: { "a#go": "k2" }, policy: { hash: "2", rules: { labels: [], sinks: {}, release: [], typed: "public" } } };
  const local: StoredData = { grants: { a: ["net:z"], b: ["net:y", "net:w"] }, linkKeys: { "a#go": "k3" }, policy: { hash: "3", rules: { labels: [], sinks: {}, release: [], typed: "public" } } };
  const merged = mergeSettings(base, disk, local);
  assert.deepEqual(merged.grants, { a: ["net:z", "net:x", "read:B"], b: ["net:y", "net:w"] }, "b deleted there and changed here: the change stays");
  assert.equal(merged.linkKeys!["a#go"], "k3");
  assert.equal(merged.policy!.hash, "3");
});

test("with nothing changed here, saving writes what is on disk", () => {
  const base: StoredData = { grants: { a: [] } };
  const disk: StoredData = { grants: { a: [], b: ["net:x"] }, captureKeys: { c: { n: "b#go" } } };
  assert.deepEqual(mergeSettings(base, disk, structuredClone(base)), disk);
});
