import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUEST_SEAL_SOURCE, b64url, fromB64url, guestKeyBytes, identityText, kindKeys, newIdentity, newKindKey, newSigningKey, open, readIdentity, seal, signerOf,
  writerOf, type Payload,
} from "../src/share-crypto.ts";

const ADD: Payload = { t: "add", id: "0123456789abcdef", r: { task: "Bins", who: "Sam", at: "2026-11-18T20:00-05:00" } };
const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (u: Uint8Array) => u as BufferSource;

/** What a member holding the kind's key could do to a message: open it, change what it holds, and seal it again. */
async function reseal(text: string, topic: string, key: CryptoKey, change: (inner: { p: string; s: string }) => { p: string; s: string }): Promise<string> {
  const [, kid, ivText, ctText] = text.split(".");
  const plain = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64url(ivText)!), additionalData: buf(enc.encode(`gz1.${kid}.${topic}`)) }, key, buf(fromB64url(ctText)!))));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: buf(enc.encode(`gz1.${kid}.${topic}`)) }, key, buf(enc.encode(JSON.stringify(change(plain))))));
  return `gz1.${kid}.${b64url(iv)}.${b64url(ct)}`;
}

test("a member's secret keeps the kind's key, its own signing key and its name; anything else isn't one", async () => {
  const id = await newIdentity("Mai");
  const back = readIdentity(identityText(id))!;
  assert.deepEqual([b64url(back.key), back.sign, back.name], [b64url(id.key), id.sign, "Mai"]);
  assert.equal(readIdentity("gzk1.abc"), undefined);
  assert.equal(readIdentity(null), undefined);
  assert.equal(readIdentity(identityText(id).replace(/^gzk1/, "gzk2")), undefined);
});

test("a member's message opens with the kind's key: its writer is its signing key's fingerprint, and the topic says nothing of the key", async () => {
  const id = await newIdentity("Mai");
  const keys = await kindKeys(id.key);
  const signer = await signerOf(id.sign, id.name);
  const text = await seal(keys.topic, "m", keys.member, signer, ADD);
  assert.match(text, /^gz1\.m\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!text.includes("Bins") && !text.includes("Mai"), "the relay sees no row and no name");
  assert.match(keys.topic, /^gz[0-9a-f]{30}$/);
  assert.ok(!keys.topic.includes(b64url(id.key).slice(0, 6)));
  assert.deepEqual(await open(text, keys.topic, keys), { kid: "m", writer: await writerOf(id.sign), name: "Mai", payload: ADD });
  assert.equal(keys.topic, (await kindKeys(id.key)).topic, "the same key, the same topic, on every device");
});

test("a changed, cut short or foreign message is refused: tampering, the wrong key, the wrong signature, another kind's topic", async () => {
  const id = await newIdentity("Mai");
  const keys = await kindKeys(id.key);
  const signer = await signerOf(id.sign, id.name);
  const text = await seal(keys.topic, "m", keys.member, signer, ADD);
  const wrongKey = "it can't be opened with this kind's key: changed, cut short, or sealed with another key";

  // One character of the ciphertext changed.
  const at = text.length - 10;
  const flipped = text.slice(0, at) + (text[at] === "A" ? "B" : "A") + text.slice(at + 1);
  assert.deepEqual(await open(flipped, keys.topic, keys), { error: wrongKey });
  // Cut short, at the end and in the middle.
  assert.deepEqual(await open(text.slice(0, -8), keys.topic, keys), { error: wrongKey });
  assert.deepEqual(await open(text.slice(0, 30), keys.topic, keys), { error: wrongKey });
  assert.deepEqual(await open(text.slice(0, 23), keys.topic, keys), { error: "not a shared row" });
  assert.deepEqual(await open("hello", keys.topic, keys), { error: "not a shared row" });
  // Another kind's key, or the same key on another kind's topic.
  const other = await kindKeys(newKindKey());
  assert.deepEqual(await open(text, other.topic, other), { error: wrongKey });
  assert.deepEqual(await open(text, other.topic, keys), { error: wrongKey });

  // A member who holds the key can seal anything, but can't sign as someone else.
  const mallory = await signerOf(await newSigningKey(), "Mallory");
  const forged = await reseal(text, keys.topic, keys.member, ({ p, s }) => ({ p: p.replace(`"w":"${signer.pub}"`, `"w":"${mallory.pub}"`), s }));
  assert.deepEqual(await open(forged, keys.topic, keys), { error: "its signature doesn't match the key it names" });
  const changed = await reseal(text, keys.topic, keys.member, ({ p, s }) => ({ p: p.replace("Bins", "Dishes"), s }));
  assert.deepEqual(await open(changed, keys.topic, keys), { error: "its signature doesn't match the key it names" });
  // A signature made for another topic doesn't carry over.
  const moved = await seal(other.topic, "m", keys.member, signer, ADD);
  const [, , ivText, ctText] = moved.split(".");
  assert.ok(ivText && ctText);
  assert.deepEqual(await open(`gz1.m.${ivText}.${ctText}`, keys.topic, keys), { error: wrongKey });
});

test("a guest page's key seals only its own adds: members open them; it opens nothing a member sealed, nor another page's", async () => {
  const id = await newIdentity("Mai");
  const keys = await kindKeys(id.key);
  const member = await signerOf(id.sign, id.name);
  const page = await newSigningKey();
  const pageWriter = await writerOf(page);
  const guestRaw = await guestKeyBytes(id.key, pageWriter);
  const guestOnly = await crypto.subtle.importKey("raw", buf(guestRaw), "AES-GCM", false, ["encrypt", "decrypt"]);
  const guest = await signerOf(page, "Sitter");

  // What the page sends, members read.
  const added = await seal(keys.topic, pageWriter, guestOnly, guest, ADD);
  assert.deepEqual(await open(added, keys.topic, keys), { kid: pageWriter, writer: pageWriter, name: "Sitter", payload: ADD });

  // The page's key opens no member's message: AES-GCM refuses it, whatever the page does with it.
  const fromMember = await seal(keys.topic, "m", keys.member, member, ADD);
  const [, , iv, ct] = fromMember.split(".");
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64url(iv)!), additionalData: buf(enc.encode(`gz1.m.${keys.topic}`)) }, guestOnly, buf(fromB64url(ct)!)));
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64url(iv)!), additionalData: buf(enc.encode(`gz1.${pageWriter}.${keys.topic}`)) }, guestOnly, buf(fromB64url(ct)!)));
  // Nor another page's rows.
  const other = await newSigningKey();
  const otherWriter = await writerOf(other);
  const theirs = await seal(keys.topic, otherWriter, await keys.guest(otherWriter), await signerOf(other, "Neighbour"), ADD);
  const [, , iv2, ct2] = theirs.split(".");
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64url(iv2)!), additionalData: buf(enc.encode(`gz1.${otherWriter}.${keys.topic}`)) }, guestOnly, buf(fromB64url(ct2)!)));

  // A page can only add, and only as itself.
  assert.deepEqual(await open(await seal(keys.topic, pageWriter, guestOnly, guest, { t: "retract", id: "0123456789abcdef" }), keys.topic, keys), { error: "a guest page can only add rows" });
  assert.deepEqual(await open(await seal(keys.topic, pageWriter, guestOnly, await signerOf(other, "Sitter"), ADD), keys.topic, keys), { error: "a guest page's key, signed by another key" });
});

test("the guest page's own script seals what members open", async () => {
  const id = await newIdentity("Mai");
  const keys = await kindKeys(id.key);
  const page = await newSigningKey();
  const pageWriter = await writerOf(page);
  const raw = await guestKeyBytes(id.key, pageWriter);
  // The page runs this text as it is; so does this test.
  const gzSeal = new Function(`${GUEST_SEAL_SOURCE}; return gzSeal;`)() as (...a: unknown[]) => Promise<string>;
  const text = await gzSeal(keys.topic, pageWriter, raw, page, "Sitter", ADD);
  assert.deepEqual(await open(text, keys.topic, keys), { kid: pageWriter, writer: pageWriter, name: "Sitter", payload: ADD });
});
