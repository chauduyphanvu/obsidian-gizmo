import { PluginSettingTab, Setting, type App } from "obsidian";
import { when } from "./activity-view.ts";
import { PRIORITY, saveDevice } from "./device.ts";
import type GizmoPlugin from "./main.ts";
import { openMap } from "./map-view.ts";

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
      .setDesc("What other devices call this one.")
      .addText((t) => t.setValue(device.name).onChange((value) => {
        if (!value.trim()) return;
        device.name = value.trim();
        saveDevice(plugin.deviceStore, device);
        void plugin.beat?.beat(true);
      }));
    // One device runs records and alerts' thens: the one most suited to it that is open, chosen by every device alike.
    const beat = plugin.beat;
    const runner = beat?.runner;
    const runs = !runner || runner.id === device.id;
    new Setting(el)
      .setName("Background work")
      .setDesc(runs
        ? "Runs on this device: records, and the thens alerts run. Shortcuts, links, pins and alert notices work on every device."
        : `Runs on ${runner.name}${runner.priority === PRIORITY.gizmod ? " (gizmod)" : ""}, last heard from ${when(runner.seen, new Date())}. This device takes it over if that one isn't heard from for 20 minutes.`);
    const others = el.createDiv();
    const list = (beat?.beats ?? []).filter((s) => s.id !== device.id).sort((a, b) => b.seen - a.seen);
    if (list.length) {
      new Setting(others).setName("Other devices").setHeading();
      const now = new Date();
      for (const s of list) new Setting(others).setName(s.name).setDesc(`${s.id === runner?.id ? "Runs background work" : "Doesn't run background work"} · last open ${when(s.seen, now)}`);
    }
    new Setting(el).setName("Apps").setHeading();
    new Setting(el)
      .setName("Automation map")
      .setDesc("Every app in this vault: what it may do, what makes it act, and Revoke.")
      .addButton((b) => b.setButtonText("Open").onClick(() => void openMap(plugin)));
  }
}
