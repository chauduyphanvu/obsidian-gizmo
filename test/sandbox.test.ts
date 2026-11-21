import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYaml } from "./support/yaml.ts";
import { AppController } from "../src/app.ts";
import { makeSandbox, plainHosts, type SandboxNote } from "../src/sandbox.ts";
import { said } from "./support/addline.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 15)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const APP = {
  app: "Meds",
  panels: [
    { view: "button", label: "Took meds", save: "doses", notify: "Logged", then: { app: "[[Inbox]]", do: "add" } },
    { view: "number", title: "Doses", source: "doses", agg: "count" },
    { view: "number", title: "Outside", source: "https://api.example.com/now", field: "t" },
    { view: "number", title: "Keyed", source: "https://api.example.com/key?k={secret:demo}", field: "t" },
    { view: "list", title: "Projects", source: "notes", from: "Projects", item: "{name}" },
    { view: "table", title: "Covers", source: "covers", columns: [{ field: "cover", cell: "image" }] },
  ],
  covers: [{ cover: "https://images.example.com/a.png" }],
};

function tryApp(fm: Record<string, unknown> = APP) {
  const notes = new Map<string, SandboxNote>([["Apps/Meds.md", { frontmatter: structuredClone(fm), text: "---\napp: Meds\n---\n" }]]);
  const before = JSON.stringify([...notes]);
  const requests: string[] = [];
  const box = makeSandbox({
    appPath: "Apps/Meds.md",
    notes,
    parseYaml,
    now: () => new Date(2026, 10, 18, 12, 0),
    fetch: async (url) => {
      requests.push(url);
      return { status: 200, text: JSON.stringify({ t: 21 }), contentType: "application/json" };
    },
    copy: () => {},
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = new AppController(root, "Apps/Meds.md", box.env);
  app.load();
  const panel = (title: string) => [...root.querySelectorAll(".gz-panel")].find((p) => text(p.querySelector(".gz-panel-title, .gz-title, h3")).includes(title) || text(p).startsWith(title));
  return { box, root, app, requests, panel, unchanged: () => JSON.stringify([...notes]) === before };
}

test("a try draws the real app, lets it be used on copies, and lists what it did; the notes it was given never change", async () => {
  const t = tryApp();
  await settle();
  assert.equal(t.root.querySelector(".gz-card .gz-title")?.textContent?.includes("needs your OK") ?? false, false, "nothing to allow inside a try");
  const button = t.root.querySelector("button.gz-button") as HTMLButtonElement;
  button.click();
  await settle();
  assert.match(text(t.panel("Doses")), /1/);
  // The button's notify is said beside it, in place of a notice.
  assert.equal(said(button.closest(".gz-panel")!), "Logged");
  assert.deepEqual(t.box.events.map((e) => [e.kind, e.text]), [
    ["change", "Saved a row to doses in Meds data"],
    ["then", "It would run “add” in Inbox"],
  ]);
  assert.deepEqual(t.box.overlay.touched, ["Apps/Meds data.md"]);
  assert.ok(t.unchanged(), "the notes handed in are only ever copied");
  t.app.dispose();
});

test("a try fetches nothing until a host is allowed for it, never with a secret or a body, and loads no pictures", async () => {
  const t = tryApp();
  await settle();
  assert.deepEqual(t.requests, []);
  assert.match(text(t.panel("Outside")), /Not fetched in a try: api\.example\.com/);
  assert.match(text(t.panel("Keyed")), /A try never uses your saved secrets/);
  assert.equal(t.root.querySelector("img"), null, "a picture's address is shown, not loaded");
  assert.match(text(t.panel("Covers")), /images\.example\.com\/a\.png/);
  t.box.allow(["api.example.com"]);
  t.app.reload();
  await settle();
  assert.deepEqual(t.requests, ["https://api.example.com/now"], "only the plain request goes out");
  assert.match(text(t.panel("Outside")), /21/);
  await assert.rejects(t.box.data.host.fetch("https://api.example.com/x", {}, { method: "POST", body: "{}" }), /never sends anything/);
  t.app.dispose();
});

test("a try sees none of the vault's notes", async () => {
  const t = tryApp();
  await settle();
  assert.deepEqual(t.box.data.notes("Projects"), []);
  assert.deepEqual(t.box.data.allNotes().map((r) => r.path), ["Apps/Meds.md"]);
  t.app.dispose();
});

test("the hosts a try may fetch from: what the app fetches, less where it sends someone's data or a body", () => {
  assert.deepEqual(plainHosts(["net:a.example", "net:b.example", "send:b.example|typed.q", "net:c.example", "post:c.example", "read:Books"]), ["a.example"]);
});
