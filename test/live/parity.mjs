// gizmod reads the vault as Obsidian does: every note of the test vault and the gallery (and a few
// notes made to be hard) read by a real Obsidian through CDP, and by gizmod's NodeVault, compared
// field by field: frontmatter, tags, when it was made, and where each of its links goes.
//   node test/live/parity.mjs <empty work dir>     (run `npm run build` first)
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { NodeVault } from "../../src/node/vault.ts";
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
};

const a = await launch({ repo, dir: join(work, "obsidian"), port, fill: (vault) => {
  cpSync(join(repo, "test/vault"), vault, { recursive: true });
  cpSync(join(repo, "gallery"), vault, { recursive: true });
  for (const [path, text] of Object.entries(HARD)) {
    mkdirSync(join(vault, path, ".."), { recursive: true });
    writeFileSync(join(vault, path), text);
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
        tags: na.plugin().dataLayer.host.tags(f.path),
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
    const tags = o.tags.map((x) => x.toLowerCase()).sort();
    const mine = n.tags.map((x) => x.toLowerCase()).sort();
    if (!isDeepStrictEqual([...new Set(tags)], [...new Set(mine)])) diffs.tags.push({ path, obsidian: o.tags, gizmod: n.tags });
    if (Math.abs(n.info.ctime - o.ctime) > 1000) diffs.ctime.push({ path, obsidian: o.ctime, gizmod: n.info.ctime });
    for (const [link, dest] of Object.entries(o.links)) {
      const mineDest = v.resolve(link, path) ?? null;
      if (mineDest !== dest) diffs.links.push({ path, link, obsidian: dest, gizmod: mineDest });
    }
  }
  const total = Object.keys(seen).length;
  for (const [kind, list] of Object.entries(diffs)) {
    await t.check(`${kind}: gizmod reads every note's ${kind} as Obsidian does`, async () => {
      t.expect(list.length === 0, list.slice(0, 8));
      return `${total} notes`;
    });
  }
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
