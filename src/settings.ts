import { Platform, PluginSettingTab, Setting, normalizePath, type App } from "obsidian";
import { when } from "./activity-view.ts";
import { BEAT_EVERY_MS, PRIORITY, UNSEEN_MS, readBeat, runnerOf, saveDevice, startsOver, whereYouAre, type Beat } from "./device.ts";
import { localZone } from "./time.ts";
import { pluginFile, pluginFolder } from "./host.ts";
import type GizmoPlugin from "./main.ts";
import { openMap } from "./map-view.ts";

/** What every device last said about itself, from the plugin's `devices` folder. */
export async function devicesSeen(plugin: GizmoPlugin): Promise<Beat[]> {
  return (await pluginFolder(plugin, "devices")).flatMap(({ text }) => {
    const b = readBeat(text);
    return b ? [b] : [];
  });
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
 * Each device says, in a file of its own, that it is still there, every five minutes, and works out
 * from every device's word which one runs background work (see runnerOf). Becoming the one, it
 * starts over: alerts note what is true now rather than running for what changed while another ran.
 */
export class DeviceBeat {
  private plugin: GizmoPlugin;
  private saidAt = 0;
  private said = "";
  /** Every device's last word, as last read. */
  beats: Beat[] = [];
  runner: Beat | undefined;
  /** Whether this session has read every device's beat yet. */
  private heard = false;
  /** When the person last touched Obsidian here; said with each beat, so a phone opened abroad moves deadlines there. */
  private used = Date.now();
  private zoneSaid = "";

  constructor(plugin: GizmoPlugin) {
    this.plugin = plugin;
    const touched = () => { this.used = Date.now(); };
    plugin.registerDomEvent(document, "pointerdown", touched, { passive: true });
    plugin.registerDomEvent(document, "keydown", touched, { passive: true });
  }

  private mine(now: number): Beat {
    const d = this.plugin.device;
    // Read at every beat: a laptop renamed, or moved to another network, says so.
    return { id: d.id, name: d.name, host: hostName(), priority: Platform.isMobile ? PRIORITY.phone : PRIORITY.desktop, seen: now, zone: localZone(), used: this.used };
  }

  /** Says this device is leaving, as Obsidian quits, so another takes over background work now. */
  async leave(): Promise<void> {
    const me: Beat = { ...this.mine(Date.now()), left: true };
    await pluginFile(this.plugin, `devices/${me.id}.json`).write(JSON.stringify(me)).catch(() => {});
  }

  async beat(force = false): Promise<void> {
    const now = Date.now();
    const me = this.mine(now);
    // A folder a sync is rewriting is read next time: who runs stays as it was, and nothing starts over.
    const all = await devicesSeen(this.plugin).catch(() => undefined);
    if (!all) return;
    // This device's word from its last session, read before this one is written over it.
    const last = this.heard ? undefined : all.find((b) => b.id === me.id)?.seen;
    // A new zone (a phone landed abroad) is said at once.
    if (!this.heard || force || me.name !== this.said || me.zone !== this.zoneSaid || now - this.saidAt >= BEAT_EVERY_MS) {
      await pluginFile(this.plugin, `devices/${me.id}.json`).write(JSON.stringify(me)).catch(() => {});
      this.said = me.name;
      this.zoneSaid = me.zone ?? "";
      this.saidAt = now;
    }
    const others = all.filter((b) => b.id !== me.id);
    this.beats = [me, ...others];
    const was = this.runner?.id;
    this.runner = runnerOf(this.beats, now);
    if (startsOver(me.id, this.runner?.id, was, !this.heard, last, others)) this.plugin.background?.startOver();
    this.heard = true;
  }

  /** The zone a rhythm's deadline means: that of the phone or desktop used last. */
  whereYouAre(): string | undefined {
    return whereYouAre(this.beats);
  }

  /** Whether this device runs background work; not until it has read every device's beat. */
  isRunner(): boolean {
    return this.heard && this.runner?.id === this.plugin.device.id;
  }

  /** gizmod runs on this computer and was heard from lately: it tells of alerts, so Obsidian here doesn't as well. */
  gizmodHere(): boolean {
    const now = Date.now();
    const host = hostName();
    return !!host && this.beats.some((b) => b.priority === PRIORITY.gizmod && b.host === host && now - b.seen < UNSEEN_MS && !b.left);
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
