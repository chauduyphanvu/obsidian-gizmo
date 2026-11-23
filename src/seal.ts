/**
 * Sealed records: proof that a kind's rows weren't written later than they say, or changed since.
 * A seal is a hash over every line the kind's event logs held when it was made, chained to the seal
 * before it; with an authority (`seal: {authority: https://…}`), the seal's hash is also sent to a
 * time-stamp authority (RFC 3161), whose signed answer says the hash existed at that time. Only the
 * hash leaves the vault, 32 bytes that give back nothing of the rows. A seal proves when a line was
 * written and that it is still the same; it can't prove that what the line says is true.
 */
import { stableJson } from "./hash.ts";
import { isPlainObject } from "./keys.ts";
import { logFolder } from "./ledger.ts";

/** A kind's `seal:` key: sealed on this device alone, or also time-stamped by an authority at this address. */
export interface SealSpec {
  authority?: string;
  host?: string;
}

const SEAL_HELP = "seal is true, or names a time-stamp authority, e.g. seal: {authority: https://freetsa.org/tsr}";

export function readSeal(value: unknown): { seal?: SealSpec; errors: string[] } {
  if (value === undefined || value === null || value === false) return { errors: [] };
  if (value === true) return { seal: {}, errors: [] };
  if (!isPlainObject(value) || Object.keys(value).some((k) => k !== "authority")) return { errors: [SEAL_HELP] };
  let url: URL | undefined;
  try {
    url = typeof value.authority === "string" ? new URL(value.authority) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || url.username || url.hash) return { errors: [`seal: authority must be the https address of a time-stamp authority, not ${JSON.stringify(value.authority ?? "")}; ${SEAL_HELP}`] };
  return { seal: { authority: url.toString(), host: url.host }, errors: [] };
}

/** One seal: what each log file held, by its first `lines` whole lines, chained to the seal before. */
export interface Seal {
  v: 1;
  /** When this device made it (ms): its own word, which the authority's token, when there is one, stands behind. */
  at: number;
  device: string;
  /** Each log file by name: how many whole lines of it are sealed, and the SHA-256 of those lines. */
  files: Record<string, { lines: number; hash: string }>;
  /** The root of the seal before it in this device's chain; empty for the first. */
  prev: string;
  /** SHA-256 of `prev`, a line break, and `files` as stable JSON. */
  root: string;
  /** The authority's answer for `root` (a TimeStampResp, base64), and where it came from. */
  token?: string;
  authority?: string;
}

/** A device's seals for one data note: beside its logs, one JSON seal a line. Not a `.jsonl`, so no ledger reads it. */
export function sealsFile(dataPath: string, device: string): string {
  return `${logFolder(dataPath)}/${device}.seals`;
}

export const isSealsFile = (path: string) => path.endsWith(".seals");

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

/** How many whole lines a log's text holds: a line cut short by a write in progress isn't sealed. */
export function wholeLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** The first `lines` whole lines of a text, each with its line break; undefined when it holds fewer. */
export function firstLines(text: string, lines: number): string | undefined {
  let at = 0;
  for (let n = 0; n < lines; n++) {
    const next = text.indexOf("\n", at);
    if (next === -1) return undefined;
    at = next + 1;
  }
  return text.slice(0, at);
}

async function rootOf(prev: string, files: Seal["files"]): Promise<string> {
  return sha256Hex(`${prev}\n${stableJson(files)}`);
}

/**
 * A seal over the logs as they are (file name → text), going on from the device's last one.
 * Undefined when they hold nothing the last seal doesn't.
 */
export async function makeSeal(logs: Record<string, string>, prev: Seal | undefined, at: number, device: string): Promise<Seal | undefined> {
  const files: Seal["files"] = {};
  for (const name of Object.keys(logs).sort()) {
    const lines = wholeLines(logs[name]);
    if (lines) files[name] = { lines, hash: await sha256Hex(firstLines(logs[name], lines)!) };
  }
  if (!Object.keys(files).length || (prev && stableJson(prev.files) === stableJson(files))) return undefined;
  const before = prev?.root ?? "";
  return { v: 1, at, device, files, prev: before, root: await rootOf(before, files) };
}

export function parseSeals(text: string): Seal[] {
  const out: Seal[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as Seal;
      if (s && s.v === 1 && typeof s.root === "string" && typeof s.prev === "string" && isPlainObject(s.files) && typeof s.at === "number") out.push(s);
    } catch {
      // A line cut short is no seal.
    }
  }
  return out;
}

/** How one chain of seals stands against the logs. */
export interface SealCheck {
  ok: boolean;
  problems: string[];
  /** Each seal that holds, with the time it stands for: the authority's when its token names the seal's root, else the device's own. */
  held: { seal: Seal; time: number; stamped: boolean }[];
}

const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

/**
 * Checks one device's chain, oldest first, against the logs: each seal goes on from the one before,
 * its root is the hash of what it says, and each file still starts with the lines it sealed. A
 * token must name the seal's own root. A seal that fails, and every seal after it, doesn't hold.
 */
export async function checkSeals(seals: readonly Seal[], logs: Record<string, string>): Promise<SealCheck> {
  const problems: string[] = [];
  const held: SealCheck["held"] = [];
  let prev = "";
  for (const s of seals) {
    const before = problems.length;
    if (s.prev !== prev) problems.push(`the seal of ${day(s.at)} UTC doesn't go on from the one before it: a seal is missing or out of order`);
    if ((await rootOf(s.prev, s.files)) !== s.root) problems.push(`the seal of ${day(s.at)} UTC isn't the hash of what it lists`);
    for (const [name, f] of Object.entries(s.files)) {
      const text = logs[name];
      const first = text === undefined ? undefined : firstLines(text, f.lines);
      if (first === undefined) problems.push(`${name} no longer holds the ${f.lines} lines sealed on ${day(s.at)} UTC`);
      else if ((await sha256Hex(first)) !== f.hash) problems.push(`the first ${f.lines} lines of ${name} aren't what was sealed on ${day(s.at)} UTC`);
    }
    let time = s.at;
    let stamped = false;
    if (s.token !== undefined) {
      const read = readTimestamp(fromBase64(s.token));
      if ("error" in read) problems.push(`the time stamp on the seal of ${day(s.at)} UTC can't be read: ${read.error}`);
      else if (read.imprint !== s.root) problems.push(`the time stamp on the seal of ${day(s.at)} UTC is for another hash`);
      else {
        time = read.time;
        stamped = true;
      }
    }
    if (problems.length > before) break;
    held.push({ seal: s, time, stamped });
    prev = s.root;
  }
  return { ok: problems.length === 0, problems, held };
}

/** The earliest held seal, of any chain, that covers a line of a log file (its number from 1). */
export function sealedBy(checks: readonly SealCheck[], file: string, line: number): { time: number; stamped: boolean } | undefined {
  let best: { time: number; stamped: boolean } | undefined;
  for (const c of checks) {
    for (const h of c.held) {
      if ((h.seal.files[file]?.lines ?? 0) < line) continue;
      // A time an authority signed stands before one a device only says.
      if (!best || (h.stamped && !best.stamped) || (h.stamped === best.stamped && h.time < best.time)) best = { time: h.time, stamped: h.stamped };
    }
  }
  return best;
}

// ---- RFC 3161 ---------------------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  try {
    const s = atob(text);
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** id-sha256, 2.16.840.1.101.3.4.2.1, as DER. */
const SHA256_OID = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];

/**
 * A TimeStampReq for a SHA-256 hash, as DER: version 1, the hash with its algorithm, and a request
 * for the authority's certificate, so the answer can be checked on its own later.
 */
export function timestampQuery(rootHex: string): Uint8Array {
  const hash = fromHex(rootHex);
  if (hash.length !== 32) throw new Error("a seal's root is 32 bytes");
  const algorithm = [0x30, 0x0d, ...SHA256_OID, 0x05, 0x00];
  const imprint = [0x30, algorithm.length + 2 + 32, ...algorithm, 0x04, 0x20, ...hash];
  const body = [0x02, 0x01, 0x01, ...imprint, 0x01, 0x01, 0xff];
  return Uint8Array.from([0x30, body.length, ...body]);
}

interface Der {
  tag: number;
  /** The value's bytes. */
  body: Uint8Array;
  /** The values inside, for a constructed one. */
  kids: Der[];
}

/** Reads DER values from `bytes`; undefined when they aren't well formed. Depth is bounded: a token nests about ten deep. */
function der(bytes: Uint8Array, depth = 0): Der[] | undefined {
  const out: Der[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 2 > bytes.length) return undefined;
    const tag = bytes[at];
    let len = bytes[at + 1];
    at += 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4 || at + n > bytes.length) return undefined;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + bytes[at + i];
      at += n;
    }
    if (at + len > bytes.length) return undefined;
    const body = bytes.subarray(at, at + len);
    at += len;
    // A constructed value holds values; an OCTET STRING may wrap them (a token's content does).
    const inside = depth < 24 && (tag & 0x20 || tag === 0x04) ? der(body, depth + 1) : undefined;
    out.push({ tag, body, kids: inside ?? [] });
  }
  return out;
}

/** `20261122103000Z`, with or without a fraction of a second, as ms. */
function generalizedTime(body: Uint8Array): number | undefined {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?Z$/.exec(new TextDecoder().decode(body));
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0);
  return Number.isNaN(t) ? undefined : t;
}

/** A TSTInfo: version 1, a policy, the hash stamped with its algorithm, a serial number, the time. */
function tstInfo(node: Der): { time: number; imprint: string } | undefined {
  const [version, policy, imprint] = node.kids;
  if (node.tag !== 0x30 || version?.tag !== 0x02 || version.body.length !== 1 || version.body[0] !== 1 || policy?.tag !== 0x06) return undefined;
  const hash = imprint?.tag === 0x30 && imprint.kids[0]?.tag === 0x30 ? imprint.kids[1] : undefined;
  const at = node.kids.find((k) => k.tag === 0x18);
  const time = at && generalizedTime(at.body);
  return hash?.tag === 0x04 && time !== undefined ? { time, imprint: hex(hash.body) } : undefined;
}

function find<T>(nodes: readonly Der[], read: (n: Der) => T | undefined): T | undefined {
  for (const n of nodes) {
    const found = read(n) ?? find(n.kids, read);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * What a time-stamp authority answered (a TimeStampResp): the time it signed, and the hash it signed
 * it for. Its signature isn't checked here; `openssl ts -verify` checks it against the authority's
 * certificate, and the token is kept whole so anyone can.
 */
export function readTimestamp(resp: Uint8Array): { time: number; imprint: string } | { error: string } {
  const top = der(resp);
  const status = top?.[0]?.kids[0]?.kids[0];
  if (!top || top.length !== 1 || top[0].tag !== 0x30 || status?.tag !== 0x02) return { error: "it isn't a time-stamp answer" };
  const code = status.body[status.body.length - 1];
  if (status.body.length !== 1 || code > 1) return { error: `the authority refused (status ${code})` };
  return find(top[0].kids.slice(1), tstInfo) ?? { error: "it holds no time stamp" };
}
