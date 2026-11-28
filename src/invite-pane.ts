/**
 * Invite to a kind, Join a shared kind and Make a guest page as panes any host draws into its own
 * window (see share-setup.ts for what each does): Obsidian's modals and the standalone app's
 * windows wrap these. Where a host keeps secrets and what opens an invite are the host's words.
 */
import { secretVar } from "./datalayer.ts";
import { names } from "./guest-page.ts";
import { handler } from "./handler.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { readInvite, type Invite } from "./share.ts";
import { identityText, type Identity } from "./share-crypto.ts";
import { inviteLinkOf, join, joinPlan, keepKey, keyNeeded, makeGuestPage, makeKey, sharedKindOf } from "./share-setup.ts";
import type { KindSpec } from "./spec.ts";
import { basename } from "./store.ts";

export interface ShareWords {
  /** Where this host's secrets are cleared: "Settings → Keychain". */
  secretsPlace: string;
  /** What opening an invite link opens: "Obsidian". */
  opensIn: string;
}

export interface SharePaneHost {
  copy(text: string, done: () => void): void;
  notify(message: string): void;
  close(): void;
  words: ShareWords;
}

export const inviteTitle = (path: string): string => `Invite to ${basename(path)}`;
export const guestTitle = (path: string): string => `A guest page for ${basename(path)}`;
export const JOIN_TITLE = "Join a shared kind";

const notShared = (path: string) => `${basename(path)} isn't a shared kind: give it share: {relay: …, key: {secret: …}}`;

/**
 * This device has no key for the kind. When the kind is shared already (from another of this
 * vault's devices, or joined), only the key the others use will do: it is pasted here. Otherwise
 * Gizmo asks for the name this vault writes under, then makes the kind's key and keeps it as its
 * secret. A secret that holds anything is never replaced.
 */
export async function drawMakeKey(el: HTMLElement, rt: GizmoRuntime, path: string, kind: KindSpec, words: ShareWords, done: (id: Identity) => void): Promise<void> {
  const share = kind.share!;
  const name = basename(path);
  const taken = `The secret ${share.secret} holds something that isn't a key for sharing. Gizmo won't replace it: give share another secret in key, or clear it in ${words.secretsPlace}.`;
  const needed = await keyNeeded(rt, path, kind);
  if (needed === "taken") return void el.createEl("p", { cls: "gz-error-text", text: taken });
  const { elsewhere } = needed;
  const said = el.createDiv({ cls: "gz-error-text" });
  if (elsewhere) {
    el.createEl("p", { text: `${name} is shared already, and its key isn't on this device. On the device that has it, run Invite to a kind in ${name}, select Copy key, and paste the key here. A new key would start a share of its own, which the others can't read.` });
  } else {
    el.createEl("p", { text: `${name} has no key yet. Gizmo makes one and keeps it on this device as your secret ${share.secret}, never in a note.` });
    el.createEl("label", { text: "Your name, as the people you share it with see it", attr: { for: "gz-share-name" } });
    const input = el.createEl("input", { type: "text", value: rt.device.name, attr: { id: "gz-share-name", maxlength: "40" } });
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { cls: "mod-cta", text: "Make a key" }).addEventListener("click", handler(async () => {
      const typed = input.value.trim();
      if (!typed) return void input.focus();
      const made = await makeKey(rt, share.secret, typed);
      if ("error" in made) return void said.setText(taken);
      done(made.id);
    }));
    el.createEl("p", { cls: "gz-muted", text: `If another of your devices shares ${name} already, paste its key instead (Invite to a kind there, then Copy key).` });
  }
  const area = el.createEl("textarea", { cls: "gz-share-text", attr: { rows: "3", spellcheck: "false", placeholder: "gzk1.…", "aria-label": "The kind's key" } });
  el.appendChild(said);
  const keep = el.createDiv({ cls: "modal-button-container" });
  keep.createEl("button", { cls: elsewhere ? "mod-cta" : "", text: "Keep this key" }).addEventListener("click", () => {
    const kept = keepKey(rt, share.secret, area.value);
    if ("error" in kept) return void said.setText(kept.error === "taken" ? taken : "That isn't a key for sharing; copy it again with Copy key in Invite to a kind on the device that has it.");
    done(kept.id);
  });
}

/** "Invite to a kind": the link that lets someone share this kind, made once the kind has a key. */
export async function drawInvite(parent: HTMLElement, rt: GizmoRuntime, path: string, host: SharePaneHost): Promise<void> {
  parent.empty();
  const box = parent.createDiv({ cls: "gizmo gz-share gz-invite" });
  const name = basename(path);
  const found = sharedKindOf(rt, path);
  if (!found) return void box.createEl("p", { cls: "gz-error-text", text: notShared(path) });
  const { fm, kind, id } = found;
  if (!id) return drawMakeKey(box, rt, path, kind, host.words, () => void drawInvite(parent, rt, path, host));
  const link = await inviteLinkOf(fm, name, id, rt.host.linkBase);
  box.createEl("p", { text: `Send this link to the person you share ${name} with. Opening it in ${host.words.opensIn} shows them the kind it makes before anything changes.` });
  box.createEl("p", { cls: "gz-warning-text", text: `The key is in the link: whoever has it can read and add rows of ${name}. Send it in a private message, not where others can see it. Gizmo never sends the key to ${kind.share!.host} or anywhere else.` });
  const area = box.createEl("textarea", { cls: "gz-share-text", attr: { readonly: "", rows: "4", spellcheck: "false" } });
  area.value = link;
  box.createEl("p", { cls: "gz-muted", text: `You're ${id.name} to them. Their rows wait in Next until you accept them. Copy key copies your key for another of your devices (paste it in Invite to a kind there) or for gizmod (node gizmod.mjs secret set ${kind.share!.secret}, or set ${secretVar(kind.share!.secret)} to it).` });
  const row = box.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { text: "Copy key" }).addEventListener("click", () => host.copy(identityText(id), () => host.notify("Copied your key; keep it as a secret, in 1Password or your .env of op:// references")));
  row.createEl("button", { cls: "mod-cta", text: "Copy link" }).addEventListener("click", () => host.copy(link, () => {
    host.notify(`Copied the invite to ${name}; send it privately`);
    host.close();
  }));
}

export interface JoinHost extends SharePaneHost {
  /** Opens the kind just joined. */
  joined(path: string): void;
  /** Reads again, just before joining, the secrets a host keeps elsewhere (the app's server), so a secret filled since the preview counts. */
  ready?(): Promise<void>;
}

/** An invite opened: what joining makes, then the kind's note, its key kept as a secret, on Join. */
export function drawJoin(parent: HTMLElement, rt: GizmoRuntime, text: string, host: JoinHost): void {
  const box = parent.createDiv({ cls: "gizmo gz-share gz-join" });
  const invite = readInvite(text);
  if ("error" in invite) return void box.createEl("p", { cls: "gz-error-text", text: invite.error.replace(/^./, (c) => c.toUpperCase()) });
  drawPlan(box, rt, invite, host);
}

function drawPlan(box: HTMLElement, rt: GizmoRuntime, invite: Invite, host: JoinHost): void {
  const plan = joinPlan(rt, invite);
  const { path, secret, kind, read, taken } = plan;
  const share = invite.fm.share as { relay: string; key: { secret: string } };
  box.createEl("h4", { text: invite.name });
  box.createEl("p", { text: `${invite.from} invites you to share ${invite.name} through ${kind?.share?.host ?? share.relay}.` });
  if (!kind) {
    box.createEl("p", { cls: "gz-error-text", text: `This invite's kind can't be read: ${read?.errors.join("; ") ?? "it isn't a kind"}` });
    return;
  }
  if (taken) box.createEl("p", { cls: "gz-error-text", text: `You already have a note called ${invite.name}; rename or move it to join.` });
  else box.createEl("p", { text: `Creates ${path}: a kind whose rows have ${Object.keys(kind.fields).join(", ")}.` });
  box.createEl("p", { text: `Keeps the kind's key on this device as your secret ${secret}; it never goes in a note. Rows from ${invite.from} come in logged; rows from anyone else wait until you accept them.` });
  box.createEl("label", { text: "Your name, as the others see it", attr: { for: "gz-join-name" } });
  const input = box.createEl("input", { type: "text", value: rt.device.name, attr: { id: "gz-join-name", maxlength: "40" } });
  box.createEl("p", { text: "When you open it, it will ask your OK to:" });
  const ul = box.createEl("ul");
  for (const a of plan.asks) ul.createEl("li", { text: a });
  const row = box.createDiv({ cls: "modal-button-container" });
  const button = row.createEl("button", { cls: "mod-cta", text: "Join" });
  button.disabled = taken;
  button.addEventListener("click", handler(async () => {
    const name = input.value.trim();
    if (!name) return void input.focus();
    await host.ready?.();
    const joined = await join(rt, plan, name);
    if ("error" in joined) return void host.notify(joined.error);
    host.close();
    host.joined(joined.path);
  }));
}

/** For an invite that came as text, not as a link: paste it, then see what joining makes. */
export function drawPasteInvite(parent: HTMLElement, rt: GizmoRuntime, preview: (text: string) => void): void {
  const box = parent.createDiv({ cls: "gizmo gz-share" });
  box.createEl("p", { text: "Paste the invite link someone sent you." });
  const area = box.createEl("textarea", { cls: "gz-share-text", attr: { rows: "4", spellcheck: "false", placeholder: `${rt.host.linkBase ?? "obsidian://gizmo"}?invite=…` } });
  const row = box.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { cls: "mod-cta", text: "Preview" }).addEventListener("click", () => preview(area.value));
  window.setTimeout(() => area.focus(), 0);
}

/** "Make a guest page": one HTML file with the kind's form, and the code that lets one guest add rows with it. */
export function drawGuest(parent: HTMLElement, rt: GizmoRuntime, path: string, host: SharePaneHost & { made?(page: string): void }): void {
  parent.empty();
  const box = parent.createDiv({ cls: "gizmo gz-share gz-guest" });
  const name = basename(path);
  const found = sharedKindOf(rt, path);
  if (!found) return void box.createEl("p", { cls: "gz-error-text", text: notShared(path) });
  const { fm, kind, id } = found;
  if (!id) return void drawMakeKey(box, rt, path, kind, host.words, () => drawGuest(parent, rt, path, host));
  box.createEl("p", { text: `A guest page lets someone without Gizmo, a carer or a sitter, add rows to ${name} from their phone. It can only add: it can't read your rows, and you can end it on the automation map.` });
  box.createEl("label", { text: "Who is it for?", attr: { for: "gz-guest-name" } });
  const input = box.createEl("input", { type: "text", attr: { id: "gz-guest-name", placeholder: "Sitter", maxlength: "40" } });
  const row = box.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { cls: "mod-cta", text: "Make the page" }).addEventListener("click", handler(async () => {
    const guest = input.value.trim();
    if (!guest) return void input.focus();
    await guestMade(parent, rt, path, fm, kind, id, guest, host);
  }));
  window.setTimeout(() => input.focus(), 0);
}

async function guestMade(parent: HTMLElement, rt: GizmoRuntime, kindPath: string, fm: Record<string, unknown>, kind: KindSpec, id: Identity, guest: string, host: SharePaneHost & { made?(page: string): void }): Promise<void> {
  const { path, code, members } = await makeGuestPage(rt, kindPath, fm, kind, id, guest);
  parent.empty();
  const box = parent.createDiv({ cls: "gizmo gz-share gz-guest" });
  box.createEl("p", { text: `Made ${path}. Rows from it go to ${names(members)}, and come in here logged.` });
  box.createEl("p", { text: `Give ${guest} the page and this code. Put the file on any https web host, or send the file itself; they open it and paste the code, or open its address with #code at the end.` });
  const area = box.createEl("textarea", { cls: "gz-share-text", attr: { readonly: "", rows: "4", spellcheck: "false" } });
  area.value = code;
  box.createEl("p", { cls: "gz-warning-text", text: `Whoever has the code can add rows as ${guest}; it can't read any. To end it, remove ${guest} under Shared kinds on the automation map: rows already here stay.` });
  const row = box.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { cls: "mod-cta", text: "Copy code" }).addEventListener("click", () => host.copy(code, () => host.notify(`Copied ${guest}'s code; send it privately`)));
  host.made?.(path);
}
