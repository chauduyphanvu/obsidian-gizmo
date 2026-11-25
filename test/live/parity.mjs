// gizmod reads the vault as Obsidian does: every note of the test vault and the gallery (and a few
// notes made to be hard) read by a real Obsidian through CDP, and by gizmod's NodeVault, compared
// field by field: frontmatter, tags, when it was made, and where each of its links goes. Then every
// app's panels read in both, and the same frontmatter edits made by both, compared.
//   node test/live/parity.mjs <empty work dir>     (run `npm run build` first)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gizmodEnv } from "../../scripts/gizmod/host.ts";
import { NodeVault } from "../../scripts/gizmod/vault.ts";
import { launch } from "./launch.mjs";
import { tools } from "./tools.mjs";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(work) && readdirSync(work).length)) throw new Error("pass an empty or missing work directory");
const port = Number(process.env.CDP_PORT ?? "9370");
const results = [];
mkdirSync(join(work, "shots"), { recursive: true });

/** Notes made to be hard: names twice over, odd YAML, tags in code, links of every kind. */
const HARD = {
  "Inbox.md": "root inbox",
  "Apps/Inbox.md": "apps inbox",
  "Apps/Deep/Inbox.md": "deep inbox",
  "Apps/Linker.md": "[[Inbox]] [[Deep/Inbox]] [[inbox]] [[Apps/Inbox]] [[Inbox#Heading]] [[Inbox|alias]] [[Plan]] [[Nowhere]]",
  "Notes/Linker.md": "[[Inbox]] [[deep/inbox]] [[Plan]] [[./Near]] [[../Inbox]]",
  "Notes/Near.md": "near",
  "Projects/Plan.md": "plan",
  "Odd/Dates.md": "---\ndue: 2026-11-25\nwhen: 2026-11-25T08:00\nn: 08\nyes: yes\nnull: ~\nlist: [a, 1, true]\n---\n",
  "Odd/Broken.md": "---\ntitle: [unclosed\nok: 1\n---\nbody",
  "Odd/Tags.md": "---\ntags: a, b c\n---\n#inline `#code` #2026 #x/y-z\n```\n#fenced\n```\n",
  "Odd/Tag.md": "---\ntag: single\n---\ntext #ünïcode",
  "Odd/Empty.md": "---\n---\nempty block",
  "Odd/TagString.md": "---\ntags: single\n---\n",
  "Odd/TagComma.md": "---\ntags: one, two\n---\n",
  "Odd/TagList.md": "---\ntags:\n  - one\n  - two/three\n  - \"#four\"\n---\n",
  "Odd/TagNum.md": "---\ntags: [2026, x2]\n---\n",
  "Odd/NoClose.md": "---\na: 1\nno closing line",
  "Odd/Bom.md": "\uFEFF---\nbom: 1\ntags: [bomtag]\n---\nbody #bominline",
  "Odd/Fence4.md": "````\n```\n#inner\n```\n````\n#after4\n~~~\n#tilde\n~~~\n#aftertilde\n```js\n#lang\n```\n#afterlang",
  "Odd/Comments.md": "%% #pct %%\n<!-- #html -->\n%%\n#pctblock\n%%\n<!--\n#htmlblock\n-->\ntext #after",
  "Odd/Dup.md": "---\na: 1\na: 2\nb: 3\n---\n",
  "Odd/TagCase.md": "#Alpha #alpha #ALPHA",
  "Cafe\u0301.md": "decomposed name",
  "Odd/LinksCafe.md": "[[Caf\u00e9]] [[Cafe\u0301]]",
  "Notes/Linker2.md": "[[./near]] [[../inbox]] [[./NEAR]]",
};

/** Edits made by Obsidian's processFrontMatter to `W/<name>-o.md` and by gizmod's to `W/<name>-g.md`, from the same text. */
const WRITES = {
  none: { text: "body\n", fn: "fm.a = 1;" },
  empty: { text: "---\n---\nbody\n", fn: "fm.a = 1;" },
  drop: { text: "---\na: 1\n---\nbody\n", fn: "delete fm.a;" },
  same: { text: "---\nx: 1\n---\nbody\n", fn: "" },
  bom: { text: "\uFEFF---\nx: 1\n---\nbody\n", fn: "fm.a = 1;" },
  crlf: { text: "---\r\nx: 1\r\n---\r\nbody\r\n", fn: "fm.a = 1;" },
  list: { text: "---\nx: 1\n---\nbody\n", fn: "fm.tags = ['a', 'b/c'];" },
  quoted: { text: "body\n", fn: "fm.note = 'a: b'; fm.when = '2026-11-25'; fm.n = '08';" },
  nested: { text: "body\n", fn: "fm.share = { relay: 'https://ntfy.sh', key: { secret: 'k' } };" },
};

const a = await launch({ repo, dir: join(work, "obsidian"), port, fill: (vault) => {
  cpSync(join(repo, "test/vault"), vault, { recursive: true });
  cpSync(join(repo, "gallery"), vault, { recursive: true });
  for (const [path, text] of Object.entries(HARD)) {
    mkdirSync(join(vault, path, ".."), { recursive: true });
    writeFileSync(join(vault, path), text);
  }
  // A folder and a note reached through symlinks, as a vault can hold them.
  const outside = join(vault, "..", "outside");
  mkdirSync(join(outside, "Shared"), { recursive: true });
  writeFileSync(join(outside, "Shared", "Far.md"), "---\nfar: 1\n---\nfar away #far");
  symlinkSync(join(outside, "Shared"), join(vault, "Shared"));
  symlinkSync(join(vault, "Inbox.md"), join(vault, "Alias.md"));
  mkdirSync(join(vault, "W"), { recursive: true });
  for (const [name, c] of Object.entries(WRITES)) {
    writeFileSync(join(vault, "W", `${name}-o.md`), c.text);
    writeFileSync(join(vault, "W", `${name}-g.md`), c.text);
  }
} });
try {
  const t = await tools(a.page, join(work, "shots"), "parity", results);
  const seen = await t.run(`
    await na.sleep(1500);
    const out = {};
    for (const f of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(f);
      const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].map((l) => l.link);
      out[f.path] = {
        fm: cache?.frontmatter ?? null,
        // Gizmo's own host reads tags with Obsidian's getAllTags.
        tags: na.plugin().runtime.dataLayer.host.tags(f.path),
        ctime: f.stat.ctime,
        links: Object.fromEntries(links.map((l) => [l, app.metadataCache.getFirstLinkpathDest(l.split("#")[0].split("|")[0], f.path)?.path ?? null])),
      };
    }
    return out;`);
  const v = new NodeVault(a.vault);
  await v.scan();
  const diffs = { fm: [], tags: [], ctime: [], links: [], missing: [] };
  for (const [path, o] of Object.entries(seen)) {
    const n = v.file(path);
    if (!n) {
      diffs.missing.push(path);
      continue;
    }
    // Obsidian's frontmatter, made plain the way JSON makes it (it holds no dates).
    const fm = o.fm === null ? undefined : JSON.parse(JSON.stringify(o.fm));
    if (!isDeepStrictEqual(n.fm === undefined ? undefined : JSON.parse(JSON.stringify(n.fm)), fm)) diffs.fm.push({ path, obsidian: fm, gizmod: n.fm });
    // Case counts: `from: #tag` matches as typed. How often a tag appears doesn't.
    const tags = [...new Set(o.tags)].sort();
    const mine = [...new Set(n.tags)].sort();
    if (!isDeepStrictEqual(tags, mine)) diffs.tags.push({ path, obsidian: o.tags, gizmod: n.tags });
    if (Math.abs(n.info.ctime - o.ctime) > 1000) diffs.ctime.push({ path, obsidian: o.ctime, gizmod: n.info.ctime });
    for (const [link, dest] of Object.entries(o.links)) {
      const mineDest = v.resolve(link, path) ?? null;
      if (mineDest !== dest) diffs.links.push({ path, link, obsidian: dest, gizmod: mineDest });
    }
  }
  diffs.extra = [...v.notes().map((f) => f.path)].filter((p) => !(p in seen));
  const total = Object.keys(seen).length;
  for (const [kind, list] of Object.entries(diffs)) {
    await t.check(`${kind}: gizmod reads every note's ${kind} as Obsidian does`, async () => {
      t.expect(list.length === 0, list.slice(0, 8));
      return `${total} notes`;
    });
  }

  // Every app's panels, read in both at one moment: what the 14 sources make of a real vault.
  const obsidianData = JSON.parse(await t.run(`
    const bg = na.plugin().runtime.background;
    const t0 = Date.now();
    const out = {};
    for (const a of bg.list()) {
      const spec = bg.spec(a.path);
      if (!spec) continue;
      out[a.path] = [];
      for (const ps of [...spec.panels, ...Object.values(spec.recorded)]) {
        const e = await bg.evaluate(a.path, ps, true);
        out[a.path].push(e.error !== undefined ? { error: e.error } : e.waiting !== undefined ? { waiting: e.waiting } : { value: e.value ?? null, shown: e.shown, rows: e.rows ?? null });
      }
    }
    return JSON.stringify({ t0, out });`));
  const env = gizmodEnv({ vault: a.vault, device: "gzparity", now: () => obsidianData.t0, log: () => {}, fetch: async () => { throw new Error("parity-offline"); } });
  await env.vault.scan();
  await env.runtime.open();
  await env.runtime.background.start();
  const dataDiffs = [];
  let compared = 0;
  let offline = 0;
  for (const [path, list] of Object.entries(obsidianData.out)) {
    const spec = env.runtime.background.spec(path);
    if (!spec) {
      dataDiffs.push({ path, gizmod: "not an app" });
      continue;
    }
    const panels = [...spec.panels, ...Object.values(spec.recorded)];
    for (let i = 0; i < panels.length; i++) {
      const e = await env.runtime.background.evaluate(path, panels[i], true);
      const g = JSON.parse(JSON.stringify(e.error !== undefined ? { error: e.error } : e.waiting !== undefined ? { waiting: e.waiting } : { value: e.value ?? null, shown: e.shown, rows: e.rows ?? null }));
      // What comes from the web is read only in Obsidian here.
      if (JSON.stringify(g).includes("parity-offline")) {
        offline++;
        continue;
      }
      compared++;
      if (!isDeepStrictEqual(g, list[i])) dataDiffs.push({ path, panel: panels[i].panel?.title ?? panels[i].panel?.view ?? i, obsidian: list[i], gizmod: g });
    }
  }
  env.runtime.stop();
  await t.check("data: every app's panels read the same in gizmod as in Obsidian", async () => {
    t.expect(dataDiffs.length === 0, dataDiffs.slice(0, 4));
    return `${compared} panels of ${Object.keys(obsidianData.out).length} apps (${offline} from the web, read only in Obsidian)`;
  });

  // The same frontmatter edits, made by Obsidian and by gizmod, leave the same text.
  await t.run(`
    const cases = ${JSON.stringify(Object.fromEntries(Object.entries(WRITES).map(([k, c]) => [k, c.fn])))};
    for (const [name, fn] of Object.entries(cases)) {
      await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath("W/" + name + "-o.md"), new Function("fm", fn));
    }
    await na.sleep(800);`);
  const w = new NodeVault(a.vault);
  await w.scan();
  const writeDiffs = [];
  for (const [name, c] of Object.entries(WRITES)) {
    await w.process(`W/${name}-g.md`, new Function("fm", c.fn)).catch((e) => writeDiffs.push({ name, gizmod: `threw: ${e.message}` }));
    const o = readFileSync(join(a.vault, "W", `${name}-o.md`), "utf8");
    const g = readFileSync(join(a.vault, "W", `${name}-g.md`), "utf8");
    if (o !== g) writeDiffs.push({ name, obsidian: o, gizmod: g });
  }
  await t.check("writes: gizmod edits frontmatter as Obsidian does", async () => {
    t.expect(writeDiffs.length === 0, writeDiffs);
    return `${Object.keys(WRITES).length} edits`;
  });
} catch (e) {
  results.push({ name: "parity: the run itself", status: "FAIL", detail: e.message.split("\n")[0] });
} finally {
  a.page.close();
  a.quit();
}
for (const r of results) console.log(`${r.status}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
