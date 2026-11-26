import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { resolveLink } from "../src/note-text.ts";

/** gizmod's resolution before it moved, on Node's own path join: what resolveLink must still give. */
function before(files: string[], link: string, from: string): string | undefined {
  const target = link.split("#")[0].split("|")[0].trim().normalize("NFC");
  if (!target) return undefined;
  const lower = target.toLowerCase();
  const exact = files.find((p) => p.toLowerCase() === lower || p.toLowerCase() === `${lower}.md`);
  if (exact) return exact;
  const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  if (target.startsWith("./") || target.startsWith("../")) {
    const joined = posix.normalize(posix.join(fromDir || ".", target)).toLowerCase();
    const found = files.find((p) => p.toLowerCase() === joined || p.toLowerCase() === `${joined}.md`);
    if (found) return found;
  }
  const want = target.toLowerCase();
  const candidates = files.filter((p) => [want, `${want}.md`].some((w) => p.toLowerCase() === w || p.toLowerCase().endsWith(`/${w}`)));
  if (!candidates.length) return undefined;
  const here = candidates.find((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === fromDir);
  return here ?? candidates.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
}

test("a link resolves as gizmod resolved it on Node's path join: names, paths, case, ./ and ../, headings and aliases", () => {
  const files = ["Spend.md", "Kinds/Spend.md", "Apps/Budget.md", "Apps/Sub/Deep.md", "Apps/spend.md", "Trips/Tokyo.ics", "Notes/A b.md", "Folder/x.md", "Folder"];
  const links = ["Spend", "spend", "Kinds/Spend", "kinds/spend.md", "./Spend", "../Kinds/Spend", "../../Kinds/Spend", "../../../x", "./Sub/Deep", "Sub/../Budget", "../Folder/", "./", "..", ".", "Tokyo.ics", "Deep#Heading", "Budget|alias", "A b", "Gone", "", "  ", "../Apps/./Budget"];
  const froms = ["Apps/Budget.md", "Apps/Sub/Deep.md", "Today.md", "Kinds/Spend.md"];
  for (const from of froms) for (const link of links) assert.equal(resolveLink(files, link, from), before(files, link, from), `${link} from ${from}`);
});
