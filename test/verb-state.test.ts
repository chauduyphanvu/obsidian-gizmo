import { document } from "./support/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppController } from "../src/app.ts";
import { coveredBy, rhythmState } from "../src/asks.ts";
import { readSpec } from "../src/spec.ts";
import type { Rhythm } from "../src/expect.ts";
import { fakeEnv } from "./support/fakes.ts";

// A verb button that logs what a rhythm counts says where the rhythm stands now (done, due, late),
// and only the next one due stays the button to press. Noon, Nov 18 by the fake clock.

const APP = "Apps/Meds.md";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10)); };
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

const MEDS = {
  app: "Meds",
  panels: [
    { view: "button", label: "Morning dose", save: "doses", row: { dose: "am" } },
    { view: "button", label: "Evening dose", save: "doses", row: { dose: "pm" } },
    { view: "button", label: "A note", save: "memos" },
  ],
  expect: [
    { id: "am", every: "day", by: "10:00", source: "doses", where: { dose: "am" } },
    { id: "pm", every: "day", by: "21:00", source: "doses", where: { dose: "pm" } },
  ],
};

const started: { dispose(): void }[] = [];
afterEach(() => { for (const s of started.splice(0)) s.dispose(); });

function open(fm: Record<string, unknown>, hosting = false) {
  const t = fakeEnv({ [APP]: { fm }, "Daily.md": { fm: {} } });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const c = hosting
    ? new AppController(root, APP, t.env, { kind: "app", grantKey: "Daily.md#gizmo", hostPath: "Daily.md", definition: () => fm })
    : new AppController(root, APP, t.env);
  started.push(c);
  c.load();
  const verbs = () => [...root.querySelectorAll("button.gz-verb")].map((b) => ({
    label: text(b),
    state: text(b.parentElement!.querySelector(".gz-verb-state")),
    cta: b.classList.contains("mod-cta"),
  }));
  return { ...t, root, verbs, button: (label: string) => [...root.querySelectorAll("button.gz-verb")].find((b) => text(b) === label)! };
}

test("each verb button says where its rhythm stands; the first one due or late is the one to press", async () => {
  const t = open(MEDS);
  await settle();
  assert.deepEqual(t.verbs(), [
    { label: "Morning dose", state: "Late: due by 10:00", cta: true },
    { label: "Evening dose", state: "Due by 21:00", cta: false },
    { label: "A note", state: "", cta: false },
  ]);
  click(t.button("Morning dose"));
  await settle();
  assert.deepEqual(t.verbs(), [
    { label: "Morning dose", state: "Done today", cta: false },
    { label: "Evening dose", state: "Due by 21:00", cta: true },
    { label: "A note", state: "", cta: false },
  ]);
  assert.ok(t.button("Morning dose").classList.contains("is-done"));
  const described = t.button("Morning dose").getAttribute("aria-describedby")!;
  assert.equal(text(t.root.querySelector(`#${described}`)), "Done today", "the state describes the button, whose name stays its label");
});

test("an app keeping no rhythm, or a block of one, leaves its buttons as they were", async () => {
  const plain = open({ app: "x", panels: [{ view: "button", label: "Log", save: "done" }] });
  await settle();
  assert.deepEqual(plain.verbs(), [{ label: "Log", state: "", cta: true }]);
  const block = open(MEDS, true);
  await settle();
  assert.ok(block.verbs().every((v) => v.state === ""));
});

test("coveredBy: a button counts for a rhythm when it saves to its list and can meet its where; rhythmState reads the open window", () => {
  const spec = readSpec(MEDS, { path: APP, now: new Date(2026, 10, 18, 12, 0) })!.spec!;
  const [am, pm] = spec.expect as Rhythm[];
  const counted = spec.expected.am.panel;
  const [morning, evening, note] = spec.panels.map((ps) => ps.panel);
  const now = new Date(2026, 10, 18, 12, 0);
  assert.deepEqual([morning, evening, note].map((p) => coveredBy(am, counted, p, APP, now)), [true, false, false]);
  assert.equal(coveredBy(pm, spec.expected.pm.panel, evening, APP, now), true);
  assert.equal(rhythmState(am, [], now).state, "late");
  assert.equal(rhythmState(pm, [], now).state, "due");
  // Logged after its deadline, the day still counts it done.
  assert.equal(rhythmState(am, [{ dose: "am", at: "2026-11-18T11:30" }], now).state, "done");
  assert.equal(rhythmState(am, [{ dose: "am", at: "2026-11-17T09:00" }], now).state, "late", "yesterday's doesn't count today");
});
