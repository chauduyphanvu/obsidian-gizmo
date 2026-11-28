import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { drawGuest, drawInvite, drawJoin, drawPasteInvite, type SharePaneHost } from "../src/invite-pane.ts";
import { captureLinkOf, linkParams } from "../src/links.ts";
import { readInvite } from "../src/share.ts";
import { readIdentity } from "../src/share-crypto.ts";
import { inviteLinkOf, makeKey } from "../src/share-setup.ts";
import { runtimeOn } from "./support/runtime.ts";

// Invite to a kind, Join and Make a guest page as panes any host draws into its own window, and
// links that start where the host says: Obsidian's modals and the standalone app's windows wrap these.

const CHORE = { kind: "chore", fields: { task: "text", minutes: "number" }, share: { relay: "https://ntfy.sh", key: { secret: "chore-key" } } };
const KIND = "Kinds/Chore.md";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T, ms = 2000): Promise<T> => {
  for (let t = 0; t < ms; t += 20) {
    const v = fn();
    if (v) return v;
    await wait(20);
  }
  return fn();
};
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const button = (el: Element, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const fill = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
};
const hostFor = (did: string[]): SharePaneHost => ({
  copy: (value, done) => { did.push(`copied ${value.slice(0, 20)}`); done(); },
  notify: (m) => did.push(m),
  close: () => did.push("closed"),
  words: { secretsPlace: "Settings", opensIn: "the Gizmo app" },
});

test("links start where the host says, and a link from Obsidian or from the app reads the same", () => {
  assert.equal(captureLinkOf("k1"), "obsidian://gizmo?key=k1&line=");
  assert.equal(captureLinkOf("k1", "gizmo://open"), "gizmo://open?key=k1&line=");
  assert.equal(linkParams("obsidian://gizmo?app=Water&do=add")?.get("app"), "Water");
  assert.equal(linkParams("gizmo://open?app=Water&do=add&key=x")?.get("do"), "add");
  assert.equal(linkParams("gizmo://open/?line=water%202")?.get("line"), "water 2");
  assert.equal(linkParams("https://example.com/?app=Water"), undefined);
});

test("Invite: a shared kind with no key asks for a name and makes one; then the link, from the app as gizmo://; Copy link copies it and closes", async () => {
  const t = await runtimeOn({ [KIND]: { fm: CHORE, body: "" }, "Kinds/Plain.md": { fm: { kind: "plain", fields: { a: "text" } }, body: "" } });
  t.runtime.host.linkBase = "gizmo://open";
  const did: string[] = [];
  const plain = document.createElement("div");
  await drawInvite(plain, t.runtime, "Kinds/Plain.md", hostFor(did));
  assert.match(text(plain.querySelector(".gz-error-text")), /^Plain isn't a shared kind/);

  const el = document.createElement("div");
  await drawInvite(el, t.runtime, KIND, hostFor(did));
  assert.match(text(el.querySelector("p")), /^Chore has no key yet\. Gizmo makes one and keeps it on this device as your secret chore-key/);
  fill(el.querySelector("#gz-share-name") as HTMLInputElement, "Ann");
  button(el, "Make a key").click();
  const link = (await until(() => (el.querySelector("textarea[readonly]") as HTMLTextAreaElement | null)?.value)) ?? "";
  assert.ok(link.startsWith("gizmo://open?invite="), link);
  assert.equal(readIdentity(t.secrets.get("chore-key")!)?.name, "Ann");
  assert.match(text(el), /Opening it in the Gizmo app shows them the kind it makes/);
  const invite = readInvite(link);
  assert.ok(!("error" in invite) && invite.name === "Chore" && invite.from === "Ann");
  button(el, "Copy link").click();
  assert.deepEqual(did.slice(-3), [`copied ${link.slice(0, 20)}`, "Copied the invite to Chore; send it privately", "closed"]);
});

test("Invite: a secret that holds something else is never replaced, and the host says where to clear it", async () => {
  const t = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } }, { secrets: { "chore-key": "an API token" } });
  const el = document.createElement("div");
  await drawInvite(el, t.runtime, KIND, hostFor([]));
  await until(() => el.querySelector(".gz-error-text"));
  assert.equal(text(el.querySelector(".gz-error-text")), "The secret chore-key holds something that isn't a key for sharing. Gizmo won't replace it: give share another secret in key, or clear it in Settings.");
  assert.equal(t.secrets.get("chore-key"), "an API token");
});

test("Join: an invite that isn't one says so; one that is shows what it makes, and Join makes the kind and opens it; Paste previews what's pasted", async () => {
  const ann = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } });
  const { id } = (await makeKey(ann.runtime, "chore-key", "Ann")) as { id: NonNullable<ReturnType<typeof readIdentity>> };
  const link = await inviteLinkOf(CHORE, "Chore", id, "gizmo://open");

  const bo = await runtimeOn({}, { folder: "Shared" });
  bo.runtime.host.linkBase = "gizmo://open";
  const bad = document.createElement("div");
  drawJoin(bad, bo.runtime, "gizmo://open?invite=nope", { ...hostFor([]), joined: () => assert.fail("joined") });
  assert.equal(text(bad.querySelector(".gz-error-text")), "This isn't an invite to a shared kind; ask for the link again");

  const did: string[] = [];
  const el = document.createElement("div");
  drawJoin(el, bo.runtime, link, { ...hostFor(did), joined: (path) => did.push(`opened ${path}`) });
  assert.equal(text(el.querySelector("h4")), "Chore");
  assert.ok([...el.querySelectorAll("p")].some((p) => text(p) === "Creates Shared/Chore.md: a kind whose rows have task, minutes."));
  fill(el.querySelector("#gz-join-name") as HTMLInputElement, "Bo");
  button(el, "Join").click();
  await until(() => did.includes("opened Shared/Chore.md"));
  assert.deepEqual(did, ["closed", "opened Shared/Chore.md"]);
  assert.equal(readIdentity(bo.secrets.get("chore-key")!)?.name, "Bo");

  // A host that reads its secrets again just before joining: one filled since the preview counts.
  const cy = await runtimeOn({});
  const later = document.createElement("div");
  drawJoin(later, cy.runtime, link, { ...hostFor([]), joined: () => {}, ready: async () => { cy.secrets.set("chore-key", "filled on the server meanwhile"); } });
  fill(later.querySelector("#gz-join-name") as HTMLInputElement, "Cy");
  button(later, "Join").click();
  await until(() => cy.secrets.get("chore-key-2"));
  assert.equal(cy.secrets.get("chore-key"), "filled on the server meanwhile");
  assert.equal(readIdentity(cy.secrets.get("chore-key-2")!)?.name, "Cy");

  const pasted: string[] = [];
  const paste = document.createElement("div");
  drawPasteInvite(paste, bo.runtime, (value) => pasted.push(value));
  const area = paste.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(area.getAttribute("placeholder"), "gizmo://open?invite=…");
  fill(area, link);
  button(paste, "Preview").click();
  assert.deepEqual(pasted, [link]);
});

test("Guest page: asks who it's for, makes the page beside the kind and shows the code; Copy code copies it", async () => {
  const t = await runtimeOn({ [KIND]: { fm: CHORE, body: "" } });
  await makeKey(t.runtime, "chore-key", "Ann");
  const did: string[] = [];
  const el = document.createElement("div");
  drawGuest(el, t.runtime, KIND, { ...hostFor(did), made: (page) => did.push(`made ${page}`) });
  fill(el.querySelector("#gz-guest-name") as HTMLInputElement, "Sitter");
  button(el, "Make the page").click();
  await until(() => did.some((d) => d.startsWith("made ")));
  assert.deepEqual(did, ["made Kinds/Chore guest page (Sitter).html"]);
  assert.ok(t.f.others.get("Kinds/Chore guest page (Sitter).html")?.includes("<html"), "the page on disk");
  assert.match(text(el.querySelector("p")), /^Made Kinds\/Chore guest page \(Sitter\)\.html\. Rows from it go to Ann/);
  button(el, "Copy code").click();
  assert.equal(did.at(-1), "Copied Sitter's code; send it privately");
});
