import { Notice, Platform, type WorkspaceLeaf } from "obsidian";
import { actionDepsOf } from "./actions.ts";
import { Background, TICK_MS, type StatusItem } from "./background.ts";
import { obsidianAppEnv, pluginFile, pluginFolder, vaultFrontmatter, vaultNotes } from "./host.ts";
import { openMap } from "./map-view.ts";
import { dropKeys } from "./identity.ts";
import type GizmoPlugin from "./main.ts";
import { openActivity } from "./activity-view.ts";
import { askToRun, askWhereTo } from "./link-command.ts";
import { DeviceBeat } from "./settings.ts";
import { openInstall } from "./share-command.ts";
import { isApp, notePath, storeTarget } from "./store.ts";

/**
 * Obsidian glue for the background service: it starts once the layout is ready, hears about app
 * notes from the metadata cache, ticks on one interval, and stops when the plugin unloads.
 */
export function registerBackground(plugin: GizmoPlugin): Background {
  const app = plugin.app;
  const frontmatter = vaultFrontmatter(app);
  // An env without a tab: actions never ask for the source view, the only thing a leaf is for.
  const envFor = (path: string) => {
    const file = app.vault.getFileByPath(path);
    return file ? obsidianAppEnv(plugin, undefined as unknown as WorkspaceLeaf, file) : undefined;
  };
  const openApp = (path: string) => void app.workspace.openLinkText(path, "", false);
  /** Command id (without the plugin's prefix) → name, as registered. */
  const commands = new Map<string, string>();
  const bar: HTMLElement[] = [];
  let pausedItem: HTMLElement | undefined;
  let shown: StatusItem[] = [];
  let stopped = false;

  const bg: Background = new Background({
    data: plugin.dataLayer,
    frontmatter,
    notes: vaultNotes(app),
    appPaths: () => app.vault.getMarkdownFiles().filter((f) => isApp(frontmatter(f.path))).map((f) => f.path),
    isGranted: (path, wanted, asked) => plugin.isGranted(path, wanted, true, asked),
    granted: (path) => plugin.granted(path),
    policy: () => plugin.store.policy,
    storePath: (store, from) => envFor(from)?.storePath(store, from) ?? notePath(storeTarget(store)),
    actionDeps(appPath, dataPath, actor) {
      const env = envFor(appPath);
      if (!env) throw new Error(`can't find ${appPath}`);
      return {
        ...actionDepsOf(env, appPath, dataPath),
        // The run has already written; a log that can't be kept doesn't make it fail.
        log: actor ? (what, changes) => plugin.activity.add({ app: appPath, actor, what, changes }).then((e) => e?.id, () => undefined) : undefined,
      };
    },
    now: () => new Date(),
    // What alerts already ran for is this device's own: only the device running them writes it.
    triggers: pluginFile(plugin, `triggers/${plugin.device.id}.json`),
    renamed: (from, to) => void plugin.activity.rename(from, to),
    dropped: (path) => { if (dropKeys(plugin.store, path)) void plugin.saveSettings(); },
    otherTriggers: async () => (await pluginFolder(plugin, "triggers")).filter((f) => f.name !== plugin.device.id).map((f) => f.text),
    linkKey: (path, shortcut, create) => plugin.linkKey(path, shortcut, create),
    captureKey: (key) => (plugin.store.captureKeys && Object.hasOwn(plugin.store.captureKeys, key) ? plugin.store.captureKeys[key] : undefined),
    destinations: (path, shortcut) => plugin.store.answerTo?.[`${path}#${shortcut}`] ?? [],
    allowDestination(path, shortcut, to) {
      const id = `${path}#${shortcut}`;
      const all = (plugin.store.answerTo ??= {});
      all[id] = [...new Set([...(all[id] ?? []), to])];
      void plugin.saveSettings();
    },
    logSent: (entry) => void plugin.activity.add(entry),
    runsBackground: () => plugin.beat?.isRunner() ?? false,
    // gizmod on this computer tells of alerts itself; Obsidian beside it would tell twice.
    quietAlerts: () => plugin.beat?.gizmodHere() ?? false,
    sink: {
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
          plugin.addCommand({ id, name, callback: () => void bg.runCommand(id) });
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
          el.addEventListener("click", () => { if (shown[i]) openApp(shown[i].appPath); });
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
      openApp,
      confirm: (title, lines, effects) => askToRun(app, title, lines, effects),
      choose: (title, lines, choices) => askWhereTo(app, title, lines, choices),
      openUrl: (url) => { window.open(url); },
    },
  });

  plugin.registerEvent(app.metadataCache.on("changed", (file) => bg.noteChanged(file.path)));
  plugin.registerEvent(app.vault.on("rename", (file) => bg.noteChanged(file.path)));
  // A link may open Obsidian; it's answered once the apps are known. An install link only opens
  // the install window, which writes nothing until the person says so.
  plugin.registerObsidianProtocolHandler("gizmo", (params) => {
    app.workspace.onLayoutReady(() => {
      if (typeof params.install === "string") return openInstall(plugin, params.install);
      // A capture line's receipt: opening the activity log changes nothing, whoever sent it.
      if (typeof params.activity === "string") return openActivity(plugin, undefined, params.activity);
      // A link naming no app but carrying a line is a capture line; one naming an app fills its form, even a field called line.
      if (typeof params.line === "string" && params.app === undefined) return void bg.runCaptureLink({ ...params });
      void bg.runUri({ ...params });
    });
  });
  const beat = new DeviceBeat(plugin);
  plugin.beat = beat;
  app.workspace.onLayoutReady(() => {
    if (stopped) return;
    void beat.beat().catch(() => {}).finally(() => {
      if (!stopped) void bg.start();
    });
    plugin.registerInterval(window.setInterval(() => {
      void bg.tick();
      void beat.beat();
    }, TICK_MS));
  });
  plugin.register(() => {
    stopped = true;
    bg.stop();
    for (const el of bar.splice(0)) el.remove();
    pausedItem?.remove();
  });
  return bg;
}
