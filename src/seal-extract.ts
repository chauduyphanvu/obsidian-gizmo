/**
 * A sealed extract: one HTML file with a kind's rows, the event logs they come from, and the seals
 * over those logs. Opened anywhere, with nothing loaded from anywhere, it checks itself: that the
 * logs are still what each seal hashed, that each row shown is what the logs say it is, when each
 * row was written, and which seal first covered it. A row written long after the time it gives is
 * marked as written later. Each seal's time-stamp token is in the file whole, so its signature can
 * be checked against the authority's certificate with any RFC 3161 tool.
 */
import type { Row } from "./data.ts";
import type { Seal } from "./seal.ts";
import { textOf } from "./text.ts";

export interface Extract {
  /** The kind as the page calls it, e.g. Dose. */
  kind: string;
  /** The fields shown, in order, each with the name the page gives it. */
  fields: { name: string; label: string }[];
  /** The rows shown, each with its id in the ledger. */
  rows: { id: string; row: Row }[];
  /** The list the rows are in, as the logs name it. */
  list: string;
  /** Every log file by name: its text as it was when the extract was made. */
  logs: Record<string, string>;
  /** Each device's chain of seals, oldest first. */
  chains: Seal[][];
  /** When the extract was made (ms). */
  made: number;
  /** A row is marked as written later when its event came this long after the time it gives. */
  lateMs: number;
}

/** A day: what a row may trail its own time by before the page says it was written later. */
export const LATE_MS = 86_400_000;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The page's own checker, as it runs in the page: plain script, no imports, WebCrypto only. It
 * mirrors checkSeals and readTimestamp in seal.ts; test/seal.test.ts runs both on the same logs.
 */
export const VERIFY_SOURCE = String.raw`
async function sha256Hex(text) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
function firstLines(text, lines) {
  let at = 0;
  for (let n = 0; n < lines; n++) {
    const next = text.indexOf("\n", at);
    if (next === -1) return undefined;
    at = next + 1;
  }
  return text.slice(0, at);
}
function der(bytes, depth) {
  const out = [];
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
    const inside = depth < 24 && (tag & 0x20 || tag === 0x04) ? der(body, depth + 1) : undefined;
    out.push({ tag: tag, body: body, kids: inside || [] });
  }
  return out;
}
function tstInfo(node) {
  const version = node.kids[0], policy = node.kids[1], imprint = node.kids[2];
  if (node.tag !== 0x30 || !version || version.tag !== 0x02 || version.body.length !== 1 || version.body[0] !== 1 || !policy || policy.tag !== 0x06) return undefined;
  const hash = imprint && imprint.tag === 0x30 && imprint.kids[0] && imprint.kids[0].tag === 0x30 ? imprint.kids[1] : undefined;
  const at = node.kids.find((k) => k.tag === 0x18);
  if (!hash || hash.tag !== 0x04 || !at) return undefined;
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?Z$/.exec(new TextDecoder().decode(at.body));
  if (!m) return undefined;
  const time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(Number("0." + m[7]) * 1000) : 0);
  return { time: time, imprint: Array.from(hash.body, (b) => b.toString(16).padStart(2, "0")).join("") };
}
function findInfo(nodes) {
  for (const n of nodes) {
    const found = tstInfo(n) || findInfo(n.kids);
    if (found) return found;
  }
  return undefined;
}
function readTimestamp(b64) {
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch (e) { return { error: "it isn't a time-stamp answer" }; }
  const top = der(bytes, 0);
  const status = top && top[0] && top[0].kids[0] && top[0].kids[0].kids[0];
  if (!top || top.length !== 1 || top[0].tag !== 0x30 || !status || status.tag !== 0x02) return { error: "it isn't a time-stamp answer" };
  const code = status.body[status.body.length - 1];
  if (status.body.length !== 1 || code > 1) return { error: "the authority refused (status " + code + ")" };
  return findInfo(top[0].kids.slice(1)) || { error: "it holds no time stamp" };
}
const day = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
async function checkChain(seals, logs) {
  const problems = [], held = [];
  let prev = "";
  for (const s of seals) {
    const before = problems.length;
    if (s.prev !== prev) problems.push("the seal of " + day(s.at) + " UTC doesn't go on from the one before it: a seal is missing or out of order");
    if ((await sha256Hex(s.prev + "\n" + stable(s.files))) !== s.root) problems.push("the seal of " + day(s.at) + " UTC isn't the hash of what it lists");
    for (const name of Object.keys(s.files)) {
      const f = s.files[name];
      const first = logs[name] === undefined ? undefined : firstLines(logs[name], f.lines);
      if (first === undefined) problems.push(name + " no longer holds the " + f.lines + " lines sealed on " + day(s.at) + " UTC");
      else if ((await sha256Hex(first)) !== f.hash) problems.push("the first " + f.lines + " lines of " + name + " aren't what was sealed on " + day(s.at) + " UTC");
    }
    let time = s.at, stamped = false;
    if (s.token !== undefined) {
      const read = readTimestamp(s.token);
      if (read.error) problems.push("the time stamp on the seal of " + day(s.at) + " UTC can't be read: " + read.error);
      else if (read.imprint !== s.root) problems.push("the time stamp on the seal of " + day(s.at) + " UTC is for another hash");
      else { time = read.time; stamped = true; }
    }
    if (problems.length > before) break;
    held.push({ seal: s, time: time, stamped: stamped });
    prev = s.root;
  }
  return { problems: problems, held: held };
}
/** Every event of the logs, with the file and line (from 1) it is on. */
function eventsOf(logs) {
  const out = [];
  for (const file of Object.keys(logs)) {
    logs[file].split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try { const e = JSON.parse(line); if (e && typeof e.t === "string" && typeof e.d === "string") out.push({ e: e, file: file, line: i + 1 }); } catch (err) { /* not an event */ }
    });
  }
  const stamp = (t) => { const m = /^(.+Z)\/(\d+)$/.exec(t); return m ? [Date.parse(m[1]), Number(m[2])] : [0, 0]; };
  out.sort((a, b) => { const x = stamp(a.e.t), y = stamp(b.e.t); return x[0] - y[0] || x[1] - y[1] || (a.e.d < b.e.d ? -1 : a.e.d > b.e.d ? 1 : 0); });
  return out;
}
async function verifyExtract(x) {
  const checks = [];
  for (const chain of x.chains) checks.push(await checkChain(chain, x.logs));
  const problems = [].concat.apply([], checks.map((c) => c.problems));
  const events = eventsOf(x.logs);
  const undone = new Set();
  for (const it of events) if (it.e.op === "undo" || it.e.op === "redo") for (const id of it.e.ev || []) { if (it.e.op === "undo") undone.add(id); else undone.delete(id); }
  const live = events.filter((it) => !undone.has(it.e.d + "@" + it.e.t));
  const sealedBy = (file, line) => {
    let best;
    for (const c of checks) for (const h of c.held) {
      if (((h.seal.files[file] || {}).lines || 0) < line) continue;
      if (!best || (h.stamped && !best.stamped) || (h.stamped === best.stamped && h.time < best.time)) best = { time: h.time, stamped: h.stamped };
    }
    return best;
  };
  const rows = x.rows.map((r) => {
    const add = live.find((it) => it.e.op === "add" && it.e.l === x.list && it.e.row === r.id);
    if (!add) return { id: r.id, problem: "no event in the logs adds this row" };
    const sets = live.filter((it) => it.e.op === "set" && it.e.l === x.list && it.e.row === r.id);
    const now = Object.assign({}, add.e.v);
    for (const s of sets) { if (s.e.v === undefined) delete now[s.e.f]; else now[s.e.f] = s.e.v; }
    const differs = x.fields.map((f) => f.name).concat(["at"]).filter((f) => stable(now[f] === undefined ? null : now[f]) !== stable(r.row[f] === undefined ? null : r.row[f]));
    const written = Date.parse(add.e.t.split("/")[0]);
    const says = Date.parse(String(r.row.at || ""));
    // The newest line the row depends on: a seal must cover that one for the row as shown to be sealed.
    const last = sets.length ? sets[sets.length - 1] : add;
    return {
      id: r.id, written: written, sets: sets.length, lastSet: sets.length ? Date.parse(last.e.t.split("/")[0]) : undefined,
      sealed: sealedBy(last.file, last.line), firstSealed: sealedBy(add.file, add.line),
      late: !Number.isNaN(says) && written - says > x.lateMs,
      problem: differs.length ? "the logs give another " + differs.join(", ") + " for this row" : undefined,
    };
  });
  for (const r of rows) if (r.problem) problems.push("row " + r.id + ": " + r.problem);
  return { ok: problems.length === 0, problems: problems, rows: rows, seals: checks.reduce((n, c) => n + c.held.length, 0), stamped: checks.reduce((n, c) => n + c.held.filter((h) => h.stamped).length, 0) };
}
`;

const PAGE_SCRIPT = String.raw`
const X = JSON.parse(document.getElementById("data").textContent);
const local = (t) => new Date(t).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
verifyExtract(X).then((v) => {
  const verdict = document.getElementById("verdict");
  verdict.className = v.ok ? "ok" : "bad";
  verdict.textContent = v.ok
    ? "This file checks out: " + v.seals + (v.seals === 1 ? " seal holds" : " seals hold") + (v.stamped ? ", " + v.stamped + " with an authority's time stamp" : ", by the device's own clock (no authority)") + ", and each row is what the logs say."
    : "This file does not check out.";
  const list = document.getElementById("problems");
  for (const p of v.problems) { const li = document.createElement("li"); li.textContent = p; list.appendChild(li); }
  const byId = new Map(v.rows.map((r) => [r.id, r]));
  for (const tr of document.querySelectorAll("tbody tr")) {
    const r = byId.get(tr.dataset.id);
    const cell = tr.lastElementChild;
    if (!r || r.problem) { cell.textContent = r ? r.problem : "not checked"; cell.className = "bad"; continue; }
    const parts = ["written " + local(r.written)];
    if (r.sets) parts.push("changed " + (r.sets === 1 ? "once" : r.sets + " times") + ", last " + local(r.lastSet));
    parts.push(r.sealed ? "sealed by " + local(r.sealed.time) + (r.sealed.stamped ? " (authority)" : " (this device's clock)") : "not sealed yet");
    cell.textContent = parts.join(" · ");
    if (r.late) { const b = document.createElement("b"); b.textContent = " · written later than the time it gives"; cell.appendChild(b); tr.className = "late"; }
  }
}).catch((e) => { const verdict = document.getElementById("verdict"); verdict.className = "bad"; verdict.textContent = "This file couldn't be checked here: " + e.message; });
`;

const STYLE = `
body { font: 15px/1.45 -apple-system, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 980px; padding: 0 1rem; color: #1d1d1f; background: #fff; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
.meta, td:last-child, .how { color: #5f6368; font-size: .85rem; }
#verdict { margin: 1rem 0 .25rem; padding: .6rem .8rem; border-radius: 6px; background: #f1f3f4; font-weight: 600; }
#verdict.ok { background: #e6f4ea; color: #0b5d2c; }
#verdict.bad { background: #fce8e6; color: #a50e0e; }
#problems { color: #a50e0e; margin: .25rem 0 1rem; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th, td { text-align: left; padding: .35rem .6rem .35rem 0; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
td.bad { color: #a50e0e; }
tr.late td:last-child b { color: #a50e0e; }
@media (prefers-color-scheme: dark) { body { background: #1e1e1e; color: #e8e8e8; } th, td { border-color: #3a3a3a; } #verdict { background: #2a2a2a; } }
@media print { #verdict { border: 1px solid #999; } }
`;

/** A value as the page's table shows it. */
function shown(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.length === 22 && /^\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d$/.test(v) ? v.slice(0, 16).replace("T", " ") : v;
  return textOf(v);
}

/** The extract as one HTML file. */
export function extractPage(x: Extract): string {
  const data = JSON.stringify(x).replace(/</g, "\\u003c");
  const head = ["When", ...x.fields.map((f) => f.label), "Proof"].map((h) => `<th>${esc(h)}</th>`).join("");
  const body = x.rows.map(({ id, row }) => `<tr data-id="${esc(id)}"><td>${esc(shown(row.at))}</td>${x.fields.map((f) => `<td>${esc(shown(row[f.name]))}</td>`).join("")}<td>checking…</td></tr>`).join("\n");
  const made = new Date(x.made).toISOString().slice(0, 16).replace("T", " ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>${esc(x.kind)}: sealed extract</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${esc(x.kind)}</h1>
<div class="meta">${x.rows.length} ${x.rows.length === 1 ? "row" : "rows"} · made ${made} UTC · this file loads nothing and sends nothing</div>
<div id="verdict">Checking this file…</div>
<ul id="problems"></ul>
<table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table>
<p class="how">How this is checked: the file holds the event logs the rows come from and the seals made over them. Your browser hashes the logs again (SHA-256) and compares them with each seal, follows each chain of seals, and works each row out again from the logs. A seal with an authority's time stamp holds that authority's signed answer (RFC 3161) in the data below; this page reads the time and the hash from it, and <code>openssl ts -verify</code> checks its signature. A seal proves when a line was written and that it hasn't changed since. It can't prove that what the line says is true.</p>
<script id="data" type="application/json">${data}</script>
<script>${VERIFY_SOURCE}${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
