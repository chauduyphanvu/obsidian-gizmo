import type { FileInfo, Host } from "../../src/datalayer.ts";

/** An in-memory vault and network. `flush()` delivers batched change notifications. */
export function fakeHost(notes: Record<string, { fm?: Record<string, unknown>; tags?: string[] }> = {}) {
  const files = new Map(Object.entries(notes));
  const requests: string[] = [];
  let queued: (() => void)[] = [];
  let clock = 1_000_000;
  const secrets: Record<string, string> = { demo: "s3cret" };
  const info = (path: string): FileInfo => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, ""), mtime: 0, ctime: 0 });
  const host: Host = {
    async fetch(url) {
      requests.push(url);
      await new Promise((r) => setTimeout(r, 5));
      if (url.includes("/never")) return new Promise(() => {});
      if (url.includes("/fail")) return { status: 503, text: "", contentType: "" };
      return { status: 200, text: JSON.stringify({ current: { t: 7 }, hourly: { time: ["a", "b"], t: [1, 2] } }), contentType: "application/json" };
    },
    markdownFiles: () => [...files.keys()].map(info),
    fileInfo: (path) => (files.has(path) ? info(path) : undefined),
    frontmatter: (path) => files.get(path)?.fm,
    tags: (path) => files.get(path)?.tags ?? [],
    secret: (id) => secrets[id] ?? null,
    now: () => clock,
    schedule: (cb) => { queued.push(cb); },
  };
  return {
    host,
    files,
    requests,
    advance: (ms: number) => { clock += ms; },
    flush: () => { const q = queued; queued = []; q.forEach((cb) => cb()); return q.length; },
  };
}

