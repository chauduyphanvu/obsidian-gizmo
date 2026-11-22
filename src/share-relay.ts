/**
 * The relay a shared kind's messages pass through: an ntfy topic. A message is posted as the body
 * of a request to `<relay>/<topic>`; what the topic holds is read with `GET <relay>/<topic>/json?
 * poll=1&since=<id>`, one JSON object a line, oldest first. The relay keeps messages for a while
 * (about 12 hours on ntfy.sh) and sees only sealed text. Requests go through the host's fetch:
 * Obsidian's requestUrl in the plugin, fetch in gizmod.
 */
import type { Host } from "./datalayer.ts";

/** A message as the relay hands it back: its id there (the cursor to read on from), when it came, its text. */
export interface RelayMessage {
  id: string;
  time: number;
  text: string;
}

export interface Relay {
  /** Posts one message; rejects when the relay can't be reached or refuses it. */
  post(topic: string, text: string): Promise<void>;
  /** The messages after `since` (a message id), or all it keeps; rejects when it can't be read. */
  poll(topic: string, since: string | undefined): Promise<RelayMessage[]>;
}

/** Why a relay request failed, in words that follow "couldn't reach the relay: ". */
export class RelayError extends Error {}

export function ntfyRelay(base: string, fetch: Host["fetch"]): Relay {
  const at = (topic: string) => `${base.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
  const call = async (url: string, init?: { method: string; body: string }) => {
    let res: Awaited<ReturnType<Host["fetch"]>>;
    try {
      res = await fetch(url, {}, init);
    } catch (e) {
      throw new RelayError((e as Error).message || "no answer");
    }
    if (res.status >= 400) throw new RelayError(`it answered ${res.status}`);
    return res.text;
  };
  return {
    async post(topic, text) {
      await call(at(topic), { method: "POST", body: text });
    },
    async poll(topic, since) {
      const text = await call(`${at(topic)}/json?poll=1&since=${encodeURIComponent(since ?? "all")}`);
      const out: RelayMessage[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as { id?: unknown; time?: unknown; event?: unknown; message?: unknown };
          if (m.event === "message" && typeof m.id === "string" && typeof m.message === "string") out.push({ id: m.id, time: typeof m.time === "number" ? m.time : 0, text: m.message });
        } catch {
          // A line that isn't JSON (a proxy's page, a line cut short) is no message.
        }
      }
      return out;
    },
  };
}
