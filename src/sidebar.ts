import type { Ask } from "./asks.ts";
import type { AppState, VaultMap } from "./map.ts";

/** One app in the Gizmo sidebar: where it stands, how many asks wait on it, and its latest change. */
export interface SidebarApp {
  path: string;
  name: string;
  state: AppState;
  /** What the state says beside its name; empty when it is allowed and running. */
  stateText: string;
  asks: number;
  last?: { at: number; what: string };
  /** The app's headline as its own tab last showed it, in place of its latest change. */
  headline?: string;
}

export interface SidebarModel {
  apps: SidebarApp[];
  /** Every ask, as Next has them, oldest due first. */
  asks: Ask[];
}

const STATE_TEXT: Record<AppState, string> = {
  allowed: "",
  "not-opened": "needs OK",
  paused: "paused",
  revoked: "revoked",
  blocked: "blocked",
};

/** The sidebar from the vault's map (see buildMap), Next's asks and the headlines open apps told: apps in name order, each with the asks that name it. */
export function sidebarModel(map: VaultMap, asks: readonly Ask[], headlines: ReadonlyMap<string, string> = new Map()): SidebarModel {
  const waiting = new Map<string, number>();
  for (const a of asks) waiting.set(a.path, (waiting.get(a.path) ?? 0) + 1);
  return {
    apps: map.apps.map((a) => ({
      path: a.path,
      name: a.name,
      state: a.state,
      stateText: STATE_TEXT[a.state],
      asks: waiting.get(a.path) ?? 0,
      ...(a.last && { last: { at: a.last.at, what: a.last.what } }),
      ...(headlines.has(a.path) && a.state === "allowed" && { headline: headlines.get(a.path) }),
    })),
    asks: [...asks],
  };
}
