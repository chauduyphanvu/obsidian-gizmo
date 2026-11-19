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
    const out: [string, "source" | "headers" | "body"][] = [];
    let host = source;
    try {
      host = new URL(source.replace(/\{secret:[a-z0-9-]+\}/g, "x")).host;
    } catch {
      // Not a URL at all: the address as typed is what's asked about.
    }
    out.push([`net:${host}`, "source"]);
    for (const id of secretsIn(source)) out.push([`secret:${id}`, "source"]);
    for (const id of Object.values(p.headers ?? {}).flatMap(secretsIn)) out.push([`secret:${id}`, "headers"]);
    if (p.body !== undefined) {
      out.push([`post:${host}`, "body"]);
      for (const id of secretsIn(typeof p.body === "string" ? p.body : JSON.stringify(p.body))) out.push([`secret:${id}`, "body"]);
    }
    return out;
  },
  deps: (p) => [`url:${p.source}`],
  load: (p, _files, layer, opts) => layer.fetch(p.source!, p.headers, opts.ttlMs, opts.force, p.body),
};
