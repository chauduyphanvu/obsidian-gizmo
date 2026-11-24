import { parseBody } from "../data.ts";
import { fileDep } from "../deps.ts";
import { vaultPath } from "../store.ts";
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
  validate(p) {
    const target = fileTarget(p.source!);
    return vaultPath(target) === target ? [] : [`source must be the file's path from the vault's root, for example Finance/bank.csv, not ${target}`];
  },
  permissions: (p) => [[`read:${fileTarget(p.source!)}`, "source"]],
  deps: (p) => [fileDep(fileTarget(p.source!))],
  // The path is the file's own, from the vault's root, and never found as a link is: the permission
  // and the data policy's label name the text typed, so that must be the file that is read.
  load(p, files, layer, opts) {
    const path = fileTarget(p.source!);
    const type = CONTENT_TYPES[extensionOf(p.source!)!];
    return layer.parsedFile(path, (text) => {
      try {
        // Spreadsheet exports often start with a byte order mark, which would stick to the first column's name.
        return parseBody(text.replace(/^\uFEFF/, ""), type, opts.now);
      } catch (e) {
        throw new Error(`Can't read ${path}: ${(e as Error).message}`, { cause: e });
      }
    }).catch((e: Error) => {
      // A name alone is what a link would take: said only then, so a missing file's own error stays short.
      if (!e.message.startsWith("Can't find ") || path.includes("/")) throw e;
      // The file a link of that name would find is only named, never read: writing its path is the person's to do.
      const found = layer.host.resolveFile(path, files.appPath);
      const where = found !== undefined && found !== path ? `write ${found}` : "for example Finance/bank.csv";
      throw new Error(`Can't find ${path}; a file source takes its path from the vault's root: ${where}`, { cause: e });
    });
  },
};
