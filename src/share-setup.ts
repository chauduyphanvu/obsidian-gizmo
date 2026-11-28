/**
 * Setting up a shared kind, on any host the runtime runs in: its key (made, or kept from another
 * device), the invite link, joining from one, and a guest page. The key is a secret, kept in the
 * host's secret store and never in a note; what the windows say about each step is the host's.
 */
import { sharedAlready } from "./background-share.ts";
import { otherShareStates } from "./device.ts";
import { guestCheck, guestCode, guestPageHtml } from "./guest-page.ts";
import { readFields } from "./keys.ts";
import { describePermission, permissionsOf } from "./permissions.ts";
import type { GizmoRuntime, SecretStore } from "./runtime.ts";
import { inviteKeys, inviteLink, type Invite } from "./share.ts";
import { guestKeyBytes, identityText, newIdentity, newSigningKey, readIdentity, topicOf, writerOf, type Identity } from "./share-crypto.ts";
import { readSpec, type KindSpec } from "./spec.ts";
import { basename, defaultDataPath } from "./store.ts";
import { writersOf } from "./stored.ts";

function store(rt: GizmoRuntime): SecretStore {
  const secrets = rt.host.secrets;
  if (!secrets) throw new Error("this program keeps no secrets, so it can't keep a kind's key");
  return secrets;
}

/** A shared kind's note, its keys as read, and the key its secret holds, if any. */
export function sharedKindOf(rt: GizmoRuntime, path: string): { fm: Record<string, unknown>; kind: KindSpec; id?: Identity } | undefined {
  const fm = rt.dataLayer.host.frontmatter(path);
  const kind = fm && readSpec(fm, { notes: rt.host.notes, path })?.spec?.kind;
  if (!fm || !kind?.share) return undefined;
  return { fm, kind, id: readIdentity(rt.host.secrets?.get(kind.share.secret) ?? null) };
}

/**
 * Whether this device may make the kind's key: not when its secret holds anything (Gizmo never
 * replaces one); and when the kind is shared already (from another of this vault's devices, or
 * joined), only the key the others use will do.
 */
export async function keyNeeded(rt: GizmoRuntime, path: string, kind: KindSpec): Promise<"taken" | { elsewhere: boolean }> {
  if (store(rt).get(kind.share!.secret) !== null) return "taken";
  const fm = rt.dataLayer.host.frontmatter(path) ?? {};
  const rows = (await rt.dataLayer.ledger?.state(defaultDataPath(path), fm))?.lists.get(kind.name)?.rows ?? [];
  return { elsewhere: sharedAlready(path, rows, writersOf(rt.store, path), await otherShareStates(rt.host.files, rt.device.id)) };
}

/** Makes the kind's key under the name this vault writes as, and keeps it as the secret, unless it holds something by now. */
export async function makeKey(rt: GizmoRuntime, secret: string, name: string): Promise<{ id: Identity } | { error: "taken" }> {
  const secrets = store(rt);
  if (secrets.get(secret) !== null) return { error: "taken" };
  const id = await newIdentity(name);
  secrets.set(secret, identityText(id));
  return { id };
}

/** Keeps a key copied from another device as the secret, unless it isn't one or the secret holds something by now. */
export function keepKey(rt: GizmoRuntime, secret: string, text: string): { id: Identity } | { error: "not-a-key" | "taken" } {
  const id = readIdentity(text);
  if (!id) return { error: "not-a-key" };
  const secrets = store(rt);
  if (secrets.get(secret) !== null) return { error: "taken" };
  secrets.set(secret, identityText(id));
  return { id };
}

/** The link that lets someone share the kind: its keys, the key itself, and who sends it. */
export async function inviteLinkOf(fm: Record<string, unknown>, name: string, id: Identity, base?: string): Promise<string> {
  return inviteLink({ name, fm: inviteKeys(fm), key: id.key, from: id.name, writer: await writerOf(id.sign) }, base);
}

/** What joining from an invite would make here, before anything is written. */
export interface JoinPlan {
  invite: Invite;
  /** Where the kind's note would go: where new notes go. */
  path: string;
  /** The secret its key would be kept as: the invite's, or the next one free here (`-2`, `-3`, …). */
  secret: string;
  fm: Record<string, unknown>;
  read: ReturnType<typeof readSpec>;
  kind?: KindSpec;
  /** A note is there, or one of that name anywhere: links go by name. */
  taken: boolean;
  /** What the kind will ask for when it opens, in words. */
  asks: string[];
}

export function joinPlan(rt: GizmoRuntime, invite: Invite): JoinPlan {
  const folder = rt.host.newNotesFolder();
  const path = (folder ? `${folder}/${invite.name}.md` : `${invite.name}.md`).normalize("NFC");
  const share = invite.fm.share as { relay: string; key: { secret: string } };
  const secret = freeSecret(store(rt), share.key.secret);
  const fm = { ...invite.fm, share: { relay: share.relay, key: { secret } } };
  const read = readSpec(fm, { notes: rt.host.notes, path });
  const kind = read?.spec?.kind;
  return {
    invite, path, secret, fm, read, kind,
    taken: rt.host.exists(path) || rt.host.notes.resolve(invite.name, "") !== undefined,
    asks: read?.spec ? permissionsOf(read.spec, path).map(describePermission) : [],
  };
}

/** The secret a kind's key would be kept as: `wanted`, or the next one free here (`-2`, `-3`, …). */
function freeSecret(secrets: SecretStore, wanted: string): string {
  let secret = wanted;
  for (let n = 2; secrets.get(secret) !== null; n++) secret = `${wanted}-${n}`;
  return secret;
}

/**
 * Joins: the kind's note, then its key kept as the secret, then the inviter accepted as a writer,
 * saved before it's done. The secret is chosen again at the click, so one filled since the preview
 * is never replaced; and the note comes first, so a note that can't be made leaves no secret
 * behind. The path to open, or why not.
 */
export async function join(rt: GizmoRuntime, plan: JoinPlan, name: string): Promise<{ path: string } | { error: string }> {
  const { invite, kind } = plan;
  if (!kind?.share) return { error: `This invite's kind can't be read` };
  if (rt.host.exists(plan.path)) return { error: `You already have a note called ${invite.name}` };
  const secrets = store(rt);
  const share = invite.fm.share as { relay: string; key: { secret: string } };
  const secret = secrets.get(plan.secret) === null ? plan.secret : freeSecret(secrets, share.key.secret);
  const fm = secret === plan.secret ? plan.fm : { ...plan.fm, share: { relay: share.relay, key: { secret } } };
  const body = `Shared with you by ${invite.from} through ${kind.share.host}. Each row you add here goes to the people you share it with, sealed; theirs come in here.\n`;
  if ((await rt.host.writes.createNote(plan.path, fm, body)) === false) return { error: `You already have a note called ${invite.name}` };
  secrets.set(secret, identityText(await newIdentity(name, invite.key)));
  const writers = (rt.store.writers ??= {});
  writers[`${plan.path}\n${invite.writer}`] = { name: invite.from, state: "accepted", at: Date.now() };
  await rt.saveSettings();
  return { path: plan.path };
}

/** Where a guest page goes: beside the kind, named for the guest, never over a file that's there. */
export function guestPagePath(kindPath: string, guest: string, exists: (path: string) => boolean): string {
  const parent = kindPath.includes("/") ? kindPath.slice(0, kindPath.lastIndexOf("/")) : "";
  let path = `${parent ? `${parent}/` : ""}${basename(kindPath)} guest page (${guest.replace(/[\\/:*?"<>|#^[\]]/g, "-")}).html`;
  for (let n = 2; exists(path); n++) path = path.replace(/( \d+)?\.html$/, ` ${n}.html`);
  return path;
}

/**
 * A guest page: one HTML file with the kind's form, which can only add rows, signed with a key of
 * the guest's own; the guest is accepted as a writer. The code that unlocks it is given back, to
 * be shown, and never written; the kind's key is never in the page.
 */
export async function makeGuestPage(
  rt: GizmoRuntime, kindPath: string, fm: Record<string, unknown>, kind: KindSpec, id: Identity, guest: string,
): Promise<{ path: string; code: string; members: string[] }> {
  const sign = await newSigningKey();
  const writer = await writerOf(sign);
  const key = await guestKeyBytes(id.key, writer);
  const decided = writersOf(rt.store, kindPath);
  const members = [id.name, ...Object.values(decided).filter((w) => w.state === "accepted" && !w.guest).map((w) => w.name)];
  const labels = Object.fromEntries(Object.entries(readFields(fm.fields as Record<string, unknown>).info).flatMap(([f, i]) => (i.label ? [[f, i.label]] : [])));
  const html = guestPageHtml({ kind: basename(kindPath), fields: kind.fields, labels, relay: kind.share!.relay, topic: await topicOf(id.key), writer, guest, members, check: await guestCheck(key, sign) });
  const path = guestPagePath(kindPath, guest, (p) => rt.host.exists(p));
  if (!(await rt.host.writes.createText(path, html))) throw new Error(`${path} is there already`);
  const all = (rt.store.writers ??= {});
  all[`${kindPath}\n${writer}`] = { name: guest, state: "accepted", at: Date.now(), guest: true };
  await rt.saveSettings();
  return { path, code: guestCode(key, sign), members };
}
