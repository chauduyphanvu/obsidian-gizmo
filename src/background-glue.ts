import { Notice, Platform } from "obsidian";
import type { BackgroundSink, StatusItem } from "./background.ts";
import { PRIORITY, type Device } from "./device.ts";
import { openMap } from "./map-view.ts";
import type GizmoPlugin from "./main.ts";
import { openActivity } from "./activity-view.ts";
import { askToRun, askWhereTo } from "./link-command.ts";
import { routeLink } from "./link-route.ts";
import type { RuntimeHost } from "./runtime.ts";
import { openInstall } from "./share-command.ts";
import { openInvite } from "./invite-command.ts";
import { openNext } from "./next-command.ts";
import { localZone } from "./time.ts";

const openApp = (plugin: GizmoPlugin, path: string) => void plugin.app.workspace.openLinkText(path, "", false);

/**
 * What the background tells and shows in Obsidian: notices, a command per app shortcut, the status
 * bar (none on mobile) and the Run windows. Its status items go when the plugin unloads.
 */
export function obsidianSink(plugin: GizmoPlugin): BackgroundSink {
  /** Command id (without the plugin's prefix) → name, as registered. */
  const commands = new Map<string, string>();
  const bar: HTMLElement[] = [];
  let pausedItem: HTMLElement | undefined;
  let shown: StatusItem[] = [];
  plugin.register(() => {
    for (const el of bar.splice(0)) el.remove();
    pausedItem?.remove();
  });
  return {
    notify: (message) => { new Notice(message); },
    // Commands come and go with the apps that declare them; a hotkey stays bound to the id.
    setCommands(list) {
      const next = new Map(list.map((c) => [c.id, c.name]));
      for (const [id, name] of commands) {
        if (next.get(id) === name) continue;
        plugin.removeCommand(id);
        commands.delete(id);
      }
      for (const [id, name] of next) {
        if (commands.has(id)) continue;
        plugin.addCommand({ id, name, callback: () => void plugin.runtime.background.runCommand(id) });
        commands.set(id, name);
      }
    },
    // One item per pinned panel, reused in place; Obsidian has no status bar on mobile.
    setStatus(items) {
      if (Platform.isMobile) return;
      while (bar.length < items.length) {
        const el = plugin.addStatusBarItem();
        el.addClass("gz-status", "mod-clickable");
        const i = bar.length;
        el.addEventListener("click", () => { if (shown[i]) openApp(plugin, shown[i].appPath); });
        bar.push(el);
      }
      while (bar.length > items.length) bar.pop()!.remove();
      shown = items;
      items.forEach((item, i) => {
        bar[i].setText(item.text);
        bar[i].setAttr("aria-label", `Open ${item.title}`);
      });
    },
    // One item saying how many apps are paused, opening the automation map, which says why.
    setPaused(apps) {
      if (Platform.isMobile) return;
      if (!apps.length) {
        pausedItem?.remove();
        pausedItem = undefined;
        return;
      }
      if (!pausedItem) {
        pausedItem = plugin.addStatusBarItem();
        pausedItem.addClass("gz-status", "gz-status-paused", "mod-clickable");
        pausedItem.addEventListener("click", () => void openMap(plugin));
      }
      pausedItem.setText(`Gizmo: ${apps.length} paused`);
      pausedItem.setAttr("aria-label", apps.map((a) => `${a.name}: it ${a.reason}`).join("\n"));
    },
    openApp: (path) => openApp(plugin, path),
    confirm: (title, lines, effects) => askToRun(plugin.app, title, lines, effects),
    choose: (title, lines, choices) => askWhereTo(plugin.app, title, lines, choices),
    openUrl: (url) => { window.open(url); },
  };
}

/**
 * Obsidian around the background service: it starts once the layout is ready, a status item says
 * how many asks wait, and `obsidian://gizmo` links are answered once the apps are known.
 */
export function registerBackground(plugin: GizmoPlugin): void {
  const app = plugin.app;
  const bg = plugin.runtime.background;
  let asksItem: HTMLElement | undefined;

  // How many asks wait, opening Next; nothing when none does. Obsidian has no status bar on mobile.
  bg.asks.subscribe(() => {
    if (Platform.isMobile) return;
    const n = bg.asks.list().length;
    if (!n) {
      asksItem?.remove();
      asksItem = undefined;
      return;
    }
    if (!asksItem) {
      asksItem = plugin.addStatusBarItem();
      asksItem.addClass("gz-status", "gz-status-asks", "mod-clickable");
      asksItem.setAttr("aria-label", "Open Next");
      asksItem.addEventListener("click", () => openNext(plugin));
    }
    asksItem.setText(`${n} to do`);
  });

  // A link may open Obsidian; it's answered once the apps are known (see routeLink).
  plugin.registerObsidianProtocolHandler("gizmo", (params) => {
    app.workspace.onLayoutReady(() => routeLink(params, {
      install: (link) => openInstall(plugin, link),
      invite: (text) => openInvite(plugin, text),
      activity: (entryId) => openActivity(plugin, undefined, entryId),
      capture: (p) => void bg.runCaptureLink(p),
      run: (p) => void bg.runUri(p),
    }));
  });
  app.workspace.onLayoutReady(() => void plugin.runtime.start());
  plugin.register(() => asksItem?.remove());
}

/** The computer Obsidian runs on, by name; empty where there's none to ask (a phone). */
function hostName(): string {
  try {
    const os = (window as unknown as { require?: (m: string) => { hostname(): string } }).require?.("os");
    return os?.hostname() ?? "";
  } catch {
    return "";
  }
}

/**
 * What this device says in its beat (see Heartbeat): a new name or zone at once, and with each beat
 * when the person last touched Obsidian here, so a phone opened abroad moves deadlines there.
 */
export function obsidianBeat(plugin: GizmoPlugin, device: Device): RuntimeHost["beat"] {
  const used = { at: Date.now() };
  const touched = () => { used.at = Date.now(); };
  plugin.registerDomEvent(activeDocument, "pointerdown", touched, { passive: true });
  plugin.registerDomEvent(activeDocument, "keydown", touched, { passive: true });
  return {
    // Read at every beat: a laptop renamed, or moved to another network, says so.
    mine: (now) => ({ id: device.id, name: device.name, host: hostName(), priority: Platform.isMobile ? PRIORITY.phone : PRIORITY.desktop, seen: now, zone: localZone(), used: used.at }),
    sayChanges: true,
  };
}
