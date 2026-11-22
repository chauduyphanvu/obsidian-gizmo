/**
 * A guest page: one HTML file with a shared kind's form, which anyone holding its code can use to
 * add rows, from a file or any static host, on a phone, with nothing loaded from anywhere. The file
 * itself holds no secret: the code (the page's own sealing key and signing key) comes after `#` in
 * its address, which a browser never sends to a server, or is pasted in. The file holds a check of
 * its code (a hash, which gives back nothing of the keys), so it tells its own code from one cut
 * short, changed or another page's. With it the page can only add rows: its key opens nothing the
 * members seal, and it can talk to nothing but the relay.
 */
import { b64url, fromB64url, GUEST_SEAL_SOURCE, type SigningKey } from "./share-crypto.ts";

/** What a guest page shows and where its rows go. */
export interface GuestPage {
  /** The kind as the page calls it, e.g. Chore. */
  kind: string;
  fields: Record<string, string | string[]>;
  labels?: Record<string, string>;
  relay: string;
  topic: string;
  /** The page's writer (its signing key's fingerprint), which its rows are sealed under. */
  writer: string;
  /** Who the page is for, and who receives its rows. */
  guest: string;
  members: string[];
  /** The check of the page's own code (see guestCheck). */
  check: string;
}

const CODE = "gzg1";

/** What the page checks a code against: 16 hex characters of the SHA-256 of its keys' bytes, after a label. */
export async function guestCheck(key: Uint8Array, sign: SigningKey): Promise<string> {
  const parts = [new TextEncoder().encode(CHECK_LABEL), key, ...[sign.d, sign.x, sign.y].map((t) => fromB64url(t) ?? new Uint8Array())];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CHECK_LABEL = "gizmo guest page\n";

/** The code that opens a guest page: its sealing key and its signing key. */
export function guestCode(key: Uint8Array, sign: SigningKey): string {
  return [CODE, b64url(key), sign.d, sign.x, sign.y].join(".");
}

export function readGuestCode(text: string): { key: Uint8Array; sign: SigningKey } | undefined {
  const parts = text.trim().replace(/^#/, "").split(".");
  if (parts.length !== 5 || parts[0] !== CODE) return undefined;
  const key = fromB64url(parts[1]);
  if (key?.length !== 32 || [2, 3, 4].some((i) => fromB64url(parts[i])?.length !== 32)) return undefined;
  return { key, sign: { d: parts[2], x: parts[3], y: parts[4] } };
}

/** Names joined as a sentence says them: "Ann", "Ann and Bo", "Ann, Bo and Cy". */
export function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "the people who share it";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page's HTML: its words, its form, and the script that seals and sends a row. */
export function guestPageHtml(p: GuestPage): string {
  const origin = new URL(p.relay).origin;
  const who = names(p.members);
  const host = new URL(p.relay).host;
  const config = JSON.stringify({ kind: p.kind, fields: p.fields, labels: p.labels ?? {}, relay: p.relay, topic: p.topic, writer: p.writer, guest: p.guest, who, check: p.check }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${origin}; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<title>Add to ${escape(p.kind)}</title>
<style>
:root { --bg: #fafaf8; --fg: #1d1d1f; --muted: #6b6b70; --line: #d9d9dc; --card: #fff; --accent: #2f6fde; --on-accent: #fff; --ok: #1f7a3d; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececee; --muted: #a0a0a8; --line: #3a3a3f; --card: #1f1f22; --accent: #7aa7ff; --on-accent: #0b1a33; --ok: #6fd08f; --bad: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 20px 16px 40px; }
h1 { font-size: 1.5rem; margin: 0 0 6px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: 0.95rem; }
form, .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 16px 0; }
label { display: block; font-weight: 600; margin: 12px 0 4px; }
label:first-child { margin-top: 0; }
input, select, textarea { width: 100%; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-height: 44px; }
input[type=checkbox] { width: auto; min-height: 0; transform: scale(1.3); margin-right: 8px; }
.check { display: flex; align-items: center; font-weight: 600; margin: 12px 0 4px; }
button { font: inherit; font-weight: 600; width: 100%; min-height: 48px; margin-top: 18px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
#said { min-height: 1.5em; margin-top: 12px; }
#said.ok { color: var(--ok); } #said.bad, #why { color: var(--bad); }
ul { padding-left: 1.2em; margin: 8px 0 0; }
li { margin: 2px 0; }
textarea { min-height: 6em; }
</style>
</head>
<body>
<main>
<h1>Add to ${escape(p.kind)}</h1>
<p>This page is for ${escape(p.guest)}. It adds a row to ${escape(p.kind)}, a list that ${escape(who)} keep${p.members.length === 1 ? "s" : ""} in Gizmo.</p>
<p class="muted">Each row you add goes to ${escape(who)}, sealed, through ${escape(host)}, which sees only scrambled text. You can add rows here; you can't see theirs, and this page keeps nothing but what you add on this device.</p>
<div id="needs" class="card" hidden>
<label for="code">Your code</label>
<input id="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="gzg1.…">
<p id="why" role="alert" hidden></p>
<p class="muted">${escape(who)} gave you a code with this page. Paste it here, or open the page with the code after # in its address.</p>
<button id="use" type="button">Use this code</button>
</div>
<form id="form" hidden></form>
<div id="sent" class="card" hidden><strong>Added from this page</strong><ul id="list"></ul></div>
</main>
<script>
const CONFIG = ${config};
${GUEST_SEAL_SOURCE}
(() => {
  const $ = (id) => document.getElementById(id);
  const store = (() => { try { return window.localStorage; } catch { return undefined; } })();
  const slot = "gizmo-guest-" + CONFIG.writer;
  const raw = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const readCode = (text) => {
    const parts = String(text || "").trim().replace(/^#/, "").split(".");
    if (parts.length !== 5 || parts[0] !== "gzg1" || parts.some((t, i) => i > 0 && !/^[A-Za-z0-9_-]+$/.test(t))) return undefined;
    try {
      const key = raw(parts[1]);
      return key.length === 32 && [2, 3, 4].every((i) => raw(parts[i]).length === 32) ? { key, sign: { d: parts[2], x: parts[3], y: parts[4] } } : undefined;
    } catch { return undefined; }
  };
  // This page's own code, by the check it holds; a code cut short, changed or another page's isn't.
  const own = async (text) => {
    const found = readCode(text);
    if (!found) return undefined;
    const label = new TextEncoder().encode(${JSON.stringify(CHECK_LABEL)});
    const parts = [label, found.key, raw(found.sign.d), raw(found.sign.x), raw(found.sign.y)];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("") === CONFIG.check ? found : undefined;
  };
  const NOT_OURS = "This code isn't for this page. It may be cut short or changed, or be the code of another page; ask " + CONFIG.who + " for this page's code.";
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = (d) => {
    const off = -d.getTimezoneOffset(), a = Math.abs(off);
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" + p2(d.getHours()) + ":" + p2(d.getMinutes()) + (off >= 0 ? "+" : "-") + p2(Math.floor(a / 60)) + ":" + p2(a % 60);
  };
  const local = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" + p2(d.getHours()) + ":" + p2(d.getMinutes());
  const label = (f) => CONFIG.labels[f] || f.charAt(0).toUpperCase() + f.slice(1);
  // Inputs are kept by field, not read back by name from the form, whose own properties (length,
  // item, …) a field's name would meet; the row's time is When's, so a field called at isn't drawn.
  const fields = Object.entries(CONFIG.fields).filter(([field]) => field !== "at");
  const inputs = new Map();
  let when;
  let code;

  const say = (text, cls) => { const el = $("said"); el.textContent = text; el.className = cls || ""; };
  const draw = () => {
    const form = $("form");
    form.textContent = "";
    inputs.clear();
    for (const [field, type] of fields) {
      if (type === "checkbox") {
        const row = document.createElement("label");
        row.className = "check";
        const box = document.createElement("input");
        box.type = "checkbox";
        row.append(box, document.createTextNode(label(field)));
        form.append(row);
        inputs.set(field, box);
        continue;
      }
      const l = document.createElement("label");
      l.textContent = label(field); l.htmlFor = "f-" + field;
      let input;
      if (Array.isArray(type)) {
        input = document.createElement("select");
        input.append(new Option("", ""));
        for (const choice of type) input.append(new Option(String(choice), String(choice)));
      } else if (type === "textarea") {
        input = document.createElement("textarea");
      } else {
        input = document.createElement("input");
        input.type = type === "number" ? "number" : type === "date" ? "date" : type === "time" ? "time" : "text";
        if (type === "number") { input.step = "any"; input.inputMode = "decimal"; }
      }
      input.id = "f-" + field;
      form.append(l, input);
      inputs.set(field, input);
    }
    const whenLabel = document.createElement("label");
    whenLabel.textContent = "When"; whenLabel.htmlFor = "f-at";
    when = document.createElement("input");
    when.type = "datetime-local"; when.id = "f-at"; when.value = local(new Date());
    const send = document.createElement("button");
    send.type = "submit"; send.id = "add"; send.textContent = "Add to " + CONFIG.kind;
    const said = document.createElement("div");
    said.id = "said"; said.setAttribute("role", "status");
    form.append(whenLabel, when, send, said);
  };

  const start = (found) => {
    code = found;
    $("needs").hidden = true;
    $("form").hidden = false;
    draw();
  };
  const ask = (why) => {
    $("needs").hidden = false;
    $("form").hidden = true;
    $("why").textContent = why || "";
    $("why").hidden = !why;
  };

  if (!window.crypto || !crypto.subtle) {
    document.querySelector("main").insertAdjacentHTML("beforeend", "<div class='card'><strong>This page can't seal a row here.</strong> Open it from a file, or from an https address.</div>");
    return;
  }
  const keep = (text) => { if (store) try { store.setItem(slot, text); } catch {} };
  (async () => {
    // A code in the address is the one to use, or to say isn't this page's; else the one kept here.
    const hash = String(location.hash || "").replace(/^#/, "");
    if (hash) {
      const found = await own(hash);
      if (!found) return ask(NOT_OURS);
      keep(hash);
      return start(found);
    }
    const kept = store ? store.getItem(slot) : null;
    const found = kept ? await own(kept) : undefined;
    if (found) return start(found);
    if (kept) try { store.removeItem(slot); } catch {}
    ask();
  })();
  $("use").addEventListener("click", async () => {
    const text = $("code").value.trim();
    const found = await own(text);
    if (!found) return ask(NOT_OURS);
    keep(text);
    start(found);
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const row = {};
    for (const [field, type] of fields) {
      const el = inputs.get(field);
      if (type === "checkbox") { if (el.checked) row[field] = true; continue; }
      const v = el.value.trim();
      if (v === "") continue;
      row[field] = type === "number" ? Number(v) : v;
    }
    if (!Object.keys(row).length) return say("Fill in at least one thing first", "bad");
    const at = when.value ? new Date(when.value) : new Date();
    row.at = stamp(at);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    $("add").disabled = true;
    say("Sending…");
    try {
      const text = await gzSeal(CONFIG.topic, CONFIG.writer, code.key, code.sign, CONFIG.guest, { t: "add", id, r: row });
      if (new TextEncoder().encode(text).length > 4096) throw new Error("that row is too long to send; make it shorter");
      const res = await fetch(CONFIG.relay.replace(/\\/+$/, "") + "/" + CONFIG.topic, { method: "POST", body: text, cache: "no-store" });
      if (!res.ok) throw new Error(new URL(CONFIG.relay).host + " answered " + res.status);
      const words = Object.entries(row).filter(([k]) => k !== "at").map(([, v]) => v === true ? "yes" : String(v)).join(", ");
      const li = document.createElement("li");
      li.textContent = words + " (" + at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) + ")";
      $("list").prepend(li);
      $("sent").hidden = false;
      for (const el of inputs.values()) { if (el.type === "checkbox") el.checked = false; else el.value = ""; }
      when.value = local(new Date());
      say("Added. " + CONFIG.who + " will see it the next time Gizmo reads " + new URL(CONFIG.relay).host + ".", "ok");
    } catch (err) {
      say("Not sent: " + (err && err.message ? err.message : "no answer") + ". Nothing was added; try again.", "bad");
    } finally {
      $("add").disabled = false;
    }
  });
})();
</script>
</body>
</html>
`;
}
