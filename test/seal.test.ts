import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { describePermission, permissionsOf } from "../src/permissions.ts";
import { VERIFY_SOURCE, extractPage, type Extract } from "../src/seal-extract.ts";
import { checkNow, checkWords, extractOf, sealNow, type SealHost } from "../src/seal-run.ts";
import { checkSeals, firstLines, makeSeal, parseSeals, readSeal, readTimestamp, sealedBy, sha256Hex, timestampQuery, toBase64, wholeLines, type Seal } from "../src/seal.ts";
import { ROW_ID } from "../src/ledger-store.ts";
import { readSpec } from "../src/spec.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 19, 16, 14);
const ev = (t: number, op: Record<string, unknown>, n = 0) => `${JSON.stringify({ ...op, t: `${new Date(t).toISOString()}/${n}`, d: "d1" })}\n`;
const add = (t: number, row: string, v: Record<string, unknown>) => ev(t, { op: "add", l: "dose", row, v });

const R1 = "00000000000000a1";
const R2 = "00000000000000a2";
const R3 = "00000000000000a3";
const LOG = add(T0, R1, { at: "2026-11-19T08:14-08:00", what: "morning", taken: true }) + add(T0 + DAY, R2, { at: "2026-11-20T08:02-08:00", what: "morning", taken: true });
const FILE = "d1-2026-11.jsonl";

// ---- the key --------------------------------------------------------------------------------------

test("seal: true seals on this device alone; an authority must be an https address", () => {
  assert.deepEqual(readSeal(true), { seal: {}, errors: [] });
  assert.deepEqual(readSeal(undefined), { errors: [] });
  assert.deepEqual(readSeal(false), { errors: [] });
  assert.deepEqual(readSeal({ authority: "https://freetsa.org/tsr" }), { seal: { authority: "https://freetsa.org/tsr", host: "freetsa.org" }, errors: [] });
  assert.match(readSeal({ authority: "http://tsa.example/tsr" }).errors[0], /authority must be the https address/);
  assert.match(readSeal({ relay: "x" }).errors[0], /seal is true, or names a time-stamp authority/);
  assert.match(readSeal("yes").errors[0], /seal is true/);
});

test("a kind sealed with an authority asks to send it a hash; sealed alone, it asks nothing", () => {
  const notes = { resolve: () => undefined, frontmatter: () => undefined } as never;
  const kind = (seal: unknown) => readSpec({ kind: "dose", fields: { what: ["morning", "evening"] }, seal }, { path: "Kinds/Dose.md", notes })!;
  const stamped = kind({ authority: "https://freetsa.org/tsr" });
  assert.deepEqual(stamped.errors, []);
  assert.deepEqual(permissionsOf(stamped.spec!, "Kinds/Dose.md"), ["seal:Kinds/Dose.md|freetsa.org"]);
  assert.equal(describePermission("seal:Kinds/Dose.md|freetsa.org"), "Send a hash of the event logs of Dose to freetsa.org for a time stamp: 32 bytes that give back nothing of the rows");
  assert.deepEqual(permissionsOf(kind(true).spec!, "Kinds/Dose.md"), []);
  assert.deepEqual(kind({ authority: "ftp://x" }).errors.length, 1);
});

// ---- seals ----------------------------------------------------------------------------------------

test("lines: only whole lines are sealed, and the first few are given back with their breaks", () => {
  assert.equal(wholeLines("a\nb\nc"), 2);
  assert.equal(firstLines("a\nb\nc", 2), "a\nb\n");
  assert.equal(firstLines("a\nb\nc", 3), undefined);
});

test("a seal hashes each log's whole lines and goes on from the one before; nothing new makes no seal", async () => {
  const first = (await makeSeal({ [FILE]: LOG }, undefined, T0 + 2 * DAY, "d1"))!;
  assert.deepEqual(first.files, { [FILE]: { lines: 2, hash: await sha256Hex(LOG) } });
  assert.equal(first.prev, "");
  assert.equal(await makeSeal({ [FILE]: LOG }, first, T0 + 3 * DAY, "d1"), undefined);
  assert.equal(await makeSeal({ [FILE]: `${LOG}{"cut sh` }, first, T0 + 3 * DAY, "d1"), undefined, "a line still being written isn't sealed");
  const more = LOG + add(T0 + 3 * DAY, R3, { at: "2026-11-22T08:05-08:00", what: "morning", taken: true });
  const second = (await makeSeal({ [FILE]: more }, first, T0 + 3 * DAY, "d1"))!;
  assert.equal(second.prev, first.root);
  const check = await checkSeals([first, second], { [FILE]: more });
  assert.deepEqual(check.problems, []);
  assert.deepEqual(check.held.map((h) => [h.time, h.stamped]), [[T0 + 2 * DAY, false], [T0 + 3 * DAY, false]]);
  assert.deepEqual(sealedBy([check], FILE, 2), { time: T0 + 2 * DAY, stamped: false });
  assert.deepEqual(sealedBy([check], FILE, 3), { time: T0 + 3 * DAY, stamped: false });
  assert.equal(sealedBy([check], FILE, 4), undefined);
  assert.deepEqual(parseSeals(`${JSON.stringify(first)}\n{"cut\n${JSON.stringify(second)}\n`).map((s) => s.root), [first.root, second.root]);
});

test("a changed line, a missing seal or a seal edited by hand doesn't hold, and says which", async () => {
  const first = (await makeSeal({ [FILE]: LOG }, undefined, T0 + 2 * DAY, "d1"))!;
  const edited = LOG.replace('"taken":true', '"taken":false');
  assert.deepEqual((await checkSeals([first], { [FILE]: edited })).problems, [`the first 2 lines of ${FILE} aren't what was sealed on 2026-11-21 16:14 UTC`]);
  assert.deepEqual((await checkSeals([first], {})).problems, [`${FILE} no longer holds the 2 lines sealed on 2026-11-21 16:14 UTC`]);
  const more = LOG + add(T0 + 3 * DAY, R3, { at: "2026-11-22T08:05-08:00" });
  const second = (await makeSeal({ [FILE]: more }, first, T0 + 3 * DAY, "d1"))!;
  assert.match((await checkSeals([second], { [FILE]: more })).problems[0], /doesn't go on from the one before it/);
  const forged: Seal = { ...first, files: { [FILE]: { lines: 2, hash: await sha256Hex(edited) } } };
  assert.deepEqual((await checkSeals([forged], { [FILE]: edited })).problems, ["the seal of 2026-11-21 16:14 UTC isn't the hash of what it lists"]);
});

// ---- the authority --------------------------------------------------------------------------------

/** DER, as far as a made-up time-stamp answer needs it. */
function tlv(tag: number, ...parts: (number[] | Uint8Array)[]): number[] {
  const body = parts.flatMap((p) => [...p]);
  const len = body.length < 128 ? [body.length] : body.length < 256 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return [tag, ...len, ...body];
}
const SHA256 = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));

/** A TimeStampResp as an authority sends it, unsigned: status, then a token whose content is a TSTInfo for `hash` at `time`. */
function answer(hash: string, time: string, status = 0): Uint8Array {
  const info = tlv(0x30, tlv(0x02, [1]), tlv(0x06, [0x2a, 0x03, 0x04]), tlv(0x30, tlv(0x30, SHA256, tlv(0x05)), tlv(0x04, fromHex(hash))), tlv(0x02, [0x01, 0x02, 0x03]), tlv(0x18, [...new TextEncoder().encode(time)]));
  const encap = tlv(0x30, tlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04]), tlv(0xa0, tlv(0x04, info)));
  const signed = tlv(0x30, tlv(0x02, [3]), tlv(0x31), encap, tlv(0x31));
  const token = tlv(0x30, tlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]), tlv(0xa0, signed));
  return Uint8Array.from(tlv(0x30, tlv(0x30, tlv(0x02, [status])), ...(status > 1 ? [] : [token])));
}

test("the request for a time stamp is the hash with its algorithm, as RFC 3161 writes it", () => {
  const hash = "ab".repeat(32);
  const q = timestampQuery(hash);
  assert.equal(q.length, 59);
  assert.deepEqual([...q.slice(0, 5)], [0x30, 0x39, 0x02, 0x01, 0x01]);
  assert.deepEqual([...q.slice(24, 56)], [...fromHex(hash)]);
  assert.deepEqual([...q.slice(56)], [0x01, 0x01, 0xff]);
  assert.throws(() => timestampQuery("abcd"));
});

test("an authority's answer gives the time it signed and the hash it signed it for; a refusal and noise say so", () => {
  const hash = "cd".repeat(32);
  assert.deepEqual(readTimestamp(answer(hash, "20261122103000Z")), { time: Date.UTC(2026, 10, 22, 10, 30), imprint: hash });
  assert.deepEqual(readTimestamp(answer(hash, "20261122103000.5Z")), { time: Date.UTC(2026, 10, 22, 10, 30, 0, 500), imprint: hash });
  assert.deepEqual(readTimestamp(answer(hash, "20261122103000Z", 2)), { error: "the authority refused (status 2)" });
  assert.deepEqual(readTimestamp(new Uint8Array([1, 2, 3])), { error: "it isn't a time-stamp answer" });
  assert.deepEqual(readTimestamp(new TextEncoder().encode("<html>busy</html>")), { error: "it isn't a time-stamp answer" });
});

// ---- through the host -----------------------------------------------------------------------------

const DATA = "Kinds/Dose data.md";
const LOGS = "Kinds/Dose data/log";

function host(files: Record<string, string>, stamp?: (hash: string) => Uint8Array | number): SealHost & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    filesIn: (folder) => Object.keys(files).filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/")),
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`Can't find ${p}`);
      return files[p];
    },
    append: async (p, text) => { files[p] = (files[p] ?? "") + text; },
    ...(stamp && {
      postBytes: async (url, body) => {
        posts.push(url);
        const hash = [...body.slice(24, 56)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const out = stamp(hash);
        return typeof out === "number" ? { status: out, bytes: new Uint8Array() } : { status: 200, bytes: out };
      },
    }),
  };
}

test("sealing through the host: a seal a line in the device's own file, stamped when the kind names an authority", async () => {
  const files: Record<string, string> = { [`${LOGS}/${FILE}`]: LOG, [`${LOGS}/base.json`]: "{}" };
  const h = host(files, (hash) => answer(hash, "20261121161500Z"));
  const done = await sealNow(h, DATA, { authority: "https://tsa.test/tsr", host: "tsa.test" }, "d1", T0 + 2 * DAY);
  assert.equal(done.said, "Sealed 2 lines, time-stamped by tsa.test at 2026-11-21 16:15 UTC");
  assert.deepEqual(h.posts, ["https://tsa.test/tsr"]);
  assert.deepEqual(Object.keys(files).sort(), [`${LOGS}/base.json`, `${LOGS}/${FILE}`, `${LOGS}/d1.seals`]);
  const { checks } = await checkNow(h, DATA);
  assert.deepEqual(checks.map((c) => [c.device, c.ok, c.held.map((x) => [x.stamped, x.time])]), [["d1", true, [[true, Date.UTC(2026, 10, 21, 16, 15)]]]]);
  assert.equal(checkWords(checks, "Dose"), "Dose: 1 seal holds, 1 time-stamped by an authority; the last is of 2026-11-21 16:15 UTC");
  assert.equal((await sealNow(h, DATA, { authority: "https://tsa.test/tsr", host: "tsa.test" }, "d1", T0 + 3 * DAY)).said, "Nothing new to seal: every line is under the last seal");
});

test("sealing through the host: an authority that fails leaves a seal without a stamp, and says why", async () => {
  const files: Record<string, string> = { [`${LOGS}/${FILE}`]: LOG };
  const busy = await sealNow(host(files, () => 503), DATA, { authority: "https://tsa.test/tsr", host: "tsa.test" }, "d1", T0 + 2 * DAY);
  assert.equal(busy.said, "Sealed 2 lines, without a time stamp: tsa.test answered 503");
  assert.equal(busy.seal!.token, undefined);
  const other: Record<string, string> = { [`${LOGS}/${FILE}`]: LOG };
  const wrong = await sealNow(host(other, () => answer("00".repeat(32), "20261121161500Z")), DATA, { authority: "https://tsa.test/tsr", host: "tsa.test" }, "d1", T0 + 2 * DAY);
  assert.equal(wrong.said, "Sealed 2 lines, without a time stamp: the authority answered for another hash");
  const alone: Record<string, string> = { [`${LOGS}/${FILE}`]: LOG };
  assert.equal((await sealNow(host(alone), DATA, {}, "d1", T0 + 2 * DAY)).said, "Sealed 2 lines");
  assert.equal(checkWords((await checkNow(host(alone), DATA)).checks, "Dose"), "Dose: 1 seal holds; the last is of 2026-11-21 16:14 UTC");
  assert.equal((await sealNow(host({}), DATA, {}, "d1", T0)).said, "No rows are logged yet, so there is nothing to seal");
  assert.equal(checkWords((await checkNow(host({}), DATA)).checks, "Dose"), "Dose has no seal yet");
});

test("sealing again asks an authority that failed, with no new line, and adds a seal only when it answers", async () => {
  const files: Record<string, string> = { [`${LOGS}/${FILE}`]: LOG };
  const spec = { authority: "https://tsa.test/tsr", host: "tsa.test" };
  await sealNow(host(files, () => 503), DATA, spec, "d1", T0 + 2 * DAY);
  const still = await sealNow(host(files, () => 503), DATA, spec, "d1", T0 + 3 * DAY);
  assert.equal(still.said, "Nothing new to seal, without a time stamp: tsa.test answered 503");
  assert.equal(files[`${LOGS}/d1.seals`].trim().split("\n").length, 1);
  const h = host(files, (hash) => answer(hash, "20261123161500Z"));
  assert.equal((await sealNow(h, DATA, spec, "d1", T0 + 4 * DAY)).said, "Sealed 2 lines, time-stamped by tsa.test at 2026-11-23 16:15 UTC");
  const { checks } = await checkNow(h, DATA);
  assert.deepEqual(checks.map((c) => [c.ok, c.held.map((x) => x.stamped)]), [[true, [false, true]]]);
  assert.equal((await sealNow(h, DATA, spec, "d1", T0 + 5 * DAY)).said, "Nothing new to seal: every line is under the last seal");
});

test("a token for another hash on a kept seal is told by the check", async () => {
  const first = (await makeSeal({ [FILE]: LOG }, undefined, T0 + 2 * DAY, "d1"))!;
  const bad: Seal = { ...first, token: toBase64(answer("11".repeat(32), "20261121161500Z")) };
  assert.deepEqual((await checkSeals([bad], { [FILE]: LOG })).problems, ["the time stamp on the seal of 2026-11-21 16:14 UTC is for another hash"]);
});

// ---- the extract ----------------------------------------------------------------------------------

interface Verified { ok: boolean; problems: string[]; seals: number; stamped: number; rows: { id: string; written?: number; sets?: number; late?: boolean; sealed?: { time: number; stamped: boolean }; problem?: string }[] }
// The page's own checker, run here as the page runs it.
const verifyExtract = new Function(`${VERIFY_SOURCE}; return verifyExtract;`)() as (x: Extract) => Promise<Verified>;

const row = (id: string, values: Record<string, unknown>) => Object.defineProperty({ ...values }, ROW_ID, { value: id });

async function extractOfLogs(log: string, rows: Record<string, unknown>[]): Promise<Extract> {
  const files: Record<string, string> = { [`${LOGS}/${FILE}`]: log };
  const h = host(files, (hash) => answer(hash, "20261122090000Z"));
  await sealNow(h, DATA, { authority: "https://tsa.test/tsr", host: "tsa.test" }, "d1", T0 + 3 * DAY);
  return extractOf(h, DATA, { name: "Dose", list: "dose", fields: [{ name: "what", label: "Dose" }, { name: "taken", label: "Taken" }] }, rows, T0 + 4 * DAY);
}

test("the extract's own checker agrees with Gizmo's: every seal holds, each row is what the logs say, and a row written days late is marked", async () => {
  // A third row said to be from the 19th, written on the 22nd.
  const late = add(T0 + 2.9 * DAY, R3, { at: "2026-11-19T20:00-08:00", what: "evening", taken: true });
  const edit = ev(T0 + 2.95 * DAY, { op: "set", l: "dose", row: R2, f: "what", v: "evening", from: "morning" });
  const x = await extractOfLogs(LOG + late + edit, [
    row(R1, { at: "2026-11-19T08:14-08:00", what: "morning", taken: true }),
    row(R2, { at: "2026-11-20T08:02-08:00", what: "evening", taken: true }),
    row(R3, { at: "2026-11-19T20:00-08:00", what: "evening", taken: true }),
  ]);
  const v = await verifyExtract(x);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.deepEqual([v.seals, v.stamped], [1, 1]);
  assert.deepEqual(v.rows.map((r) => [r.id, r.sets, r.late, r.sealed?.stamped]), [[R1, 0, false, true], [R2, 1, false, true], [R3, 0, true, true]]);
  assert.equal(v.rows[0].written, T0);
  assert.equal(v.rows[0].sealed!.time, Date.UTC(2026, 10, 22, 9, 0));
  const mine = await checkSeals(x.chains[0], x.logs);
  assert.deepEqual(mine.problems, []);
});

test("the extract's own checker: a log line changed after sealing, and a row shown otherwise than the logs say, both fail", async () => {
  const rows = [row(R1, { at: "2026-11-19T08:14-08:00", what: "morning", taken: true }), row(R2, { at: "2026-11-20T08:02-08:00", what: "morning", taken: true })];
  const good = await extractOfLogs(LOG, rows);
  const tampered: Extract = { ...good, logs: { [FILE]: good.logs[FILE].replace("08:14-08:00", "07:14-08:00") }, rows: [{ id: R1, row: { ...good.rows[0].row, at: "2026-11-19T07:14-08:00" } }, good.rows[1]] };
  const t = await verifyExtract(tampered);
  assert.equal(t.ok, false);
  assert.deepEqual(t.problems, [`the first 2 lines of ${FILE} aren't what was sealed on 2026-11-22 16:14 UTC`]);
  assert.deepEqual((await checkSeals(tampered.chains[0], tampered.logs)).problems, t.problems, "the page and Gizmo say the same");
  const reworded: Extract = { ...good, rows: [{ id: R1, row: { ...good.rows[0].row, taken: false } }, good.rows[1]] };
  assert.deepEqual((await verifyExtract(reworded)).problems, [`row ${R1}: the logs give another taken for this row`]);
  const invented: Extract = { ...good, rows: [...good.rows, { id: "ffffffffffffffff", row: { at: "2026-11-21T08:00-08:00", what: "morning", taken: true } }] };
  assert.deepEqual((await verifyExtract(invented)).problems, ["row ffffffffffffffff: no event in the logs adds this row"]);
});

test("the extract calls a row sealed only when every line it rests on is: an undo written since leaves it not sealed yet", async () => {
  const at = "2026-11-19T08:14-08:00";
  const setAt = T0 + DAY;
  const fixed = ev(setAt, { op: "set", l: "dose", row: R1, f: "what", v: "evening", from: "morning" });
  const x = await extractOfLogs(add(T0, R1, { at, what: "morning", taken: true }) + fixed, [row(R1, { at, what: "evening", taken: true })]);
  assert.ok((await verifyExtract(x)).rows[0].sealed);
  const undo = ev(T0 + 5 * DAY, { op: "undo", ev: [`d1@${new Date(setAt).toISOString()}/0`] });
  const v = await verifyExtract({ ...x, logs: { [FILE]: x.logs[FILE] + undo }, rows: [{ id: R1, row: { ...x.rows[0].row, what: "morning" } }] });
  assert.deepEqual(v.problems, []);
  assert.equal(v.rows[0].sealed, undefined);
});

test("the extract says in plain words when it can't run its check, and leaves no row saying it is still checking", async () => {
  const page = extractPage(await extractOfLogs(LOG, [row(R1, { at: "2026-11-19T08:14-08:00", what: "morning", taken: true })]));
  assert.match(page, /<noscript>.*hasn't been verified.*<\/noscript>/s, "a viewer that runs no scripts is told so");
  const { document } = parseHTML(page);
  const script = String([...document.querySelectorAll("script")].at(-1)!.textContent);
  // A page from a plain http address: the browser has no crypto.subtle.
  new Function("document", "window", "crypto", script)(document, { crypto: {} }, {});
  await new Promise((done) => setTimeout(done, 20));
  const verdict = String(document.getElementById("verdict")!.textContent);
  const proof = String(document.querySelector("tbody td:last-child")!.textContent);
  assert.match(verdict, /https/);
  assert.doesNotMatch(verdict, /undefined|evaluating|Cannot read/);
  assert.equal(proof, "not checked");
});

test("the extract is one file that loads nothing: its rows, its data and its checker inline", async () => {
  const x = await extractOfLogs(LOG, [row(R1, { at: "2026-11-19T08:14-08:00", what: "</script><b>morning", taken: true })]);
  const page = extractPage(x);
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">/);
  assert.equal(page.match(/<script/g)!.length, 2, "its data and its checker, and no script a row's text could open");
  assert.match(page, /<td>2026-11-19 08:14<\/td><td>&lt;\/script&gt;&lt;b&gt;morning<\/td><td>true<\/td><td>checking…<\/td>/);
  assert.doesNotMatch(page, /https?:\/\/(?!tsa\.test)/, "no address but the authority's, kept as data");
  const data = /<script id="data" type="application\/json">(.*)<\/script>\n<script>/s.exec(page)![1];
  assert.deepEqual((JSON.parse(data) as Extract).rows[0].id, R1);
});
