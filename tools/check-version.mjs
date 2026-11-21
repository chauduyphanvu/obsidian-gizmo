// Checks that a release's versions agree: manifest.json and package.json name the same x.y.z,
// versions.json maps it to the manifest's minAppVersion, and the tag, when given, is that version.
//   node tools/check-version.mjs [tag]
import { readFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");
const tag = process.argv[2];
const problems = [];

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push(`manifest.json's version ${manifest.version} isn't x.y.z`);
if (pkg.version !== manifest.version) problems.push(`package.json says ${pkg.version}, manifest.json ${manifest.version}`);
if (versions[manifest.version] !== manifest.minAppVersion) {
  problems.push(`versions.json maps ${manifest.version} to ${versions[manifest.version] ?? "nothing"}, not ${manifest.minAppVersion}`);
}
if (tag && tag !== manifest.version) problems.push(`the tag ${tag} isn't manifest.json's version ${manifest.version}`);

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`version ${manifest.version} agrees${tag ? ` with the tag` : ""}`);
