import { Modal, Notice, type TFile } from "obsidian";
import { copyText } from "./clipboard.ts";
import { JOIN_TITLE, drawGuest, drawInvite, drawJoin, drawPasteInvite, guestTitle, inviteTitle, type SharePaneHost, type ShareWords } from "./invite-pane.ts";
import type GizmoPlugin from "./main.ts";
import { sharedKindOf } from "./share-setup.ts";

/** What Obsidian's windows say of where secrets are kept and what opens an invite. */
const WORDS: ShareWords = { secretsPlace: "Settings → Keychain", opensIn: "Obsidian" };

/** A window around one of the sharing panes (see invite-pane.ts). */
class SharePaneModal extends Modal {
  private heading: string;
  private draw: (el: HTMLElement, host: SharePaneHost) => void;

  constructor(plugin: GizmoPlugin, heading: string, draw: (el: HTMLElement, host: SharePaneHost) => void) {
    super(plugin.app);
    this.heading = heading;
    this.draw = draw;
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.draw(this.contentEl, {
      copy: (text, done) => copyText(text, done),
      notify: (message) => new Notice(message),
      close: () => this.close(),
      words: WORDS,
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Opens what an invite link or its text would make, writing nothing until Join. */
export function openInvite(plugin: GizmoPlugin, text: string): void {
  new SharePaneModal(plugin, JOIN_TITLE, (el, host) => drawJoin(el, plugin.runtime, text, {
    ...host,
    joined: (path) => void plugin.app.workspace.openLinkText(path, "", false),
  })).open();
}

/** "Invite to a kind" and "Make a guest page", on a shared kind's note; "Join a shared kind from an invite". */
export function registerInviteCommands(plugin: GizmoPlugin): void {
  const onSharedKind = (checking: boolean, open: (file: TFile) => void) => {
    const file = plugin.app.workspace.getActiveFile();
    if (!file || !sharedKindOf(plugin.runtime, file.path)) return false;
    if (!checking) open(file);
    return true;
  };
  plugin.addCommand({
    id: "invite-kind",
    name: "Invite to a kind",
    checkCallback: (checking) => onSharedKind(checking, (file) => new SharePaneModal(plugin, inviteTitle(file.path), (el, host) => void drawInvite(el, plugin.runtime, file.path, host)).open()),
  });
  plugin.addCommand({
    id: "guest-page",
    name: "Make a guest page",
    checkCallback: (checking) => onSharedKind(checking, (file) => new SharePaneModal(plugin, guestTitle(file.path), (el, host) => drawGuest(el, plugin.runtime, file.path, host)).open()),
  });
  plugin.addCommand({
    id: "join-kind",
    name: "Join a shared kind from an invite",
    callback: () => new SharePaneModal(plugin, JOIN_TITLE, (el, host) => drawPasteInvite(el, plugin.runtime, (text) => {
      host.close();
      openInvite(plugin, text);
    })).open(),
  });
}
