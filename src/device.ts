/** This device as Gizmo knows it: kept on the device itself, never in a file a sync tool copies. */
export interface Device {
  id: string;
  name: string;
  /** Whether alerts' thens and records run here. */
  background: boolean;
}

/** What a device says about itself in the plugin's folder, so the others can see it. */
export interface Seen {
  id: string;
  name: string;
  background: boolean;
  /** Milliseconds since 1970. */
  seen: number;
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
/** How often a device says it is still there, at most. */
export const SEEN_EVERY_MS = 30 * 60_000;
/** Another device that said so within this long is taken to be running. */
export const RUNNING_WITHIN_MS = 2 * 3_600_000;

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

/**
 * This device, made and kept the first time: named for what it is, and running background work
 * unless it is a phone or tablet, where Obsidian is rarely open long enough for it, and another
 * device already runs it. A phone that is the only device, or the first to update, keeps it on.
 */
export function thisDevice(store: DeviceStore, platform: PlatformInfo, othersRun: boolean, newId: () => string = newDeviceId): Device {
  const kept = store.load(KEY) as Partial<Device> | null;
  if (kept && typeof kept.id === "string" && typeof kept.name === "string" && typeof kept.background === "boolean") {
    return { id: kept.id, name: kept.name, background: kept.background };
  }
  const device = { id: newId(), name: defaultName(platform), background: !platform.isMobile || !othersRun };
  store.save(KEY, device);
  return device;
}

export function saveDevice(store: DeviceStore, device: Device): void {
  store.save(KEY, { ...device });
}

/** The other devices running background work now, as far as what they last said goes. */
export function otherRunners(seen: Seen[], me: string, now: number): Seen[] {
  return seen.filter((s) => s.id !== me && s.background && now - s.seen < RUNNING_WITHIN_MS);
}
