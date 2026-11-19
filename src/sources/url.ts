import type { SourceDef } from "./types.ts";

function secretsIn(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/\{secret:([a-z0-9-]+)\}/g)].map((m) => m[1]);
}

/** A web address, fetched through the data layer's shared cache. */
export const url: SourceDef = {
  id: "url",
  matches: (source) => /^https?:\/\//i.test(source),
  validate: (p) => [
    ...(/^http:\/\//i.test(p.source!) ? ["source must use https"] : []),
    ...(/^https?:\/\/[^/?#]*\{secret:/i.test(p.source!) ? ["a secret can't be part of the host; put it in the path, the query or headers"] : []),
  ],
  permissions(p) {
    const source = p.source!;
    const out: [string, "source" | "headers"][] = [];
    try {
      out.push([`net:${new URL(source.replace(/\{secret:[a-z0-9-]+\}/g, "x")).host}`, "source"]);
    } catch {
      out.push([`net:${source}`, "source"]);
    }
    for (const id of secretsIn(source)) out.push([`secret:${id}`, "source"]);
    for (const id of Object.values(p.headers ?? {}).flatMap(secretsIn)) out.push([`secret:${id}`, "headers"]);
    return out;
  },
  deps: (p) => [`url:${p.source}`],
  load: (p, _files, layer, opts) => layer.fetch(p.source!, p.headers, opts.ttlMs, opts.force),
};
