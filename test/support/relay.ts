import type { Host } from "../../src/datalayer.ts";

/**
 * An ntfy server in memory, at RELAY, for shared kinds: POST /<topic> keeps a message, GET
 * /<topic>/json?poll=1&since=<id|all> gives the ones after it, one JSON line each. It can lose,
 * duplicate and reorder what is posted (by a seeded random), keep messages only for `retentionMs`,
 * and be down. Every request is counted.
 */
export const RELAY = "https://relay.test";

/** A small seeded random, so a failing interleaving can be run again. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function memoryRelay(opts: { random?: () => number; now?: () => number } = {}) {
  const random = opts.random ?? Math.random;
  const topics = new Map<string, { id: string; time: number; message: string }[]>();
  const faults = { lose: 0, duplicate: 0, reorder: 0, down: false, retentionMs: Infinity };
  const requests: { method: string; url: string }[] = [];
  let next = 0;
  const now = () => opts.now?.() ?? Date.now();
  const keep = (topic: string, message: string) => {
    const list = topics.get(topic) ?? [];
    topics.set(topic, list);
    const m = { id: `m${(next++).toString(36).padStart(6, "0")}`, time: Math.floor(now() / 1000), message };
    if (faults.reorder && list.length && random() < faults.reorder) list.splice(Math.max(0, list.length - 1 - Math.floor(random() * 3)), 0, m);
    else list.push(m);
  };
  const fetch: Host["fetch"] = async (url, _headers, init) => {
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    await new Promise((r) => setTimeout(r, 0));
    if (faults.down) throw new Error("no answer");
    const u = new URL(url);
    const [topic, json] = u.pathname.slice(1).split("/");
    const cut = now() - faults.retentionMs;
    for (const [t, list] of topics) topics.set(t, list.filter((m) => m.time * 1000 >= cut));
    if (method === "POST") {
      if (new TextEncoder().encode(init?.body ?? "").length > 4096) return { status: 413, text: "", contentType: "" };
      if (random() >= faults.lose) {
        keep(topic, init?.body ?? "");
        if (faults.duplicate && random() < faults.duplicate) keep(topic, init?.body ?? "");
      }
      return { status: 200, text: "{}", contentType: "application/json" };
    }
    if (json !== "json" || u.searchParams.get("poll") !== "1") return { status: 404, text: "", contentType: "" };
    const list = topics.get(topic) ?? [];
    const since = u.searchParams.get("since") ?? "all";
    const at = list.findIndex((m) => m.id === since);
    const after = since === "all" || at < 0 ? list : list.slice(at + 1);
    const text = after.map((m) => JSON.stringify({ id: m.id, time: m.time, event: "message", topic, message: m.message })).join("\n");
    return { status: 200, text: text ? `${text}\n` : "", contentType: "application/x-ndjson" };
  };
  return { fetch, topics, faults, requests, post: (topic: string, message: string) => keep(topic, message) };
}
