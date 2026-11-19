import { parseBody } from "../data.ts";
import { fileDep, nameDep } from "../deps.ts";
import type { SourceDef } from "./types.ts";

const CONTENT_TYPES: Record<string, string> = { csv: "text/csv", json: "application/json", ics: "text/calendar" };

/** The path or file name a file source names, without link brackets, alias or heading: `[[Finance/bank.csv|Bank]]` gives `Finance/bank.csv`. */
export function fileTarget(source: string): string {
  const text = source.trim();
  const link = /^\[\[(.*)\]\]$/.exec(text);
  return link ? link[1].split("|")[0].split("#")[0].trim() : text;
}

const extensionOf = (source: string) => /\.(csv|json|ics)$/i.exec(fileTarget(source))?.[1].toLowerCase();

/** A `.csv`, `.json` or `.ics` file in the vault, by path or `[[link]]`. */
export const file: SourceDef = {
  id: "file",
  matches: (source) => !/^https?:\/\//i.test(source) && extensionOf(source) !== undefined,
  permissions: (p) => [[`read:${fileTarget(p.source!)}`, "source"]],
  // A link may name the file by its name alone, so a change under that name counts too.
  deps(p) {
    const target = fileTarget(p.source!);
    return [fileDep(target), nameDep(target.split("/").pop()!)];
  },
  load(p, files, layer, opts) {
    const target = fileTarget(p.source!);
    const path = layer.host.resolveFile(target, files.appPath) ?? target;
    const type = CONTENT_TYPES[extensionOf(p.source!)!];
    return layer.parsedFile(path, (text) => {
      try {
        // Spreadsheet exports often start with a byte order mark, which would stick to the first column's name.
        return parseBody(text.replace(/^﻿/, ""), type, opts.now);
      } catch (e) {
        throw new Error(`Can't read ${path}: ${(e as Error).message}`);
      }
    });
  },
};
