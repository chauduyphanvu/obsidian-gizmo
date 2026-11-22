/**
 * A kind shared with other vaults: its `share:` key, and the words Gizmo uses for it. The key
 * itself is a secret (see share-crypto.ts); the note names only the relay and the secret's id.
 */
import { isPlainObject } from "./keys.ts";
import { b64url, fromB64url } from "./share-crypto.ts";

/** Where a shared kind's rows travel: an ntfy server, its host, and the id of the secret that holds the kind's key. */
export interface ShareSpec {
  relay: string;
  host: string;
  secret: string;
}

const SHARE_HELP = 'share needs relay (an ntfy server) and key (a secret), e.g. share: {relay: "https://ntfy.sh", key: {secret: chore-key}}';

/** A relay on this computer may be plain http; any other must be https. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A kind's `share:` key: the relay's address and the secret's id; why not, when it can't be read. */
export function readShare(value: unknown): { share?: ShareSpec; errors: string[] } {
  if (value === undefined || value === null) return { errors: [] };
  if (!isPlainObject(value)) return { errors: [SHARE_HELP] };
  const unknown = Object.keys(value).find((k) => k !== "relay" && k !== "key");
  if (unknown !== undefined) return { errors: [`share: unknown key "${unknown}"; ${SHARE_HELP}`] };
  let url: URL | undefined;
  try {
    url = typeof value.relay === "string" ? new URL(value.relay) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.search || url.hash || url.username || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) {
    return { errors: [`share: relay must be the https address of an ntfy server, e.g. https://ntfy.sh, not ${JSON.stringify(value.relay ?? "")}`] };
  }
  const key = value.key;
  const secret = isPlainObject(key) && typeof key.secret === "string" ? key.secret : undefined;
  if (secret === undefined || !/^[a-z0-9-]+$/.test(secret)) return { errors: [`share: key must name a secret of lowercase letters, digits and dashes, e.g. key: {secret: chore-key}`] };
  return { share: { relay: url.toString().replace(/\/+$/, ""), host: url.host, secret }, errors: [] };
}

/** What an invite to a shared kind carries: the kind's note (its name and the keys that make it), the kind's key, and who sent it. */
export interface Invite {
  name: string;
  fm: Record<string, unknown>;
  key: Uint8Array;
  from: string;
  writer: string;
}

/** The keys of a kind note an invite takes along: its shape and how it is shared, never its import folders or its rules. */
const INVITE_KEYS = ["kind", "fields", "shortcut", "match", "share"];

export function inviteKeys(fm: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(INVITE_KEYS.filter((k) => fm[k] !== undefined).map((k) => [k, fm[k]]));
}

const toB64url = (text: string) => b64url(new TextEncoder().encode(text));

/**
 * An invite as a link Obsidian opens: `obsidian://gizmo?invite=…`. The key is in it, so it goes to
 * whoever is invited and to no server: Obsidian reads the link on the device it opens on.
 */
export function inviteLink(i: Invite): string {
  return `obsidian://gizmo?invite=${toB64url(JSON.stringify({ v: 1, name: i.name, fm: i.fm, key: b64url(i.key), from: i.from, writer: i.writer }))}`;
}

/** An invite from its link, or the text after `invite=`; why not, when it isn't one. */
export function readInvite(text: string): Invite | { error: string } {
  const raw = text.trim().replace(/^obsidian:\/\/gizmo\?invite=/, "");
  const bytes = fromB64url(decodeURIComponentSafe(raw));
  let v: unknown;
  try {
    v = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
  } catch {
    v = undefined;
  }
  if (!isPlainObject(v) || v.v !== 1 || typeof v.name !== "string" || !isPlainObject(v.fm) || typeof v.key !== "string" || typeof v.from !== "string" || typeof v.writer !== "string") {
    return { error: "this isn't an invite to a shared kind; ask for the link again" };
  }
  const key = fromB64url(v.key);
  if (key?.length !== 32 || !/^[0-9a-f]{16}$/.test(v.writer)) return { error: "this invite is cut short; ask for the link again" };
  // The name becomes a note's name in this vault: one note, in no folder.
  if (!/^[^\\/:*?"<>|#^[\]]{1,60}$/.test(v.name) || v.name.startsWith(".")) return { error: `this invite names its kind “${v.name.slice(0, 60)}”, which can't be a note's name` };
  if (readShare(v.fm.share).errors.length) return { error: "this invite doesn't say where its rows go; ask for the link again" };
  return { name: v.name, fm: inviteKeys(v.fm), key, from: v.from.slice(0, 60), writer: v.writer };
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
