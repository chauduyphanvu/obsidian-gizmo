import { readdirSync, readFileSync } from "node:fs";
import type { GalleryNote } from "./gallery.ts";

/**
 * The apps and components of gallery/, read from the repo. This is what the tests see;
 * esbuild.config.mjs puts the same list into main.js, where there is no repo to read.
 */
const gallery = new URL("../gallery/", import.meta.url);

const notes: GalleryNote[] = ["Apps", "Components"].flatMap((folder) => readdirSync(new URL(`${folder}/`, gallery))
  .filter((file) => file.endsWith(".md"))
  .sort()
  .map((file) => ({ path: `${folder}/${file}`, text: readFileSync(new URL(`${folder}/${file}`, gallery), "utf8") })));

export default notes;
