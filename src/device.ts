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
  const live = beats.filter((b) => now - b.seen < UNSEEN_MS && !b.left);
  return live.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
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
 * Where the person is, for a deadline that says "by 10:00": the zone of the phone or desktop they
 * used last, however long ago, since a phone abroad may not have been heard from since. Undefined
 * when no device says, and the runner's own clock decides.
 */
export function whereYouAre(beats: readonly Beat[]): string | undefined {
  let latest: Beat | undefined;
  for (const b of beats) if (b.used !== undefined && b.zone && b.priority < PRIORITY.gizmod && (!latest || b.used > latest.used!)) latest = b;
  return latest?.zone;
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
