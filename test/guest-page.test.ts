import assert from "node:assert/strict";
import { test } from "node:test";
import { guestCheck, guestCode, guestPageHtml, names, readGuestCode } from "../src/guest-page.ts";
import { inviteKeys, inviteLink, readInvite } from "../src/share.ts";
import { b64url, guestKeyBytes, kindKeys, newIdentity, newSigningKey, open, topicOf, writerOf } from "../src/share-crypto.ts";
import { parseHTML } from "linkedom";

const PAGE = {
  kind: "Chore", fields: { task: "text", who: ["Alex", "Sam"], minutes: "number", done: "checkbox" }, labels: { minutes: "Minutes" },
  relay: "https://ntfy.sh", topic: "gz0123456789abcdef0123456789abcd", writer: "0123456789abcdef", guest: "Sitter", members: ["Ann", "Bo"], check: "fedcba9876543210",
};

/** A page's script run on its HTML in linkedom, as a browser opens it from `hash`, posting with `fetch`; what it shows and sent. */
function runPage(html: string, hash: string, fetch: (url: string, init: { body: string }) => Promise<{ ok: boolean; status: number }>) {
  const { document: doc, window: win } = parseHTML(html.replace(/<script>[\s\S]*<\/script>/, ""));
  function Option(text: string, value: string) {
    const o = doc.createElement("option");
    o.textContent = text;
    o.setAttribute("value", value);
    return o;
  }
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  new Function("window", "document", "location", "fetch", "Option", script)({ crypto }, doc, { hash }, fetch, Option);
  return { doc, win };
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

test("a guest page is one file that loads nothing, holds no key, can reach only its relay, and says who gets its rows", async () => {
  const id = await newIdentity("Ann");
  const sign = await newSigningKey();
  const key = await guestKeyBytes(id.key, await writerOf(sign));
  const html = guestPageHtml({ ...PAGE, topic: await topicOf(id.key) });
  for (const secret of [b64url(id.key), id.sign.d, sign.d, b64url(key)]) assert.ok(!html.includes(secret), "no key in the file");
  assert.doesNotMatch(html, /<script[^>]+src|<link[^>]+href|@import|\burl\(/, "nothing loaded from anywhere");
  assert.deepEqual([...html.matchAll(/https?:\/\/[^\s"'<>`)]+/g)].map((m) => m[0]).filter((u) => !u.startsWith("https://ntfy.sh")), []);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https:\/\/ntfy\.sh;/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(html.includes("This page is for Sitter. It adds a row to Chore, a list that Ann and Bo keep in Gizmo."));
  assert.ok(html.includes("Each row you add goes to Ann and Bo, sealed, through ntfy.sh, which sees only scrambled text. You can add rows here; you can't see theirs"));
  // Its script reads as JavaScript, the page's name and words can't break out of it.
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  assert.doesNotThrow(() => new Function(script));
  const hostile = guestPageHtml({ ...PAGE, kind: "</script><script>alert(1)</script>", guest: "<b>x</b>" });
  assert.equal(hostile.match(/<script>/g)!.length, 1);
  assert.ok(!hostile.includes("<b>x</b>"));
});

test("a guest page's code carries its own sealing and signing keys, and nothing else reads as one", async () => {
  const sign = await newSigningKey();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const code = guestCode(key, sign);
  assert.deepEqual(readGuestCode(`#${code}`), { key, sign });
  assert.equal(readGuestCode(code.slice(0, -4)), undefined);
  assert.equal(readGuestCode(code.replace("gzg1", "gzk1")), undefined);
  assert.deepEqual([names([]), names(["Ann"]), names(["Ann", "Bo"]), names(["Ann", "Bo", "Cy"])], ["the people who share it", "Ann", "Ann and Bo", "Ann, Bo and Cy"]);
});

test("an invite carries the kind's shape, how it is shared and its key, never its import folders or rules; a cut one says so", async () => {
  const id = await newIdentity("Ann");
  const fm = { kind: "chore", fields: { task: "text" }, share: { relay: "https://ntfy.sh", key: { secret: "chore-key" } }, import: { folder: "Inbox" }, expect: [{ every: "day" }] };
  const link = inviteLink({ name: "Chore", fm: inviteKeys(fm), key: id.key, from: "Ann", writer: "0123456789abcdef" });
  assert.match(link, /^obsidian:\/\/gizmo\?invite=[A-Za-z0-9_-]+$/);
  const back = readInvite(link);
  assert.ok(!("error" in back));
  assert.deepEqual(back.fm, { kind: "chore", fields: { task: "text" }, share: { relay: "https://ntfy.sh", key: { secret: "chore-key" } } });
  assert.deepEqual([back.name, back.from, back.writer, b64url(back.key)], ["Chore", "Ann", "0123456789abcdef", b64url(id.key)]);
  assert.deepEqual(readInvite(link.slice(0, 60)), { error: "this isn't an invite to a shared kind; ask for the link again" });
  assert.deepEqual(readInvite("hello"), { error: "this isn't an invite to a shared kind; ask for the link again" });
  const made = (name: string, more: Record<string, unknown> = {}) => readInvite(inviteLink({ name, fm: { ...inviteKeys(fm), ...more }, key: id.key, from: "Ann", writer: "0123456789abcdef" }));
  assert.deepEqual(made("../Elsewhere"), { error: "this invite names its kind “../Elsewhere”, which can't be a note's name" });
  assert.deepEqual(made(".hidden"), { error: "this invite names its kind “.hidden”, which can't be a note's name" });
  assert.deepEqual(made("Chore", { share: "yes" }), { error: "this invite doesn't say where its rows go; ask for the link again" });
});

test("a guest page's form works for fields named as a form's own properties (length, item), and a field called at is its When, drawn once", async () => {
  const id = await newIdentity("Ann");
  const keys = await kindKeys(id.key);
  const sign = await newSigningKey();
  const writer = await writerOf(sign);
  const raw = await guestKeyBytes(id.key, writer);
  const html = guestPageHtml({ ...PAGE, fields: { item: "text", length: "number", at: "text", done: "checkbox" }, topic: keys.topic, writer, check: await guestCheck(raw, sign) });
  const { document: doc, window: win } = parseHTML(html.replace(/<script>[\s\S]*<\/script>/, ""));
  const posted: string[] = [];
  const fetch = async (_url: string, init: { body: string }) => (posted.push(init.body), { ok: true, status: 200 });
  function Option(text: string, value: string) {
    const o = doc.createElement("option");
    o.textContent = text;
    o.setAttribute("value", value);
    return o;
  }
  // As a browser's form.elements: its own length and item come before a control of that name.
  Object.defineProperty(doc.getElementById("form"), "elements", {
    get(this: Element) {
      const list = [...this.querySelectorAll("input, select, textarea, button")];
      const named: Record<string, unknown> = { length: list.length, item: (i: number) => list[i] ?? null };
      for (const el of list) {
        const name = el.getAttribute("name") ?? el.id;
        if (name && !(name in named)) named[name] = el;
      }
      return named;
    },
  });
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  new Function("window", "document", "location", "fetch", "Option", script)({ crypto }, doc, { hash: `#${guestCode(raw, sign)}` }, fetch, Option);
  // The page checks the code is its own before it draws the form.
  await until(() => !!doc.querySelector("#f-at"));
  assert.equal(doc.querySelectorAll("#f-at").length, 1, "one When");
  assert.equal(doc.querySelectorAll("#form label").length, 4, "item, length, done and When");
  (doc.getElementById("f-item") as unknown as { value: string }).value = "Bins";
  (doc.getElementById("f-length") as unknown as { value: string }).value = "3";
  (doc.getElementById("f-at") as unknown as { value: string }).value = "2026-11-18T07:00";
  doc.getElementById("form")!.dispatchEvent(new win.Event("submit"));
  for (let i = 0; i < 100 && !posted.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted.length, 1);
  const opened = await open(posted[0], keys.topic, keys);
  assert.ok(!("error" in opened) && opened.payload.t === "add");
  const { r } = opened.payload as { r: Record<string, unknown> };
  assert.deepEqual([r.item, r.length, String(r.at).slice(0, 16)], ["Bins", 3, "2026-11-18T07:00"]);
  assert.equal(Object.keys(r).sort().join(), "at,item,length");
});

test("a guest page knows its own code: one cut short, changed or another page's says it isn't for this page, shows no form and sends nothing; its own opens the form", async () => {
  const id = await newIdentity("Ann");
  const keys = await kindKeys(id.key);
  const page = async () => {
    const sign = await newSigningKey();
    const writer = await writerOf(sign);
    const key = await guestKeyBytes(id.key, writer);
    return { code: guestCode(key, sign), html: guestPageHtml({ ...PAGE, topic: keys.topic, writer, check: await guestCheck(key, sign) }) };
  };
  const mine = await page();
  const other = await page();
  for (const secret of [b64url(id.key), id.sign.d]) assert.ok(!mine.html.includes(secret), "still no key in the file");
  // Four characters of the page's own key changed, each to another that reads as base64.
  const parts = mine.code.split(".");
  parts[1] = [...parts[1]].map((c, i) => (i >= 10 && i < 14 ? (c === "A" ? "B" : "A") : c)).join("");
  const changed = parts.join(".");
  assert.ok(readGuestCode(changed), "it still reads as a code");
  const NOT_OURS = "This code isn't for this page. It may be cut short or changed, or be the code of another page; ask Ann and Bo for this page's code.";
  const posted: string[] = [];
  const fetch = async (_url: string, init: { body: string }) => (posted.push(init.body), { ok: true, status: 200 });
  for (const [what, hash] of [["changed", changed], ["another page's", other.code], ["cut short", mine.code.slice(0, -6)]]) {
    const { doc } = runPage(mine.html, `#${hash}`, fetch);
    await until(() => !doc.getElementById("needs")!.hasAttribute("hidden"));
    assert.equal(doc.getElementById("needs")!.hasAttribute("hidden"), false, what);
    assert.equal(doc.getElementById("form")!.hasAttribute("hidden"), true, `${what}: no form`);
    assert.equal(doc.getElementById("why")!.textContent, NOT_OURS, what);
  }
  // Pasted, the same: a wrong code says so; this page's own opens the form.
  const { doc, win } = runPage(mine.html, "", fetch);
  await until(() => !doc.getElementById("needs")!.hasAttribute("hidden"));
  assert.equal(doc.getElementById("why")!.textContent, "");
  (doc.getElementById("code") as unknown as { value: string }).value = other.code;
  doc.getElementById("use")!.dispatchEvent(new win.Event("click"));
  await until(() => doc.getElementById("why")!.textContent !== "");
  assert.equal(doc.getElementById("why")!.textContent, NOT_OURS);
  assert.equal(doc.getElementById("form")!.hasAttribute("hidden"), true);
  (doc.getElementById("code") as unknown as { value: string }).value = ` ${mine.code} `;
  doc.getElementById("use")!.dispatchEvent(new win.Event("click"));
  await until(() => !doc.getElementById("form")!.hasAttribute("hidden"));
  assert.equal(doc.getElementById("form")!.hasAttribute("hidden"), false);
  assert.deepEqual(posted, [], "nothing was sent");
});

test("a guest page says Added only when the relay took the row; refused or unreachable, it says nothing was added and keeps what was typed", async () => {
  const id = await newIdentity("Ann");
  const keys = await kindKeys(id.key);
  const sign = await newSigningKey();
  const writer = await writerOf(sign);
  const key = await guestKeyBytes(id.key, writer);
  const html = guestPageHtml({ ...PAGE, fields: { task: "text", minutes: "number" }, relay: "https://relay.test", topic: keys.topic, writer, check: await guestCheck(key, sign) });
  const said = async (fetch: Parameters<typeof runPage>[2]) => {
    const { doc, win } = runPage(html, `#${guestCode(key, sign)}`, fetch);
    await until(() => !!doc.querySelector("#f-task"));
    // As a browser has them: every control's value is text, empty until typed in.
    for (const [f, v] of [["task", "Bins"], ["minutes", ""], ["at", "2026-11-18T07:00"]]) (doc.getElementById(`f-${f}`) as unknown as { value: string }).value = v;
    doc.getElementById("form")!.dispatchEvent(new win.Event("submit"));
    await until(() => !["", "Sending…"].includes(doc.getElementById("said")?.textContent ?? ""));
    return [doc.getElementById("said")!.textContent, (doc.getElementById("f-task") as unknown as { value: string }).value, doc.getElementById("sent")!.hasAttribute("hidden")];
  };
  assert.deepEqual(await said(async () => ({ ok: true, status: 200 })), ["Added. Ann and Bo will see it the next time Gizmo reads relay.test.", "", false]);
  assert.deepEqual(await said(async () => ({ ok: false, status: 500 })), ["Not sent: relay.test answered 500. Nothing was added; try again.", "Bins", true]);
  assert.deepEqual(await said(async () => { throw new TypeError("Failed to fetch"); }), ["Not sent: Failed to fetch. Nothing was added; try again.", "Bins", true]);
});
