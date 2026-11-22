// Live smoke test in isolated Obsidian instances. Run `npm run build` first.
//   node test/live/smoke.mjs <empty work dir> [check file ...]
// Two launches, each with its own user-data dir, vault copy and CDP port (CDP_PORT, default 9334,
// and the port after it): `vault` is a copy of test/vault, `gallery` is test/vault with gallery/
// copied over it and its sample rows written for today (see tools/samples.ts). Each runs its check
// files from test/live/checks/ (all, or those named), takes screenshots into <work dir>/shots, and
// quits only the instance it started. Prints PASS, FAIL or
// SKIP per check (SKIP only for a check whose web API didn't answer) and exits non-zero on a FAIL.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./launch.mjs";
import { tools } from "./tools.mjs";
import { dayOf, writeSamples } from "../../tools/samples.ts";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) {
  throw new Error("pass an empty or missing work directory");
}
const only = process.argv.slice(3);
const port = Number(process.env.CDP_PORT ?? "9334");
const shots = join(work, "shots");
mkdirSync(shots, { recursive: true });

const phases = [
  {
    name: "vault",
    fill: (vault) => cpSync(join(repo, "test/vault"), vault, { recursive: true }),
    // In this order: `fresh` needs apps nobody has opened yet; `apps` opens (and allows) every app.
    checks: ["fresh", "concise", "apps", "data", "interaction", "sources", "tasks", "display", "views", "embeds", "lenses", "background", "triggers", "map", "answers", "capture", "kinds", "lines", "next", "ahead", "policy", "try", "authoring", "fixes", "bases", "replay", "screens", "history"],
  },
  {
    name: "gallery",
    fill: (vault) => {
      cpSync(join(repo, "test/vault"), vault, { recursive: true });
      cpSync(join(repo, "gallery"), vault, { recursive: true });
      // The sample rows, written for today, so the checks read the same story whatever day they run.
      writeSamples(vault, dayOf("today"));
    },
    checks: ["gallery", "ask"],
  },
];

const results = [];
for (const [i, phase] of phases.entries()) {
  const files = phase.checks.filter((c) => !only.length || only.includes(c));
  if (!files.length) continue;
  const { page, vault, quit } = await launch({ repo, dir: join(work, phase.name), port: port + i, fill: phase.fill });
  try {
    const t = await tools(page, shots, phase.name, results);
    t.vault = vault;
    for (const file of files) {
      const { default: checks } = await import(`./checks/${file}.mjs`);
      await checks(t);
    }
  } catch (e) {
    results.push({ name: `${phase.name}: the run itself`, status: "FAIL", detail: e.message.split("\n")[0] });
  } finally {
    page.close();
    quit();
  }
}

for (const r of results) console.log(`${r.status}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped; screenshots in ${shots}`);
process.exitCode = count("FAIL") ? 1 : 0;
