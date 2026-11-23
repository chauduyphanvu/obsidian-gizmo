// Gallery apps on large data, timed headless: the background starting, the app opening, and one
// entry saved, each until every panel has painted. Fake vault and linkedom, as the tests use, so
// Obsidian's own YAML write and Chromium's layout aren't in it.
//
//   node test/perf/big-data.ts [--size typical|large] [--iters N] [--apps a,b] [--out runs.jsonl] [--dry]
//   node test/perf/big-data.ts --size large --golden <dir>   writes what each app showed and wrote
//   --steady   times the vault as it is after one save: the data note snapshotted, its log beside it
//
// --dry builds the same vaults without opening anything: the harness's own cost.
import { document } from "../support/dom.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AppController } from "../../src/app.ts";
import { fakeBackground, later } from "../support/fakes.ts";
import { ledgerStore } from "../../src/datastore.ts";
import { parseYaml } from "../support/yaml.ts";

const { values: args } = parseArgs({
  options: {
    size: { type: "string", default: "large" },
    iters: { type: "string", default: "5" },
    apps: { type: "string" },
    out: { type: "string" },
    golden: { type: "string" },
    dry: { type: "boolean", default: false },
    steady: { type: "boolean", default: false },
  },
});

type Notes = Parameters<typeof fakeBackground>[0];
type Row = Record<string, unknown>;

const SIZES = {
  typical: { rows: 2_000, vault: 2_000, projects: 100, taskNotes: 50, tasksPer: 10 },
  large: { rows: 10_000, vault: 20_000, projects: 2_000, taskNotes: 500, tasksPer: 20 },
};
const size = SIZES[args.size as keyof typeof SIZES];
if (!size) throw new Error(`--size is typical or large, not ${args.size}`);

// The fake background's clock: Wednesday 18 November 2026, 12:00, local time.
const NOW = new Date(2026, 10, 18, 12, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const GALLERY = new URL("../../gallery/", import.meta.url);
const galleryFm = (path: string) => {
  const m = readFileSync(new URL(path, GALLERY), "utf8").match(/^---\n([\s\S]*?)\n---\n?/);
  return (m ? parseYaml(m[1]) : {}) as Row;
};

/** mulberry32: the same vault every run. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n: number) => String(n).padStart(2, "0");
const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const stamp = (t: number) => { const d = new Date(t); return `${day(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** Rows `every` ms apart, the newest a little before now, oldest first as saving leaves them. */
function rows(n: number, every: number, seed: number, make: (r: () => number, i: number) => Row): Row[] {
  const r = random(seed);
  return Array.from({ length: n }, (_, i) => ({ ...make(r, i), at: stamp(NOW - HOUR - (n - 1 - i) * every - Math.floor(r() * every / 2)) }));
}

/** Notes outside the app's scope, so a vault-wide index is as big as a real vault's. */
function filler(count: number, seed: number): Notes {
  const r = random(seed);
  const folders = ["Daily", "Journal", "Reading", "Work", "Archive", "People", "Recipes"];
  const notes: Notes = {};
  for (let i = 0; i < count; i++) {
    const folder = folders[Math.floor(r() * folders.length)];
    notes[`${folder}/Note ${i}.md`] = {
      fm: r() < 0.6 ? { created: day(NOW - Math.floor(r() * 900) * DAY), rating: Math.floor(r() * 5) } : undefined,
      tags: r() < 0.3 ? [`#${folder.toLowerCase()}`] : [],
      body: `# Note ${i}\n\nSome text.\n`,
    };
  }
  return notes;
}

const CATEGORIES = ["food", "home", "transport", "fun", "other"];
const STATUSES = ["idea", "doing", "done"];
const AREAS = ["home", "work", "learning", "money", "travel", "health"];

interface Workload {
  app: string;
  notes(): Notes;
  /** One entry, as a person would add it. */
  save(root: Element): void;
}

const fill = (root: Element, values: string[]) => {
  const inputs = [...root.querySelectorAll(".gz-panel form input")] as HTMLInputElement[];
  values.forEach((v, i) => { inputs[i].value = v; });
};
const submit = (root: Element) => root.querySelector(".gz-panel form")!.dispatchEvent(new window.Event("submit"));

const WORKLOADS: Record<string, Workload> = {
  weight: {
    app: "Apps/Weight.md",
    notes: () => ({
      "Apps/Weight.md": { fm: galleryFm("Apps/Weight.md") },
      "Components/Tracker kit.md": { fm: galleryFm("Components/Tracker kit.md") },
      "Apps/Weight data.md": { fm: { weight: rows(size.rows, 2 * HOUR, 1, (r, i) => ({ value: Math.round((78 + 4 * Math.sin(i / 300) + r()) * 10) / 10, note: r() < 0.1 ? "after a run" : "" })) } },
    }),
    save(root) {
      fill(root, ["79.4", "bench"]);
      submit(root);
    },
  },
  meds: {
    app: "Apps/Medication log.md",
    notes: () => ({
      "Apps/Medication log.md": { fm: galleryFm("Apps/Medication log.md") },
      "Apps/Medication log data.md": { fm: { doses: rows(size.rows, 8 * HOUR, 2, () => ({})) } },
    }),
    save(root) {
      (root.querySelector("button.gz-button") as HTMLElement).dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    },
  },
  budget: {
    app: "Apps/Budget.md",
    notes: () => ({
      "Apps/Budget.md": { fm: galleryFm("Apps/Budget.md") },
      "Apps/Budget data.md": { fm: { spend: rows(size.rows, 4 * HOUR, 3, (r) => ({ amount: Math.round(r() * 8000) / 100, category: CATEGORIES[Math.floor(r() * 5)], note: r() < 0.2 ? "groceries" : "" })) } },
    }),
    save(root) {
      fill(root, ["12.50", "bench"]);
      const select = root.querySelector(".gz-panel form select")!;
      for (const o of select.querySelectorAll("option")) o.toggleAttribute("selected", o.textContent === "food");
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      submit(root);
    },
  },
  board: {
    app: "Apps/Project board.md",
    notes: () => {
      const r = random(4);
      const notes: Notes = { "Apps/Project board.md": { fm: galleryFm("Apps/Project board.md") }, ...filler(size.vault - size.projects, 5) };
      for (let i = 0; i < size.projects; i++) {
        const start = NOW - Math.floor(r() * 400) * DAY;
        notes[`Projects/Project ${i}.md`] = {
          fm: { status: STATUSES[Math.floor(r() * 3)], area: AREAS[Math.floor(r() * AREAS.length)], start: day(start), due: day(start + Math.floor(30 + r() * 300) * DAY) },
          body: "",
        };
      }
      return notes;
    },
    save(root) {
      fill(root, ["Bench project", "work", "2026-12-01", "2027-03-01"]);
      submit(root);
    },
  },
  tasks: {
    app: "Apps/Task inbox.md",
    notes: () => {
      const r = random(6);
      const notes: Notes = { "Apps/Task inbox.md": { fm: galleryFm("Apps/Task inbox.md") }, ...filler(size.vault - size.taskNotes, 7) };
      for (let i = 0; i < size.taskNotes; i++) {
        const lines = [`# List ${i}`, ""];
        for (let j = 0; j < size.tasksPer; j++) {
          const done = r() < 0.4 ? "x" : " ";
          const due = r() < 0.6 ? ` 📅 ${day(NOW + Math.floor(r() * 60 - 20) * DAY)}` : "";
          lines.push(`- [${done}] Task ${i}.${j}${due}`);
        }
        notes[`Tasks/List ${i}.md`] = { fm: {}, body: `${lines.join("\n")}\n` };
      }
      return notes;
    },
    save(root) {
      fill(root, ["Bench task"]);
      submit(root);
    },
  },
};

/** Lets every promise the app started run out; nothing in these workloads waits on a timer. */
async function settle(t: ReturnType<typeof fakeBackground>) {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setImmediate(r));
    t.f.flush();
  }
}

async function run(name: string, w: Workload, notes: Notes) {
  const t = fakeBackground(notes);
  // As in Obsidian, a save appends to the ledger and the data note's snapshot comes a few seconds
  // later, off the save's path: timed below as a step of its own.
  if (t.data.ledger) {
    const ledger = t.data.ledger;
    t.env.store = (dataPath, appPath) => ledgerStore(ledger, dataPath, () => t.f.files.get(appPath)?.fm ?? {});
    t.data.setSnapshots({ isRunner: () => true, delayMs: 3_600_000, gapMs: 0, later, writeNote: (path, fn) => t.env.writeFrontmatter(path, fn) });
  }
  const root = document.createElement("div");
  document.body.appendChild(root);
  t.env.opened = (path) => t.bg.opened(path);
  t.env.alerts = t.bg.alerts;
  let c: AppController | undefined;
  const ms: Record<string, number> = {};
  const time = async (step: string, act: () => void | Promise<unknown>) => {
    const at = performance.now();
    await act();
    await settle(t);
    ms[step] = performance.now() - at;
  };
  await time("start", () => t.bg.start());
  await time("open", () => {
    c = new AppController(root, w.app, t.env);
    c.load();
  });
  const opened = root.innerHTML;
  await time("save", () => w.save(root));
  if (t.data.ledger) await time("snapshot", () => t.data.flushSnapshots());
  const shown = { opened, saved: root.innerHTML, status: t.out.status, notices: t.notices, writes: t.writes };
  c!.dispose();
  t.bg.stop();
  root.remove();
  return { ms, shown, t };
}

const names = args.apps ? args.apps.split(",") : Object.keys(WORKLOADS);
const vaults = new Map(names.map((n) => [n, WORKLOADS[n].notes()]));
if (args.steady) {
  for (const n of names) {
    const { t } = await run(n, WORKLOADS[n], structuredClone(vaults.get(n)!));
    const after: Notes = Object.fromEntries([...t.f.files].map(([p, f]) => [p, structuredClone(f)]));
    for (const [p, text] of t.f.others) after[p] = { raw: text };
    vaults.set(n, after);
  }
}

if (args.golden) {
  mkdirSync(args.golden, { recursive: true });
  for (const n of names) {
    const { shown, t } = await run(n, WORKLOADS[n], structuredClone(vaults.get(n)!));
    // Whatever a timer would still bring has to be there already, or the timings stop too soon.
    const before = document.body.innerHTML;
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));
    if (document.body.innerHTML !== before) throw new Error(`${n}: the page changed after settling`);
    const written = Object.fromEntries(t.writes.map((p) => [p, t.f.files.get(p)]));
    writeFileSync(`${args.golden}/${args.size}-${n}.json`, JSON.stringify({ ...shown, written }, null, 1));
  }
} else {
  const iters = Number(args.iters);
  for (let i = 0; i < iters; i++) {
    for (const n of names) {
      const notes = structuredClone(vaults.get(n)!);
      if (args.dry) continue;
      const { ms } = await run(n, WORKLOADS[n], notes);
      if (args.out) appendFileSync(args.out, `${JSON.stringify({ size: args.size, app: n, iter: i, ...ms })}\n`);
    }
  }
}
