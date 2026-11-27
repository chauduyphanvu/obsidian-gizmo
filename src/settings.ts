import { PluginSettingTab, Setting, type App, type SettingDefinitionItem } from "obsidian";
import { saveDevice } from "./device.ts";
import type GizmoPlugin from "./main.ts";
import { openMap } from "./map-view.ts";
import { devicesNow } from "./settings-model.ts";

const NAME_DESC = "What other devices call this one.";
const MAP_DESC = "Every app in this vault: what it may do, what makes it act, and Revoke.";

export class GizmoSettings extends PluginSettingTab {
  private plugin: GizmoPlugin;

  constructor(app: App, plugin: GizmoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private devices(): ReturnType<typeof devicesNow> {
    return devicesNow(this.plugin.runtime, new Date());
  }

  private rename(value: string): void {
    const { plugin } = this;
    plugin.runtime.device.name = value.trim();
    saveDevice(plugin.deviceStore, plugin.runtime.device);
    void plugin.runtime.beat.beat(true);
  }

  /** The tab from Obsidian 1.13 on, where settings search finds it. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const { background, others } = this.devices();
    return [
      {
        type: "group",
        heading: "This device",
        items: [
          { name: "Name", desc: NAME_DESC, control: { type: "text", key: "name", validate: (v) => (v.trim() ? undefined : "A device needs a name") } },
          { name: "Background work", desc: background },
        ],
      },
      { type: "group", heading: "Other devices", visible: others.length > 0, items: others.map((o) => ({ ...o, searchable: false })) },
      {
        type: "group",
        heading: "Apps",
        items: [{ name: "Automation map", desc: MAP_DESC, action: () => void openMap(this.plugin) }],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return key === "name" ? this.plugin.runtime.device.name : undefined;
  }

  setControlValue(key: string, value: unknown): void {
    if (key === "name" && typeof value === "string" && value.trim()) this.rename(value);
  }

  /** The same tab before Obsidian 1.13, which draws it here. */
  display(): void {
    const el = this.containerEl;
    el.empty();
    const { background, others } = this.devices();
    new Setting(el).setName("This device").setHeading();
    new Setting(el)
      .setName("Name")
      .setDesc(NAME_DESC)
      .addText((t) => t.setValue(this.plugin.runtime.device.name).onChange((value) => {
        if (value.trim()) this.rename(value);
      }));
    new Setting(el).setName("Background work").setDesc(background);
    if (others.length) {
      new Setting(el).setName("Other devices").setHeading();
      for (const o of others) new Setting(el).setName(o.name).setDesc(o.desc);
    }
    new Setting(el).setName("Apps").setHeading();
    new Setting(el)
      .setName("Automation map")
      .setDesc(MAP_DESC)
      .addButton((b) => b.setButtonText("Open").onClick(() => void openMap(this.plugin)));
  }
}
