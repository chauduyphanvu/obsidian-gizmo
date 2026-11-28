import assert from "node:assert/strict";
import { test } from "node:test";
import { readInvite } from "../src/share.ts";
import { readIdentity } from "../src/share-crypto.ts";
import { guestPagePath, inviteLinkOf, join, joinPlan, keepKey, keyNeeded, makeGuestPage, makeKey, sharedKindOf } from "../src/share-setup.ts";
import { runtimeOn } from "./support/runtime.ts";

const CHORE = { kind: "chore", fields: { task: "text", who: ["Alex", "Sam"], minutes: "number" }, share: { relay: "https://ntfy.sh", key: { secret: "chore-key" } } };
const KIND = "Kinds/Chore.md";

test("a kind's key: made here only into an empty secret, kept from another device only when it is a key, never replacing one", async () => {
  const t = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } });
  const found = sharedKindOf(t.runtime, KIND);
  assert.ok(found && !found.id, "a shared kind with no key yet");
  assert.deepEqual(await keyNeeded(t.runtime, KIND, found.kind), { elsewhere: false });

  const made = await makeKey(t.runtime, "chore-key", "Ann");
  assert.ok("id" in made);
  assert.equal(readIdentity(t.secrets.get("chore-key")!)?.name, "Ann");
  assert.equal(sharedKindOf(t.runtime, KIND)!.id?.name, "Ann");
  assert.equal(await keyNeeded(t.runtime, KIND, found.kind), "taken");
  assert.deepEqual(await makeKey(t.runtime, "chore-key", "Bo"), { error: "taken" }, "never replaces");

  const other = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } }, { secrets: { "chore-key": "not a key" } });
  assert.deepEqual(keepKey(other.runtime, "chore-key", "gzk1.nope"), { error: "not-a-key" });
  assert.deepEqual(keepKey(other.runtime, "chore-key", t.secrets.get("chore-key")!), { error: "taken" });
  const fresh = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } });
  assert.ok("id" in keepKey(fresh.runtime, "chore-key", t.secrets.get("chore-key")!));
  assert.equal(fresh.secrets.get("chore-key"), t.secrets.get("chore-key"));

  const keyless = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } }, { secrets: false });
  await assert.rejects(() => makeKey(keyless.runtime, "chore-key", "Ann"), /keeps no secrets/);
});

test("joining from an invite: the next free secret, the kind's note where new notes go, the inviter accepted and saved", async () => {
  const ann = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } });
  const { id } = (await makeKey(ann.runtime, "chore-key", "Ann")) as { id: NonNullable<ReturnType<typeof readIdentity>> };
  const link = await inviteLinkOf(CHORE, "Chore", id);
  const invite = readInvite(link);
  assert.ok(!("error" in invite));

  const bo = await runtimeOn({}, { folder: "Shared", secrets: { "chore-key": "something of Bo's", "chore-key-2": "another" } });
  const plan = joinPlan(bo.runtime, invite);
  assert.equal(plan.path, "Shared/Chore.md");
  assert.equal(plan.secret, "chore-key-3", "the invite's secret, or the next one free, counted from it");
  assert.equal(plan.taken, false);
  assert.ok(plan.asks.length > 0);
  const joined = await join(bo.runtime, plan, "Bo");
  assert.deepEqual(joined, { path: "Shared/Chore.md" });
  assert.equal(readIdentity(bo.secrets.get("chore-key-3")!)?.name, "Bo");
  assert.equal(bo.secrets.get("chore-key"), "something of Bo's", "never replaced");
  const note = bo.f.files.get("Shared/Chore.md")!;
  assert.deepEqual((note.fm as { share: unknown }).share, { relay: "https://ntfy.sh", key: { secret: "chore-key-3" } });
  assert.match(note.body!, /^Shared with you by Ann through ntfy\.sh\./);
  const writers = bo.saved().writers!;
  assert.deepEqual(Object.values(writers).map((w) => [w.name, w.state]), [["Ann", "accepted"]], "saved before it's done");

  // Joined again: the note is there, so nothing is made.
  const again = joinPlan(bo.runtime, invite);
  assert.equal(again.taken, true);
  assert.deepEqual(await join(bo.runtime, again, "Bo"), { error: "You already have a note called Chore" });
});

test("joining keeps to a secret free at the click, and a note that can't be made leaves no secret behind", async () => {
  const ann = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } });
  const { id } = (await makeKey(ann.runtime, "chore-key", "Ann")) as { id: NonNullable<ReturnType<typeof readIdentity>> };
  const invite = readInvite(await inviteLinkOf(CHORE, "Chore", id, "gizmo://open"));
  assert.ok(!("error" in invite), "an invite from the app reads as one from Obsidian does");

  // The secret the preview named is filled meanwhile: it stays as it is, and the key goes in the next one free.
  const bo = await runtimeOn({});
  const plan = joinPlan(bo.runtime, invite);
  assert.equal(plan.secret, "chore-key");
  bo.secrets.set("chore-key", "filled since the preview");
  assert.deepEqual(await join(bo.runtime, plan, "Bo"), { path: "Chore.md" });
  assert.equal(bo.secrets.get("chore-key"), "filled since the preview", "never replaced");
  assert.equal(readIdentity(bo.secrets.get("chore-key-2")!)?.name, "Bo");
  assert.deepEqual((bo.f.files.get("Chore.md")!.fm as { share: unknown }).share, { relay: "https://ntfy.sh", key: { secret: "chore-key-2" } });

  // The note can't be made: nothing is kept, so joining again takes the same secret.
  const cy = await runtimeOn({});
  const planned = joinPlan(cy.runtime, invite);
  const createNote = cy.runtime.host.writes.createNote;
  cy.runtime.host.writes.createNote = async () => false;
  assert.deepEqual(await join(cy.runtime, planned, "Cy"), { error: "You already have a note called Chore" });
  assert.equal(cy.secrets.has("chore-key"), false, "no secret left behind");
  cy.runtime.host.writes.createNote = createNote;
  assert.deepEqual(await join(cy.runtime, joinPlan(cy.runtime, invite), "Cy"), { path: "Chore.md" });
  assert.equal(readIdentity(cy.secrets.get("chore-key")!)?.name, "Cy");
});

test("a guest page: beside the kind, named for the guest, never over a file; the code given back, the kind's key nowhere in the page", async () => {
  const taken = new Set(["Kinds/Chore guest page (Sitter).html"]);
  assert.equal(guestPagePath(KIND, "Sitter", (p) => taken.has(p)), "Kinds/Chore guest page (Sitter) 2.html");
  assert.equal(guestPagePath("Chore.md", 'a/b:"c"', () => false), 'Chore guest page (a-b--c-).html');

  const t = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } });
  const { id } = (await makeKey(t.runtime, "chore-key", "Ann")) as { id: NonNullable<ReturnType<typeof readIdentity>> };
  const found = sharedKindOf(t.runtime, KIND)!;
  const page = await makeGuestPage(t.runtime, KIND, CHORE, found.kind, id, "Sitter");
  assert.equal(page.path, "Kinds/Chore guest page (Sitter).html");
  assert.deepEqual(page.members, ["Ann"]);
  const html = t.f.others.get(page.path)!;
  assert.ok(html.includes("<html") || html.includes("<!doctype"), "an HTML page");
  assert.ok(!html.includes(t.secrets.get("chore-key")!), "the kind's key isn't in it");
  assert.ok(!html.includes(page.code), "the code isn't in it");
  assert.deepEqual(Object.values(t.saved().writers!).map((w) => [w.name, w.guest]), [["Sitter", true]]);
  const second = await makeGuestPage(t.runtime, KIND, CHORE, found.kind, id, "Sitter");
  assert.equal(second.path, "Kinds/Chore guest page (Sitter) 2.html");
});
