/**
 * The sealed messages a shared kind's rows travel in, through a relay that can read none of them.
 * WebCrypto only, so the same code runs in Obsidian, in gizmod and (as GUEST_SEAL_SOURCE) in a guest
 * page.
 *
 * A kind's key K (32 random bytes) is a secret each member keeps. From it come, by HKDF-SHA-256:
 * the AES-GCM key members seal their messages with, the relay topic (a hash, so the topic says
 * nothing of K), and for each guest page a key of its own, from K and the page's signing key. A
 * guest page holds only its own key, which opens nothing a member sealed and can't be turned back
 * into K or into another page's key. Every message is signed with its writer's ECDSA P-256 key; a
 * writer is the fingerprint of that key.
 *
 * Wire: `gz1.<kid>.<iv>.<ciphertext>`, kid `m` for a member's key or a guest page's fingerprint,
 * base64url, the ciphertext bound to `gz1.<kid>.<topic>`. Inside: `{"p": payload, "s": signature}`,
 * the payload `{"v":1,"w":<public key>,"n":<name>,"t":"add"|"retract"|"have",…}` as text, signed
 * together with the topic and kid.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => crypto.subtle;

/** ntfy's limit for a message's text; a longer one would arrive as an attachment, which polls don't read. */
export const MAX_MESSAGE = 4096;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", bytes as BufferSource));
}

async function hkdf(key: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await subtle().importKey("raw", key as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("gizmo share") as BufferSource, info: enc.encode(info) as BufferSource }, base, 256));
}

const aesKey = (raw: Uint8Array, usages: KeyUsage[]) => subtle().importKey("raw", raw as BufferSource, "AES-GCM", false, usages);

/** A writer's signing key as JWK's three parts, base64url; its public half is `x` and `y`. */
export interface SigningKey {
  d: string;
  x: string;
  y: string;
}

/** What a member keeps as the kind's secret: the kind's key, its own signing key and the name it writes under. */
export interface Identity {
  key: Uint8Array;
  sign: SigningKey;
  name: string;
}

const IDENTITY = "gzk1";

export function identityText(id: Identity): string {
  return [IDENTITY, b64url(id.key), id.sign.d, id.sign.x, id.sign.y, b64url(enc.encode(id.name))].join(".");
}

/** A kind's secret as its member keeps it; undefined when it isn't one. */
export function readIdentity(text: string | null | undefined): Identity | undefined {
  const parts = (text ?? "").trim().split(".");
  if (parts.length !== 6 || parts[0] !== IDENTITY) return undefined;
  const key = fromB64url(parts[1]);
  const name = fromB64url(parts[5]);
  if (key?.length !== 32 || !name || [2, 3, 4].some((i) => fromB64url(parts[i])?.length !== 32)) return undefined;
  return { key, sign: { d: parts[2], x: parts[3], y: parts[4] }, name: dec.decode(name) };
}

export function newKindKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A new ECDSA P-256 signing key. */
export async function newSigningKey(): Promise<SigningKey> {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle().exportKey("jwk", pair.privateKey);
  return { d: jwk.d!, x: jwk.x!, y: jwk.y! };
}

/** A member's identity for a kind: its key (a new one when not given) and a new signing key of its own. */
export async function newIdentity(name: string, key: Uint8Array = newKindKey()): Promise<Identity> {
  return { key, sign: await newSigningKey(), name };
}

/** A public key's raw bytes: 0x04, x, y. */
function rawPublic(x: string, y: string): Uint8Array | undefined {
  const xs = fromB64url(x);
  const ys = fromB64url(y);
  if (xs?.length !== 32 || ys?.length !== 32) return undefined;
  return Uint8Array.from([4, ...xs, ...ys]);
}

/** A writer: 16 hex characters of the SHA-256 of its public key. */
export async function fingerprint(publicRaw: Uint8Array): Promise<string> {
  return hex(await sha256(publicRaw)).slice(0, 16);
}

export async function writerOf(sign: SigningKey): Promise<string> {
  return fingerprint(rawPublic(sign.x, sign.y)!);
}

/** What a kind's key opens: the topic, the members' key, and each guest page's key on demand. */
export interface KindKeys {
  topic: string;
  member: CryptoKey;
  guest(writer: string): Promise<CryptoKey>;
}

/** Guest pages' keys kept made, at most: anyone who knows the topic can name any number of pages. */
const GUEST_KEYS = 64;

export async function kindKeys(key: Uint8Array): Promise<KindKeys> {
  const topic = `gz${hex(await sha256(await hkdf(key, "gizmo share v1 topic"))).slice(0, 30)}`;
  const member = await aesKey(await hkdf(key, "gizmo share v1 member"), ["encrypt", "decrypt"]);
  const guests = new Map<string, Promise<CryptoKey>>();
  const guest = (writer: string) => {
    let k = guests.get(writer);
    if (k) {
      guests.delete(writer);
      guests.set(writer, k);
      return k;
    }
    k = guestKeyBytes(key, writer).then((raw) => aesKey(raw, ["encrypt", "decrypt"]));
    guests.set(writer, k);
    if (guests.size > GUEST_KEYS) guests.delete(guests.keys().next().value!);
    return k;
  };
  return { topic, member, guest };
}

/** The key a guest page with this writer seals with: from the kind's key, never back to it. */
export function guestKeyBytes(key: Uint8Array, writer: string): Promise<Uint8Array> {
  return hkdf(key, `gizmo share v1 guest ${writer}`);
}

export async function topicOf(key: Uint8Array): Promise<string> {
  return (await kindKeys(key)).topic;
}

/**
 * What a message carries: a row added (with the id its writer gave it), one taken back, or how many
 * rows a member holds from each writer. `q` numbers a row's adds and take-backs, growing each time,
 * so a copy of an older one is told apart; a guest page sends none.
 */
export type Payload =
  | { t: "add"; id: string; r: Record<string, unknown>; q?: number }
  | { t: "retract"; id: string; q?: number }
  | { t: "have"; c: Record<string, Holding> };

/** What a member holds of one writer's rows: how many, how many set aside, and a digest of the ids of the rest. */
export type Holding = [number, number, string];

/** Who signs: their key, ready to sign, its public half and fingerprint, and the name they write under. */
export interface Signer {
  key: CryptoKey;
  pub: string;
  writer: string;
  name: string;
}

export async function signerOf(sign: SigningKey, name: string): Promise<Signer> {
  const key = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", d: sign.d, x: sign.x, y: sign.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const raw = rawPublic(sign.x, sign.y)!;
  return { key, pub: b64url(raw), writer: await fingerprint(raw), name };
}

const signed = (topic: string, kid: string, payload: string) => enc.encode(`gizmo-share-v1\n${topic}\n${kid}\n${payload}`);
const aad = (topic: string, kid: string) => enc.encode(`gz1.${kid}.${topic}`);

/** A payload sealed for the relay: signed by `signer`, then encrypted with `key` (the members' own, or a guest page's under kid). */
export async function seal(topic: string, kid: string, key: CryptoKey, signer: Signer, payload: Payload): Promise<string> {
  const p = JSON.stringify({ v: 1, w: signer.pub, n: signer.name, ...payload });
  const s = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, signer.key, signed(topic, kid, p)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad(topic, kid) }, key, enc.encode(JSON.stringify({ p, s: b64url(s) }))));
  return `gz1.${kid}.${b64url(iv)}.${b64url(ct)}`;
}

/** A message opened: whose key sealed it (`kid`), its writer, the name it gives and what it carries. */
export interface Opened {
  kid: string;
  writer: string;
  name: string;
  payload: Payload;
}

const WIRE = /^gz1\.(m|[0-9a-f]{16})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;
const ROW_ID = /^[0-9a-f]{16}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether a payload holds what its type says, each count a pair of whole numbers. */
function payloadOf(x: Record<string, unknown>): Payload | undefined {
  if (x.q !== undefined && !(Number.isSafeInteger(x.q) && (x.q as number) > 0)) return undefined;
  const q = x.q === undefined ? {} : { q: x.q as number };
  if (x.t === "add" && typeof x.id === "string" && ROW_ID.test(x.id) && isRecord(x.r)) return { t: "add", id: x.id, r: x.r, ...q };
  if (x.t === "retract" && typeof x.id === "string" && ROW_ID.test(x.id)) return { t: "retract", id: x.id, ...q };
  const holding = (n: unknown) => Array.isArray(n) && n.length === 3 && [n[0], n[1]].every((k) => Number.isInteger(k) && k >= 0) && typeof n[2] === "string" && /^[0-9a-f]{16}$/.test(n[2]);
  if (x.t === "have" && isRecord(x.c) && Object.entries(x.c).every(([w, n]) => /^[0-9a-f]{16}$/.test(w) && holding(n))) {
    return { t: "have", c: x.c as Record<string, Holding> };
  }
  return undefined;
}

/**
 * Opens what the relay holds for a kind's topic, or says why not: not one of these messages, cut
 * short or changed (AES-GCM refuses it), sealed with another key, signed by a key that isn't the
 * one it names, or a guest page's key used for more than adding a row of its own.
 */
export async function open(text: string, topic: string, keys: Pick<KindKeys, "member" | "guest">): Promise<Opened | { error: string }> {
  const m = WIRE.exec(text.trim());
  if (!m) return { error: "not a shared row" };
  const [, kid, ivText, ctText] = m;
  const iv = fromB64url(ivText);
  const ct = fromB64url(ctText);
  if (iv?.length !== 12 || !ct) return { error: "not a shared row" };
  let plain: string;
  try {
    const key = kid === "m" ? keys.member : await keys.guest(kid);
    plain = dec.decode(await subtle().decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(topic, kid) }, key, ct as BufferSource));
  } catch {
    return { error: "it can't be opened with this kind's key: changed, cut short, or sealed with another key" };
  }
  let outer: unknown;
  let inner: unknown;
  try {
    outer = JSON.parse(plain);
    inner = isRecord(outer) && typeof outer.p === "string" ? JSON.parse(outer.p) : undefined;
  } catch {
    return { error: "what it holds can't be read" };
  }
  if (!isRecord(outer) || typeof outer.s !== "string" || !isRecord(inner) || inner.v !== 1 || typeof inner.w !== "string" || typeof inner.n !== "string") return { error: "what it holds can't be read" };
  const payload = payloadOf(inner);
  const raw = fromB64url(inner.w);
  const sig = fromB64url(outer.s);
  if (!payload || raw?.length !== 65 || raw[0] !== 4 || sig?.length !== 64) return { error: "what it holds can't be read" };
  let ok: boolean;
  try {
    const pub = await subtle().importKey("raw", raw as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    ok = await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig as BufferSource, signed(topic, kid, outer.p as string));
  } catch {
    ok = false;
  }
  if (!ok) return { error: "its signature doesn't match the key it names" };
  const writer = await fingerprint(raw);
  if (kid !== "m" && kid !== writer) return { error: "a guest page's key, signed by another key" };
  if (kid !== "m" && payload.t !== "add") return { error: "a guest page can only add rows" };
  return { kid, writer, name: inner.n.slice(0, 60), payload };
}

/** A message's size as the relay counts it. */
export function messageBytes(text: string): number {
  return enc.encode(text).length;
}

/**
 * `seal` for a guest page, as plain script the page carries: it seals one row under the page's own
 * key and signs it with the page's own signing key, in the wire form `open` reads. The unit tests
 * run this very text and open what it seals.
 */
export const GUEST_SEAL_SOURCE = `async function gzSeal(topic, kid, aesRaw, sign, name, payload) {
  const enc = new TextEncoder();
  const s = crypto.subtle;
  const b64 = (bytes) => { let t = ""; for (const b of bytes) t += String.fromCharCode(b); return btoa(t).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
  const raw = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const pub = b64(Uint8Array.from([4, ...raw(sign.x), ...raw(sign.y)]));
  const key = await s.importKey("jwk", { kty: "EC", crv: "P-256", d: sign.d, x: sign.x, y: sign.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const p = JSON.stringify(Object.assign({ v: 1, w: pub, n: name }, payload));
  const sig = new Uint8Array(await s.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode("gizmo-share-v1\\n" + topic + "\\n" + kid + "\\n" + p)));
  const aes = await s.importKey("raw", aesRaw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("gz1." + kid + "." + topic) }, aes, enc.encode(JSON.stringify({ p, s: b64(sig) }))));
  return "gz1." + kid + "." + b64(iv) + "." + b64(ct);
}`;
