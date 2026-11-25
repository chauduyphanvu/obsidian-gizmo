import type { LogStore } from "./activity.ts";

/** This device as Gizmo knows it: kept on the device itself, never in a file a sync tool copies. */
export interface Device {
  id: string;
  name: string;
}

/**
 * What a device says about itself in the plugin's folder, every few minutes, so the devices can
 * agree which one runs background work: its name, the computer it runs on, how much it should be
 * the one (gizmod on an always-on Mac over Obsidian on a desktop over a phone), and when it said so.
 */
export interface Beat {
  id: string;
  name: string;
  /** The computer's name, so Obsidian can tell gizmod runs beside it. Empty on a phone. */
  host: string;
  priority: number;
  /** Milliseconds since 1970. */
  seen: number;
  /** The device's time zone (an IANA name), for deadlines that mean "where you are". */
  zone?: string;
  /** When the person last used it (ms); a phone or desktop only, never gizmod. */
  used?: number;
  /** Said as it quits: another device takes over at once rather than after UNSEEN_MS. */
  left?: true;
}

/** How much each kind of device should be the one running background work. */
export const PRIORITY = { phone: 0, desktop: 1, gizmod: 2 } as const;

/** How often a device says it is still there. */
export const BEAT_EVERY_MS = 5 * 60_000;
/** A device not heard from in this long isn't running anything. */
export const UNSEEN_MS = 20 * 60_000;

/**
 * The device that runs background work: of those heard from in the last 20 minutes and still there,
 * the one most suited to it, then the lowest id, so every device works out the same one from the
 * same beats. A runner that quit says so and is replaced at once; one that goes quiet, once it has
 * been unseen for 20 minutes.
 */
export function runnerOf(beats: readonly Beat[], now: number): Beat | undefined {
  return beats.filter((b) => live(b, now)).sort(ranked)[0];
}

const live = (b: Beat, now: number) => now - b.seen < UNSEEN_MS && !b.left;
/** Most suited to running background work first, then the lowest id. */
const ranked = (a: Beat, b: Beat) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Whether this device leaves telling of alerts to another program on the same computer: of the
 * devices there that were heard from lately, only the one most suited to background work tells
 * them (gizmod over Obsidian beside it), so the person isn't told twice. A device whose computer
 * has no name (a phone) is never quiet.
 */
export function quietHere(beats: readonly Beat[], me: Beat, now: number): boolean {
  if (!me.host) return false;
  const here = beats.filter((b) => b.id !== me.id && b.host === me.host && live(b, now));
  return here.some((b) => ranked(b, me) < 0);
}

/**
 * Whether this device, now the runner, starts its alerts over. Mid-session, when it takes over from
 * another device. On its first beat of a session, when another device was heard from long enough
 * after this one's last beat to have run background work meanwhile; else what it kept still holds.
 */
export function startsOver(me: string, runner: string | undefined, was: string | undefined, first: boolean, lastSeen: number | undefined, others: readonly Beat[]): boolean {
  if (runner !== me) return false;
  if (!first) return was !== undefined && was !== me;
  return lastSeen === undefined || others.some((b) => b.seen > lastSeen + UNSEEN_MS);
}

/** A beat from a file's text; undefined when it isn't one. */
export function readBeat(text: string): Beat | undefined {
  try {
    const b = JSON.parse(text) as Partial<Beat>;
    if (typeof b.id !== "string" || typeof b.name !== "string" || typeof b.seen !== "number") return undefined;
    // A beat from before devices agreed on one runner: that device decides for itself, and beats
    // too seldom to be counted as there, so it is left out.
    if (typeof b.priority !== "number") return undefined;
    return {
      id: b.id, name: b.name, host: typeof b.host === "string" ? b.host : "", priority: b.priority, seen: b.seen,
      ...(typeof b.zone === "string" && b.zone && { zone: b.zone }),
      ...(typeof b.used === "number" && { used: b.used }),
      ...(b.left === true && { left: true as const }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Where the person is, for a deadline that says "by 10:00": the zone of the device they used last
 * (one a person uses says when; gizmod never does), however long ago, since a phone abroad may not
 * have been heard from since. Undefined when no device says, and the runner's own clock decides.
 */
export function whereYouAre(beats: readonly Beat[]): string | undefined {
  let latest: Beat | undefined;
  for (const b of beats) if (b.used !== undefined && b.zone && (!latest || b.used > latest.used!)) latest = b;
  return latest?.zone;
}

/**
 * The folders in the plugin's folder where each device keeps a file of its own, which a sync never has
 * to merge: its beat, what its alerts ran for, and its activity log. It reads the other devices' files.
 */
export const DEVICE_FOLDERS = { beats: "devices", triggers: "triggers", activity: "activity", share: "share", definitions: "definitions" } as const;

/** A device's own file in one of DEVICE_FOLDERS. */
export function deviceFile(folder: string, id: string): string {
  return `${folder}/${id}.json`;
}

/** The plugin's folder, in Obsidian or on disk for gizmod: a file read and written whole, and the `.json` files of a folder. */
export interface PluginFiles {
  file(name: string): LogStore;
  /** The texts of a folder's `.json` files, by name without `.json`; none when there is no such folder. A file that can't be read is left out. */
  folder(name: string): Promise<{ name: string; text: string }[]>;
}

/** What every device last said about itself. */
export async function beatsIn(files: PluginFiles): Promise<Beat[]> {
  return (await files.folder(DEVICE_FOLDERS.beats)).flatMap(({ text }) => {
    const b = readBeat(text);
    return b ? [b] : [];
  });
}

/** The other devices' `triggers` files, as text: where their rhythms got to, for a device taking over. */
export async function otherTriggers(files: PluginFiles, id: string): Promise<string[]> {
  return (await files.folder(DEVICE_FOLDERS.triggers)).filter((f) => f.name !== id).map((f) => f.text);
}

/** The other devices' `share` files, as text: what they sent of shared kinds, for a device taking over. */
export async function otherShareStates(files: PluginFiles, id: string): Promise<string[]> {
  return (await files.folder(DEVICE_FOLDERS.share)).filter((f) => f.name !== id).map((f) => f.text);
}

/** The other devices' activity logs, each named for its device. */
export async function otherLogs(files: PluginFiles, id: string): Promise<{ device: string; text: string }[]> {
  const logs = (await files.folder(DEVICE_FOLDERS.activity)).filter((l) => l.name !== id);
  if (!logs.length) return [];
  const names = new Map((await beatsIn(files)).map((b) => [b.id, b.name]));
  return logs.map((l) => ({ device: names.get(l.name) ?? "another device", text: l.text }));
}

/** What a heartbeat needs from the program it runs in (Obsidian or gizmod). */
export interface HeartbeatIO {
  /** This device's id. */
  id: string;
  files: PluginFiles;
  now(): number;
  /** What this device says about itself now. */
  mine(now: number): Beat;
  /** A new name or zone (a laptop renamed, a phone landed abroad) is said at once rather than at the next interval. */
  sayChanges?: boolean;
  /** Told of a beat that couldn't be written, which is then tried again on the next beat; without it, a failed write counts as said. */
  writeFailed?(e: Error): void;
}

/**
 * Each device says, in a file of its own, that it is still there, every five minutes, and works out
 * from every device's word which one runs background work (see runnerOf). Becoming the one, it
 * starts over: alerts note what is true now rather than running for what changed while another ran.
 */
export class Heartbeat {
  protected io: HeartbeatIO;
  private saidAt = 0;
  private said = "";
  private zoneSaid = "";
  /** Whether this session has read every device's beat yet. */
  private heard = false;
  /** Every device's last word, as last read. */
  beats: Beat[] = [];
  runner: Beat | undefined;
  /** Called when this device becomes the runner and its alerts start over. */
  onStartOver: () => void = () => {};

  constructor(io: HeartbeatIO) {
    this.io = io;
  }

  private write(beat: Beat): Promise<void> {
    return this.io.files.file(deviceFile(DEVICE_FOLDERS.beats, beat.id)).write(JSON.stringify(beat));
  }

  async beat(force = false): Promise<void> {
    const now = this.io.now();
    const me = this.io.mine(now);
    // A folder a sync is rewriting is read next time: who runs stays as it was, and nothing starts over.
    const all = await beatsIn(this.io.files).catch(() => undefined);
    if (!all) return;
    // This device's word from its last session, read before this one is written over it.
    const last = this.heard ? undefined : all.find((b) => b.id === me.id)?.seen;
    const changed = this.io.sayChanges === true && (me.name !== this.said || me.zone !== this.zoneSaid);
    if (!this.heard || force || changed || now - this.saidAt >= BEAT_EVERY_MS) {
      const said = await this.write(me).then(() => true, (e: Error) => {
        if (!this.io.writeFailed) return true;
        this.io.writeFailed(e);
        return false;
      });
      if (said) {
        this.said = me.name;
        this.zoneSaid = me.zone ?? "";
        this.saidAt = now;
      }
    }
    const others = all.filter((b) => b.id !== me.id);
    this.beats = [me, ...others];
    const was = this.runner?.id;
    this.runner = runnerOf(this.beats, now);
    if (startsOver(me.id, this.runner?.id, was, !this.heard, last, others)) this.onStartOver();
    this.heard = true;
  }

  /** Whether this device runs background work; not until it has read every device's beat. */
  isRunner(): boolean {
    return this.heard && this.runner?.id === this.io.id;
  }

  /** The zone a rhythm's deadline means: that of the device the person used last. */
  whereYouAre(): string | undefined {
    return whereYouAre(this.beats);
  }

  /** Whether another program on this computer tells of alerts, so this one doesn't as well (see quietHere). */
  quietHere(): boolean {
    const now = this.io.now();
    return quietHere(this.beats, this.io.mine(now), now);
  }

  /** Says this device is leaving, as it quits, so another takes over background work now. */
  async leave(): Promise<void> {
    await this.write({ ...this.io.mine(this.io.now()), left: true }).catch(() => {});
  }
}

/** Obsidian's Platform, as far as naming a device and choosing its default goes. */
export interface PlatformInfo {
  isMobile: boolean;
  isMacOS: boolean;
  isWin: boolean;
  isLinux: boolean;
  isIosApp: boolean;
  isAndroidApp: boolean;
  isTablet: boolean;
}

/** Where a device keeps its own settings: Obsidian's local storage, which is per vault and per device. */
export interface DeviceStore {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

const KEY = "gizmo-device";

export function defaultName(p: PlatformInfo): string {
  if (p.isIosApp) return p.isTablet ? "iPad" : "iPhone";
  if (p.isAndroidApp) return p.isTablet ? "Android tablet" : "Android phone";
  if (p.isMacOS) return "Mac";
  if (p.isWin) return "Windows PC";
  if (p.isLinux) return "Linux PC";
  return "This device";
}

/** A short random id, as letters and digits. */
export function newDeviceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);
}

/** This device, made and kept the first time, named for what it is. */
export function thisDevice(store: DeviceStore, platform: PlatformInfo, newId: () => string = newDeviceId): Device {
  const kept = store.load(KEY) as Partial<Device> | null;
  if (kept && typeof kept.id === "string" && typeof kept.name === "string") return { id: kept.id, name: kept.name };
  const device = { id: newId(), name: defaultName(platform) };
  store.save(KEY, device);
  return device;
}

export function saveDevice(store: DeviceStore, device: Device): void {
  store.save(KEY, { ...device });
}
