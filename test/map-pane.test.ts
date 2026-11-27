import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { drawDryRun, type MapShortcut } from "../src/dry-run-pane.ts";
import { MapPane, type MapHost } from "../src/map-pane.ts";
import { permissionsOf } from "../src/permissions.ts";
import { drawPolicy } from "../src/policy-pane.ts";
import type { GizmoRuntime } from "../src/runtime.ts";
import { readSpec } from "../src/spec.ts";
import { runtimeOn } from "./support/runtime.ts";

// The automation map, a shortcut's dry run and the policy window as panes any host draws into its
// own tab or window: Obsidian's view and modals and the standalone app's page wrap these same panes.

const CALLS = {
  app: "Calls",
  panels: [{
    view: "form", title: "Log", fields: { who: "text", back: "date" }, save: "calls", shortcut: "log",
    append: "Daily.md", line: "- Called {who}",
    then: { app: "[[Errands]]", do: "add", fill: { errand: "Call {who} back by {back}" } },
  }],
};
const ERRANDS = { app: "Errands", panels: [{ view: "form", title: "Add", fields: { errand: "text" }, save: "errands", shortcut: "add" }] };
const MEDS = {
  app: "Meds",
  panels: [
    { view: "button", label: "Took meds", save: "doses", shortcut: "took" },
    { view: "number", title: "Doses today", source: "doses", where: { at: "today" }, agg: "count", pin: "status" },
    { view: "number", title: "Doses this week", source: "doses", where: { at: "this week" }, agg: "count", pin: "status" },
  ],
};
const POLICY_FM = {
  labels: { "Health/**": "private" },
  sinks: { "api.open-meteo.com": "public" },
  release: [{ app: "Health/Meds", panel: "Doses today", to: ["pin"] }],
};

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
const button = (el: Element, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const card = (el: Element, name: string) => [...el.querySelectorAll(".gz-map-apps > .gz-map-app")].find((c) => text(c.querySelector(".gz-map-app-head > .gz-title")) === name);

async function vault(notes: Record<string, { fm: Record<string, unknown>; body?: string }> = {}, settings = {}) {
  const t = await runtimeOn({
    "Apps/Calls.md": { fm: CALLS, body: "" },
    "Apps/Errands.md": { fm: ERRANDS, body: "" },
    "Apps/Unopened.md": { fm: { app: "Unopened", panels: [{ view: "form", title: "Add", fields: { thing: "text" }, save: "things", shortcut: "add" }] }, body: "" },
    "Daily.md": { fm: {}, body: "# Today\n" },
    ...notes,
  }, { settings });
  for (const path of ["Apps/Calls.md", "Apps/Errands.md", ...Object.keys(notes).filter((p) => p.startsWith("Health/"))]) {
    await t.runtime.grant(path, permissionsOf(readSpec(t.f.files.get(path)!.fm!, { path, notes: t.runtime.host.notes })!.spec!, path));
  }
  await t.runtime.start();
  return t;
}

function hostOn(rt: GizmoRuntime) {
  const said = { notices: [] as string[], opened: [] as string[], activity: [] as string[], dry: [] as [string, string, string][], policy: 0 };
  const host: MapHost = {
    rt,
    notify: (m) => { said.notices.push(m); },
    open: (p) => { said.opened.push(p); },
    activity: (p) => { said.activity.push(p); },
    dryRun: (p, name, s) => { said.dry.push([p, name, s.id]); },
    policy: () => { said.policy++; },
  };
  return { host, said };
}

test("the map lists each app with its state and what makes it act, and the filter narrows it", async () => {
  const t = await vault();
  const { host, said } = hostOn(t.runtime);
  const el = document.createElement("div");
  const pane = new MapPane(el, host);
  await until(() => el.querySelector(".gz-map-summary"));
  assert.equal(text(el.querySelector(".gz-map-summary")), "3 apps: 2 allowed, 1 never opened");
  assert.equal(text(card(el, "Calls")?.querySelector(".gz-map-state")), "Allowed");
  assert.equal(text(card(el, "Unopened")?.querySelector(".gz-map-state")), "Never opened");
  assert.ok(text(card(el, "Calls")).includes("Shortcut “Log” (log): from its command or link"));
  assert.equal(button(card(el, "Unopened")!, "Dry run"), undefined, "an app never opened has no dry run");
  assert.equal(button(card(el, "Calls")!, "Copy link"), undefined, "no Copy link where the host can't copy one");
  assert.equal(button(el, "Save as canvas"), undefined, "nor Save as canvas");

  const filter = el.querySelector(".gz-map-head input") as HTMLInputElement;
  filter.value = "err";
  filter.dispatchEvent(new window.Event("input"));
  assert.deepEqual([...el.querySelectorAll(".gz-map-apps > .gz-map-app .gz-map-app-head > .gz-title")].map((e) => e.textContent), ["Errands"]);

  (card(el, "Errands")!.querySelector("a.gz-title") as HTMLElement).click();
  button(card(el, "Errands")!, "Activity")!.click();
  button(card(el, "Errands")!, "Dry run")!.click();
  assert.deepEqual([said.opened, said.activity, said.dry], [["Apps/Errands.md"], ["Apps/Errands.md"], [["Apps/Errands.md", "Errands", "add"]]]);
  pane.stop();
});

test("Revoke in the map stops an app, and the map draws it again as revoked; New link key makes a new key", async () => {
  const t = await vault();
  // Revoked is told from never opened by what the app did: an app that never acted reads as never opened.
  const ran = await t.runtime.background.runFrom("Apps/Errands.md", "add", { params: { errand: "Buy milk" }, trusted: true });
  assert.ok(ran.ok, JSON.stringify(ran));
  const { host, said } = hostOn(t.runtime);
  const el = document.createElement("div");
  const pane = new MapPane(el, host);
  await until(() => card(el, "Errands"));
  button(card(el, "Errands")!, "Revoke")!.click();
  await until(() => text(card(el, "Errands")?.querySelector(".gz-map-state")) === "Not allowed: you revoked it");
  assert.equal(text(card(el, "Errands")?.querySelector(".gz-map-state")), "Not allowed: you revoked it");
  assert.equal(button(card(el, "Errands")!, "Revoke"), undefined, "nothing left to revoke");
  assert.equal(t.saved().grants["Apps/Errands.md"], undefined, "its grant is gone from data.json");
  assert.ok(said.notices.includes("Errands is stopped; open it to allow it again"));

  const before = t.runtime.linkKey("Apps/Calls.md", "log", true);
  button(card(el, "Calls")!, "New link key")!.click();
  await until(() => said.notices.length === 2);
  assert.equal(said.notices[1], "Links to “Log” copied before now ask before they run");
  assert.notEqual(t.runtime.linkKey("Apps/Calls.md", "log", false), before);
  assert.equal(t.saved().linkKeys?.["Apps/Calls.md#log"], t.runtime.linkKey("Apps/Calls.md", "log", false), "the new key is in data.json");
  pane.stop();
});

test("with a note set, the map starts with the apps that can change it; Show every app drops it", async () => {
  const t = await vault();
  const { host } = hostOn(t.runtime);
  const el = document.createElement("div");
  const pane = new MapPane(el, host, "Daily.md");
  const writers = await until(() => el.querySelector(".gz-map-writers"));
  assert.equal(text(writers?.querySelector(".gz-title")), "Apps that can change Daily");
  assert.ok(text(writers).includes("Calls"), text(writers));
  button(writers!, "Show every app")!.click();
  await until(() => !el.querySelector(".gz-map-writers"));
  assert.equal(el.querySelector(".gz-map-writers"), null);
  assert.equal(pane.note, undefined);
  pane.stop();
});

test("the policy: the map says a policy note isn't applied; its window lists what stops and what fits, and Apply applies it", async () => {
  const t = await vault({ "Health/Meds.md": { fm: MEDS, body: "" }, "Gizmo policy.md": { fm: POLICY_FM, body: "" } });
  const { host, said } = hostOn(t.runtime);
  const el = document.createElement("div");
  const pane = new MapPane(el, host);
  const banner = await until(() => el.querySelector(".gz-map-policy.is-pending"));
  assert.equal(text(banner?.querySelector("span")), "Gizmo policy.md isn't applied yet; until it is, apps ask for everything as before.");
  button(banner!, "Review and apply")!.click();
  assert.equal(said.policy, 1);

  const win = document.createElement("div");
  let closed = 0;
  drawPolicy(win, t.runtime, { notify: (m) => { said.notices.push(m); }, close: () => { closed++; } });
  assert.ok(win.classList.contains("gz-policy"));
  assert.deepEqual([...win.querySelectorAll("h4")].map((h) => h.textContent), ["Stops: 1 app would send data where it may not go", "Fits: 3 apps"]);
  assert.equal(text(win.querySelector(".gz-card.gz-error .gz-title")), "Meds");
  button(win, "Apply")!.click();
  await until(() => closed);
  assert.equal(closed, 1);
  assert.ok(t.saved().policy, "the policy is in data.json");
  assert.ok(said.notices.includes("Your data policy is applied"));
  await until(() => text(card(el, "Meds")?.querySelector(".gz-map-state")) === "Blocked by your policy");
  assert.equal(text(card(el, "Meds")?.querySelector(".gz-map-state")), "Blocked by your policy");
  assert.match(text(el.querySelector(".gz-map-policy")), /Your data policy is applied: 1 app is blocked by it\./);

  // Applied, its window says so and offers nothing to apply.
  const again = document.createElement("div");
  drawPolicy(again, t.runtime, { notify: () => {}, close: () => {} });
  assert.equal(text(again.querySelector(".gz-muted")), "This policy is applied. What it says of each app:");
  assert.equal(button(again, "Apply"), undefined);
  assert.ok(button(again, "Close"));
  pane.stop();
});

test("the policy window with no policy note says what one is, and with the note gone offers to stop using it", async () => {
  const t = await vault();
  const win = document.createElement("div");
  drawPolicy(win, t.runtime, { notify: () => {}, close: () => {} });
  assert.match(text(win), /There's no Gizmo policy.md at the root of this vault\./);
  assert.deepEqual([...win.querySelectorAll("button")].map((b) => b.textContent), ["Close"]);

  const rules = { hash: "x", rules: { labels: {}, sinks: {}, release: [] } } as unknown as NonNullable<typeof t.runtime.store.policy>;
  await t.runtime.applyPolicy(rules);
  const gone = document.createElement("div");
  let notified = "";
  drawPolicy(gone, t.runtime, { notify: (m) => { notified = m; }, close: () => {} });
  button(gone, "Stop using a policy")!.click();
  await until(() => notified);
  assert.equal(notified, "No data policy is used now");
  assert.equal(t.saved().policy, undefined);
});

test("a dry run: the form's fields, what it would change through its then, worked out again as you type, with nothing written", async () => {
  const t = await vault();
  const snapshot = () => JSON.stringify([...t.f.files].map(([p, n]) => [p, n.fm, n.body]));
  const before = snapshot();
  const el = document.createElement("div");
  const shortcut = { id: "log", label: "Log", fields: ["who", "back"] } as unknown as MapShortcut;
  const stop = drawDryRun(el, t.runtime, "Apps/Calls.md", shortcut);
  assert.deepEqual([...el.querySelectorAll(".gz-dry-fields .gz-input-name")].map((e) => e.textContent), ["who", "back"]);
  await until(() => el.querySelectorAll(".gz-effects li").length);
  const who = el.querySelector(".gz-dry-fields input") as HTMLInputElement;
  who.value = "Sam";
  who.dispatchEvent(new window.Event("input"));
  const lines = await until(() => {
    const l = [...el.querySelectorAll(".gz-effects li")].map((li) => li.textContent);
    return l.includes("Add the line “- Called Sam” to Daily") && l;
  });
  assert.ok(lines, [...el.querySelectorAll(".gz-effects li")].map((li) => li.textContent).join(" | "));
  assert.ok(lines.some((l) => l?.startsWith("Errands: Save errand Call Sam back by")), lines.join(" | "));
  assert.equal(snapshot(), before, "nothing was written");
  stop();
});

test("a shared kind's writers: Remove stops what comes from one, Accept again lets it in; a capture link's key can be revoked", async () => {
  const chore = { kind: "chore", fields: { task: "text" }, share: { relay: "https://ntfy.sh", key: { secret: "chore-key" } } };
  const t = await vault({ "Kinds/Chore.md": { fm: chore, body: "" } }, {
    writers: { "Kinds/Chore.md\ncccccccccccccccc": { name: "Cy", state: "accepted", at: 1 } },
    captureKeys: { abcd1234abcd1234: { add: "Apps/Errands.md:add" } },
  });
  const { host, said } = hostOn(t.runtime);
  const el = document.createElement("div");
  const pane = new MapPane(el, host);
  const shared = await until(() => el.querySelector(".gz-map-shared"));
  assert.ok(text(shared).includes("Shared through ntfy.sh"), text(shared));
  assert.equal(text(shared?.querySelector(".gz-map-writer-list li span")), "Cy: accepted");
  button(shared!, "Remove")!.click();
  const removed = await until(() => (el.querySelector(".gz-map-shared .gz-map-writer-list li span")?.textContent?.includes("removed") ? el.querySelector(".gz-map-shared") : null));
  assert.equal(text(removed?.querySelector(".gz-map-writer-list li span")), "Cy: removed; nothing more comes in from them");
  assert.equal(t.runtime.store.writers?.["Kinds/Chore.md\ncccccccccccccccc"]?.state, "removed");
  button(removed!, "Accept again")!.click();
  await until(() => t.runtime.store.writers?.["Kinds/Chore.md\ncccccccccccccccc"]?.state === "accepted");
  assert.equal(said.notices.at(-1), "Chore: rows from Cy come in again, from what they send next");

  const heads = [...el.querySelectorAll("h4")].map((h) => h.textContent);
  assert.ok(heads.includes("Capture links"), heads.join(" | "));
  const key = [...el.querySelectorAll(".gz-map-app")].find((c) => text(c.querySelector(".gz-title")) === "Key abcd…")!;
  assert.equal(text(key.querySelector(".gz-muted")), "Runs without asking: add");
  button(key, "Revoke")!.click();
  await until(() => !t.saved().captureKeys?.abcd1234abcd1234);
  assert.equal(t.saved().captureKeys?.abcd1234abcd1234, undefined);
  assert.ok(said.notices.includes("That capture link's lines now ask before they run"));
  pane.stop();
});
