import { Notice, PluginSettingTab, Setting, normalizePath, type App } from "obsidian";
import { when } from "./activity-view.ts";
import { SEEN_EVERY_MS, otherRunners, saveDevice, type Seen } from "./device.ts";
import { pluginFile, pluginFolder } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { openMap } from "./map-view.ts";

/** What every device last said about itself, from the plugin's `devices` folder. */
export async function devicesSeen(plugin: GizmoPlugin): Promise<Seen[]> {
  return (await pluginFolder(plugin, "devices")).flatMap(({ text }) => {
    try {
      const s = JSON.parse(text) as Seen;
      return typeof s.id === "string" && typeof s.name === "string" ? [s] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Each device says, in a file of its own, its name, whether it runs background work and when it
 * was last open, at most every half hour unless that changed. A device that runs background work
 * warns once a session when another one says it does too.
 */
export class DeviceBeat {
  private plugin: GizmoPlugin;
  private said = "";
  private saidAt = 0;
  private warned = false;

  constructor(plugin: GizmoPlugin) {
    this.plugin = plugin;
  }

  async beat(force = false): Promise<void> {
    const d = this.plugin.device;
    const now = Date.now();
    const state = JSON.stringify([d.name, d.background]);
    if (force || state !== this.said || now - this.saidAt >= SEEN_EVERY_MS) {
      const seen: Seen = { id: d.id, name: d.name, background: d.background, seen: now };
      await pluginFile(this.plugin, `devices/${d.id}.json`).write(JSON.stringify(seen)).catch(() => {});
      this.said = state;
      this.saidAt = now;
    }
    if (!d.background || this.warned) return;
    const others = otherRunners(await devicesSeen(this.plugin), d.id, now);
    if (!others.length) return;
    this.warned = true;
    new Notice(`Background work also runs on ${others.map((o) => o.name).join(", ")}: an alert's then or a record may run on each. Turn it off on one of them in Settings → Gizmo.`, 15_000);
  }
}

/** The log kept before Gizmo told devices apart becomes this device's own, unless another device already keeps one. */
export async function adoptOldLog(plugin: GizmoPlugin): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  const dir = plugin.manifest.dir ?? "";
  const old = normalizePath(`${dir}/activity.json`);
  const mine = normalizePath(`${dir}/activity/${plugin.device.id}.json`);
  if (!(await adapter.exists(old)) || (await adapter.exists(mine))) return;
  if ((await pluginFolder(plugin, "activity")).length) return;
  if (!(await adapter.exists(normalizePath(`${dir}/activity`)))) await adapter.mkdir(normalizePath(`${dir}/activity`));
  await adapter.rename(old, mine);
}

/** The other devices' logs (and an old shared one no device took), each named for its device. */
export async function otherLogs(plugin: GizmoPlugin): Promise<{ device: string; text: string }[]> {
  const names = new Map((await devicesSeen(plugin)).map((s) => [s.id, s.name]));
  const logs = (await pluginFolder(plugin, "activity")).filter((l) => l.name !== plugin.device.id).map((l) => ({ device: names.get(l.name) ?? "another device", text: l.text }));
  const old = await pluginFile(plugin, "activity.json").read().catch(() => undefined);
  return old ? [...logs, { device: "another device", text: old }] : logs;
}

export class GizmoSettings extends PluginSettingTab {
  private plugin: GizmoPlugin;

  constructor(app: App, plugin: GizmoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const plugin = this.plugin;
    const device = plugin.device;
    new Setting(el).setName("This device").setHeading();
    new Setting(el)
      .setName("Name")
      .setDesc("What other devices call this one, and the name of its own data notes in apps with devices: split.")
      .addText((t) => t.setValue(device.name).onChange((value) => {
        if (!value.trim()) return;
        device.name = value.trim();
        saveDevice(plugin.deviceStore, device);
        void plugin.beat?.beat(true);
      }));
    new Setting(el)
      .setName("Run background work on this device")
      .setDesc("Records, and the thens alerts run, while Obsidian is open here. Keep it on for one device that's open often; shortcuts, links, pins and alert notices work on every device either way.")
      .addToggle((t) => t.setValue(device.background).onChange((on) => {
        device.background = on;
        saveDevice(plugin.deviceStore, device);
        if (on) plugin.background?.startOver();
        void plugin.beat?.beat(true);
        new Notice(on ? "Background work runs on this device from now" : "Background work no longer runs on this device");
      }));
    const others = el.createDiv();
    void devicesSeen(plugin).then((seen) => {
      const list = seen.filter((s) => s.id !== device.id).sort((a, b) => b.seen - a.seen);
      if (!list.length) return;
      new Setting(others).setName("Other devices").setHeading();
      const now = new Date();
      for (const s of list) {
        new Setting(others).setName(s.name).setDesc(`${s.background ? "Runs background work" : "Doesn't run background work"} · last open ${when(s.seen, now)}`);
      }
    });
    new Setting(el).setName("Apps").setHeading();
    new Setting(el)
      .setName("Automation map")
      .setDesc("Every app in this vault: what it may do, what makes it act, and Revoke.")
      .addButton((b) => b.setButtonText("Open").onClick(() => void openMap(plugin)));
  }
}
