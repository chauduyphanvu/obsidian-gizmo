import { Modal, Notice, normalizePath, stringifyYaml, type TFile } from "obsidian";
import { names, guestCheck, guestCode, guestPageHtml } from "./guest-page.ts";
import { handler } from "./handler.ts";
import { copyText, pluginFiles, vaultNotes } from "./host.ts";
import { readFields } from "./keys.ts";
import type GizmoPlugin from "./main.ts";
import { describePermission, permissionsOf } from "./permissions.ts";
import { inviteKeys, inviteLink, readInvite, type Invite } from "./share.ts";
import { guestKeyBytes, identityText, newIdentity, newSigningKey, readIdentity, topicOf, writerOf, type Identity } from "./share-crypto.ts";
import { readSpec, type KindSpec } from "./spec.ts";
import { sharedAlready } from "./background-share.ts";
import { otherShareStates } from "./device.ts";
import { defaultDataPath } from "./store.ts";
import { writersOf } from "./stored.ts";

/** A shared kind's note, its keys as read, and the key its secret holds, if any. */
function sharedKind(plugin: GizmoPlugin, file: TFile): { fm: Record<string, unknown>; kind: KindSpec; id?: Identity } | undefined {
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const kind = fm && readSpec(fm, { notes: vaultNotes(plugin.app), path: file.path })?.spec?.kind;
  if (!fm || !kind?.share) return undefined;
  return { fm, kind, id: readIdentity(plugin.app.secretStorage.getSecret(kind.share.secret)) };
}

/**
 * This device has no key for the kind. When the kind is shared already (from another of this
 * vault's devices, or joined), only the key the others use will do: it is pasted here. Otherwise
 * Gizmo asks for the name this vault writes under, then makes the kind's key and keeps it as its
 * secret. A secret that holds anything is never replaced.
 */
async function drawMakeKey(plugin: GizmoPlugin, el: HTMLElement, file: TFile, kind: KindSpec, done: (id: Identity) => void): Promise<void> {
  const share = kind.share!;
  const secrets = plugin.app.secretStorage;
  const taken = `The secret ${share.secret} holds something that isn't a key for sharing. Gizmo won't replace it: give share another secret in key, or clear it in Settings → Keychain.`;
  if (secrets.getSecret(share.secret) !== null) return void el.createEl("p", { cls: "gz-error-text", text: taken });
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const rows = (await plugin.dataLayer.ledger?.state(defaultDataPath(file.path), fm))?.lists.get(kind.name)?.rows ?? [];
  const elsewhere = sharedAlready(file.path, rows, writersOf(plugin.store, file.path), await otherShareStates(pluginFiles(plugin), plugin.device.id));
  const said = el.createDiv({ cls: "gz-error-text" });
  if (elsewhere) {
    el.createEl("p", { text: `${file.basename} is shared already, and its key isn't on this device. On the device that has it, run Invite to a kind in ${file.basename}, select Copy key, and paste the key here. A new key would start a share of its own, which the others can't read.` });
  } else {
    el.createEl("p", { text: `${file.basename} has no key yet. Gizmo makes one and keeps it on this device as your secret ${share.secret}, never in a note.` });
    el.createEl("label", { text: "Your name, as the people you share it with see it", attr: { for: "gz-share-name" } });
    const input = el.createEl("input", { type: "text", value: plugin.device.name, attr: { id: "gz-share-name", maxlength: "40" } });
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { cls: "mod-cta", text: "Make a key" }).addEventListener("click", handler(async () => {
      const name = input.value.trim();
      if (!name) return void input.focus();
      if (secrets.getSecret(share.secret) !== null) return void said.setText(taken);
      const id = await newIdentity(name);
      secrets.setSecret(share.secret, identityText(id));
      done(id);
    }));
    el.createEl("p", { cls: "gz-muted", text: `If another of your devices shares ${file.basename} already, paste its key instead (Invite to a kind there, then Copy key).` });
  }
  const area = el.createEl("textarea", { cls: "gz-share-text", attr: { rows: "3", spellcheck: "false", placeholder: "gzk1.…", "aria-label": "The kind's key" } });
  el.appendChild(said);
  const keep = el.createDiv({ cls: "modal-button-container" });
  keep.createEl("button", { cls: elsewhere ? "mod-cta" : "", text: "Keep this key" }).addEventListener("click", () => {
    const id = readIdentity(area.value);
    if (!id) return void said.setText("That isn't a key for sharing; copy it again with Copy key in Invite to a kind on the device that has it.");
    if (secrets.getSecret(share.secret) !== null) return void said.setText(taken);
    secrets.setSecret(share.secret, identityText(id));
    done(id);
  });
}

/** "Invite to a kind": the link that lets someone share this kind, made once the kind has a key. */
class InviteModal extends Modal {
  private plugin: GizmoPlugin;
  private file: TFile;

  constructor(plugin: GizmoPlugin, file: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen(): void {
    this.titleEl.setText(`Invite to ${this.file.basename}`);
    void this.draw();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async draw(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    const box = el.createDiv({ cls: "gizmo gz-share gz-invite" });
    const found = sharedKind(this.plugin, this.file);
    if (!found) return void box.createEl("p", { cls: "gz-error-text", text: `${this.file.basename} isn't a shared kind: give it share: {relay: …, key: {secret: …}}` });
    const { fm, kind, id } = found;
    if (!id) return void drawMakeKey(this.plugin, box, this.file, kind, () => void this.draw());
    const link = inviteLink({ name: this.file.basename, fm: inviteKeys(fm), key: id.key, from: id.name, writer: await writerOf(id.sign) });
    box.createEl("p", { text: `Send this link to the person you share ${this.file.basename} with. Opening it in Obsidian shows them the kind it makes before anything changes.` });
    box.createEl("p", { cls: "gz-warning-text", text: `The key is in the link: whoever has it can read and add rows of ${this.file.basename}. Send it in a private message, not where others can see it. Gizmo never sends the key to ${kind.share!.host} or anywhere else.` });
    const area = box.createEl("textarea", { cls: "gz-share-text", attr: { readonly: "", rows: "4", spellcheck: "false" } });
    area.value = link;
    box.createEl("p", { cls: "gz-muted", text: `You're ${id.name} to them. Their rows wait in Next until you accept them. Copy key copies your key for another of your devices (paste it in Invite to a kind there) or for gizmod (set GIZMO_SECRET_${kind.share!.secret.toUpperCase().replace(/-/g, "_")} to it).` });
    const row = box.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Copy key" }).addEventListener("click", () => copyText(identityText(id), () => { new Notice("Copied your key; keep it as a secret, in 1Password or your .env of op:// references"); }));
    row.createEl("button", { cls: "mod-cta", text: "Copy link" }).addEventListener("click", () => copyText(link, () => { new Notice(`Copied the invite to ${this.file.basename}; send it privately`); this.close(); }));
  }
}

/** An invite opened: what joining makes, then the kind's note, its key kept as a secret, on Join. */
class JoinModal extends Modal {
  private plugin: GizmoPlugin;
  private text: string;

  constructor(plugin: GizmoPlugin, text: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.text = text;
  }

  onOpen(): void {
    this.titleEl.setText("Join a shared kind");
    const box = this.contentEl.createDiv({ cls: "gizmo gz-share gz-join" });
    const invite = readInvite(this.text);
    if ("error" in invite) return void box.createEl("p", { cls: "gz-error-text", text: invite.error.replace(/^./, (c) => c.toUpperCase()) });
    this.draw(box, invite);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private draw(box: HTMLElement, invite: Invite): void {
    const app = this.app;
    const parent = app.fileManager.getNewFileParent("").path;
    const folder = parent === "/" ? "" : parent;
    const path = normalizePath(folder ? `${folder}/${invite.name}.md` : `${invite.name}.md`);
    const share = invite.fm.share as { relay: string; key: { secret: string } };
    // The secret's id as the invite names it, or the next one free here.
    let secret = share.key.secret;
    for (let n = 2; app.secretStorage.getSecret(secret) !== null; n++) secret = `${share.key.secret}-${n}`;
    const fm = { ...invite.fm, share: { relay: share.relay, key: { secret } } };
    const read = readSpec(fm, { notes: vaultNotes(app), path });
    const kind = read?.spec?.kind;
    const taken = app.vault.getAbstractFileByPath(path) ?? app.metadataCache.getFirstLinkpathDest(invite.name, "");
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
    const input = box.createEl("input", { type: "text", value: this.plugin.device.name, attr: { id: "gz-join-name", maxlength: "40" } });
    const asks = permissionsOf(read.spec!, path).map(describePermission);
    box.createEl("p", { text: "When you open it, it will ask your OK to:" });
    const ul = box.createEl("ul");
    for (const a of asks) ul.createEl("li", { text: a });
    const row = box.createDiv({ cls: "modal-button-container" });
    const join = row.createEl("button", { cls: "mod-cta", text: "Join" });
    join.disabled = !!taken;
    join.addEventListener("click", handler(async () => {
      const name = input.value.trim();
      if (!name) return void input.focus();
      if (app.vault.getAbstractFileByPath(path)) return void new Notice(`You already have a note called ${invite.name}`);
      const body = `Shared with you by ${invite.from} through ${kind.share!.host}. Each row you add here goes to the people you share it with, sealed; theirs come in here.\n`;
      if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
      app.secretStorage.setSecret(secret, identityText(await newIdentity(name, invite.key)));
      await app.vault.create(path, `---\n${stringifyYaml(fm)}---\n${body}`);
      const writers = (this.plugin.store.writers ??= {});
      writers[`${path}\n${invite.writer}`] = { name: invite.from, state: "accepted", at: Date.now() };
      await this.plugin.saveSettings();
      this.close();
      await app.workspace.openLinkText(path, "", false);
    }));
  }
}

/** "Make a guest page": one HTML file with the kind's form, and the code that lets one guest add rows with it. */
class GuestModal extends Modal {
  private plugin: GizmoPlugin;
  private file: TFile;

  constructor(plugin: GizmoPlugin, file: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen(): void {
    this.titleEl.setText(`A guest page for ${this.file.basename}`);
    this.draw();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private draw(): void {
    const el = this.contentEl;
    el.empty();
    const box = el.createDiv({ cls: "gizmo gz-share gz-guest" });
    const found = sharedKind(this.plugin, this.file);
    if (!found) return void box.createEl("p", { cls: "gz-error-text", text: `${this.file.basename} isn't a shared kind: give it share: {relay: …, key: {secret: …}}` });
    const { fm, kind, id } = found;
    if (!id) return void drawMakeKey(this.plugin, box, this.file, kind, () => this.draw());
    box.createEl("p", { text: `A guest page lets someone without Gizmo, a carer or a sitter, add rows to ${this.file.basename} from their phone. It can only add: it can't read your rows, and you can end it on the automation map.` });
    box.createEl("label", { text: "Who is it for?", attr: { for: "gz-guest-name" } });
    const input = box.createEl("input", { type: "text", attr: { id: "gz-guest-name", placeholder: "Sitter", maxlength: "40" } });
    const row = box.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { cls: "mod-cta", text: "Make the page" }).addEventListener("click", handler(async () => {
      const guest = input.value.trim();
      if (!guest) return void input.focus();
      await this.make(fm, kind, id, guest);
    }));
    input.focus();
  }

  private async make(fm: Record<string, unknown>, kind: KindSpec, id: Identity, guest: string): Promise<void> {
    const app = this.app;
    const sign = await newSigningKey();
    const writer = await writerOf(sign);
    const key = await guestKeyBytes(id.key, writer);
    const decided = writersOf(this.plugin.store, this.file.path);
    const members = [id.name, ...Object.values(decided).filter((w) => w.state === "accepted" && !w.guest).map((w) => w.name)];
    const labels = Object.fromEntries(Object.entries(readFields(fm.fields as Record<string, unknown>).info).flatMap(([f, i]) => (i.label ? [[f, i.label]] : [])));
    const html = guestPageHtml({ kind: this.file.basename, fields: kind.fields, labels, relay: kind.share!.relay, topic: await topicOf(id.key), writer, guest, members, check: await guestCheck(key, sign) });
    const folder = this.file.parent?.path && this.file.parent.path !== "/" ? `${this.file.parent.path}/` : "";
    let path = normalizePath(`${folder}${this.file.basename} guest page (${guest.replace(/[\\/:*?"<>|#^[\]]/g, "-")}).html`);
    for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = path.replace(/( \d+)?\.html$/, ` ${n}.html`);
    await app.vault.create(path, html);
    const all = (this.plugin.store.writers ??= {});
    all[`${this.file.path}\n${writer}`] = { name: guest, state: "accepted", at: Date.now(), guest: true };
    await this.plugin.saveSettings();
    const code = guestCode(key, sign);
    const el = this.contentEl;
    el.empty();
    const box = el.createDiv({ cls: "gizmo gz-share gz-guest" });
    box.createEl("p", { text: `Made ${path}. Rows from it go to ${names(members)}, and come in here logged.` });
    box.createEl("p", { text: `Give ${guest} the page and this code. Put the file on any https web host, or send the file itself; they open it and paste the code, or open its address with #code at the end.` });
    const area = box.createEl("textarea", { cls: "gz-share-text", attr: { readonly: "", rows: "4", spellcheck: "false" } });
    area.value = code;
    box.createEl("p", { cls: "gz-warning-text", text: `Whoever has the code can add rows as ${guest}; it can't read any. To end it, remove ${guest} under Shared kinds on the automation map: rows already here stay.` });
    const row = box.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { cls: "mod-cta", text: "Copy code" }).addEventListener("click", () => copyText(code, () => { new Notice(`Copied ${guest}'s code; send it privately`); }));
  }
}

/** Opens what an invite link or its text would make, writing nothing until Join. */
export function openInvite(plugin: GizmoPlugin, text: string): void {
  new JoinModal(plugin, text).open();
}

/** "Invite to a kind" and "Make a guest page", on a shared kind's note. */
export function registerInviteCommands(plugin: GizmoPlugin): void {
  const onSharedKind = (checking: boolean, open: (file: TFile) => void) => {
    const file = plugin.app.workspace.getActiveFile();
    if (!file || !sharedKind(plugin, file)) return false;
    if (!checking) open(file);
    return true;
  };
  plugin.addCommand({ id: "invite-kind", name: "Invite to a kind", checkCallback: (checking) => onSharedKind(checking, (file) => new InviteModal(plugin, file).open()) });
  plugin.addCommand({ id: "guest-page", name: "Make a guest page", checkCallback: (checking) => onSharedKind(checking, (file) => new GuestModal(plugin, file).open()) });
  plugin.addCommand({ id: "join-kind", name: "Join a shared kind from an invite", callback: () => new PasteInviteModal(plugin).open() });
}

/** For an invite that came as text, not as a link: paste it, then see what joining makes. */
class PasteInviteModal extends Modal {
  private plugin: GizmoPlugin;

  constructor(plugin: GizmoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Join a shared kind");
    const box = this.contentEl.createDiv({ cls: "gizmo gz-share" });
    box.createEl("p", { text: "Paste the invite link someone sent you." });
    const area = box.createEl("textarea", { cls: "gz-share-text", attr: { rows: "4", spellcheck: "false", placeholder: "obsidian://gizmo?invite=…" } });
    const row = box.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { cls: "mod-cta", text: "Preview" }).addEventListener("click", () => {
      this.close();
      openInvite(this.plugin, area.value);
    });
    area.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
