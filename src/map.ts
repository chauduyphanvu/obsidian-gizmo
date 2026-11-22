import { describeActor, describeChange, describeSent, type Entry } from "./activity.ts";
import { violationText, type Verdict } from "./flows.ts";
import { grantedOf, isAllowed, isAllowedUnder } from "./grants.ts";
import { describePermission, permissionChanges } from "./permissions.ts";
import { basename } from "./store.ts";

/** What the background knows about an app, as the map shows it. */
export interface AppSummary {
  path: string;
  name: string;
  description: string;
  /** Its data note: `<App> data.md` or its `store`. */
  dataPath: string;
  wanted: string[];
  /** What the data policy says of it, when there is one. */
  verdict?: Verdict;
  /** For each permission, the notes whose keys ask for it (the app or a component it uses). */
  askers: Map<string, Set<string>>;
  shortcuts: { id: string; label: string; view: string; fields: string[] }[];
  records: { block: string; list: string; everyMs: number }[];
  alerts: { title: string; then?: { app: string; do: string; path?: string } }[];
  /** Buttons and forms whose `then` runs another app's shortcut, with the app's path when it is found. */
  thens: { from: string; app: string; do: string; path?: string }[];
  /** Whether a panel appends lines to the app's own note. */
  writesSelf: boolean;
}

export type AppState = "allowed" | "not-opened" | "revoked" | "paused" | "blocked";
export type AskGroup = "Reads" | "Fetches" | "Sends" | "Changes" | "Runs";
export const ASK_GROUPS: readonly AskGroup[] = ["Reads", "Fetches", "Sends", "Changes", "Runs"];

export interface Ask {
  perm: string;
  group: AskGroup;
  text: string;
  /** Components (not the app itself) whose keys ask for it. */
  by: string[];
  /** Asked for but not in what was allowed before. */
  isNew: boolean;
  /** Granted by the data policy, without asking. */
  covered?: boolean;
}

export interface MapApp {
  path: string;
  name: string;
  description: string;
  state: AppState;
  asks: Ask[];
  /** Under a data policy: whether it fits, and the flows it refuses, as lines. */
  policy?: { violations: string[] };
  /** What makes it act on its own or from outside, as plain lines. */
  acts: string[];
  shortcuts: AppSummary["shortcuts"];
  /** Other apps whose `then` runs one of its shortcuts. */
  runBy: { path: string; name: string; do: string }[];
  dataPath: string;
  last?: { at: number; actor: string; what: string };
}

/** An app in a `gizmo` block, by the grant its block was allowed under. */
export interface MapEmbed {
  key: string;
  hostPath: string;
  allowed: string[];
}

/** A component with `for:`, shown on every note in its scope. */
export interface MapLens {
  path: string;
  name: string;
  scope: string;
  allowed: string[] | undefined;
}

export interface VaultMap {
  apps: MapApp[];
  embeds: MapEmbed[];
  lenses: MapLens[];
}

/** Which of the map's groups a permission belongs to. */
export function askGroup(perm: string): AskGroup {
  const kind = perm.split(":")[0];
  if (kind === "read") return "Reads";
  if (kind === "net" || kind === "secret" || perm === "images") return "Fetches";
  if (kind === "send" || kind === "post" || kind === "answer") return "Sends";
  if (kind === "run") return "Runs";
  return "Changes";
}

/** How often, as the map says it: "every 10 minutes". */
export function everyWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 1440 === 0) return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

/**
 * `acted`: the activity log holds something the app did. Opening an app leaves a grant, even for one
 * that asks for nothing, and Revoke takes it away but leaves the app's activity; so an app with
 * activity and no grant was revoked, and one with neither was never opened.
 */
function stateOf(grants: Record<string, string[]>, key: string, wanted: string[], verdict: Verdict | undefined, acted: boolean): AppState {
  if (verdict?.violations.length) return "blocked";
  if (verdict ? isAllowedUnder(grants, key, verdict.asked, true) : isAllowed(grants, key, wanted, true)) return "allowed";
  if (grantedOf(grants, key) !== undefined) return "paused";
  return acted ? "revoked" : "not-opened";
}

/**
 * Every app, embed and lens the vault holds, with what each may do and what makes it act. Apps are
 * in name order; `activity` is newest first, as the log lists it.
 */
export function buildMap(apps: AppSummary[], grants: Record<string, string[]>, lenses: [string, string][], activity: Entry[]): VaultMap {
  const runBy = new Map<string, MapApp["runBy"]>();
  for (const a of apps) {
    for (const t of [...a.thens, ...a.alerts.flatMap((al) => (al.then ? [al.then] : []))]) {
      if (!t.path) continue;
      if (!runBy.has(t.path)) runBy.set(t.path, []);
      runBy.get(t.path)!.push({ path: a.path, name: a.name, do: t.do });
    }
  }
  const lastOf = new Map<string, Entry>();
  for (const e of activity) if (!lastOf.has(e.app)) lastOf.set(e.app, e);

  const mapped = apps.map((a): MapApp => {
    const before = grantedOf(grants, a.path);
    const asks = a.wanted.map((perm): Ask => ({
      perm,
      group: askGroup(perm),
      text: describePermission(perm),
      by: [...(a.askers.get(perm) ?? [])].filter((p) => p !== a.path).sort(),
      isNew: before !== undefined && !before.includes(perm) && !a.verdict?.covered.includes(perm),
      ...(a.verdict?.covered.includes(perm) && { covered: true }),
    }));
    const acts = [
      ...a.records.map((r) => `Records ${r.block} into ${r.list} ${everyWords(r.everyMs)}`),
      ...a.alerts.map((al) => al.then
        ? `When “${al.title}” turns true, runs “${al.then.do}” in ${basename(al.then.path ?? al.then.app)}`
        : `Tells you when “${al.title}” turns true`),
      ...a.thens.map((t) => `“${t.from}” then runs “${t.do}” in ${basename(t.path ?? t.app)}`),
    ];
    const last = lastOf.get(a.path);
    return {
      path: a.path,
      name: a.name,
      description: a.description,
      state: stateOf(grants, a.path, a.wanted, a.verdict, last !== undefined),
      asks,
      ...(a.verdict && { policy: { violations: a.verdict.violations.map(violationText) } }),
      acts,
      shortcuts: a.shortcuts,
      runBy: (runBy.get(a.path) ?? []).sort((x, y) => x.name.localeCompare(y.name)),
      dataPath: a.dataPath,
      last: last && {
        at: last.at,
        actor: describeActor(last.actor),
        what: last.changes.length ? describeChange(last.changes[0]) : last.sent ? describeSent(last.what, last.sent) : last.what,
      },
    };
  }).sort((x, y) => x.name.localeCompare(y.name) || x.path.localeCompare(y.path));

  const appPaths = new Set(apps.map((a) => a.path));
  const lensPaths = new Set(lenses.map(([path]) => path));
  const embeds = Object.keys(grants)
    .filter((key) => key.includes("#") && !appPaths.has(key) && !lensPaths.has(key))
    .map((key): MapEmbed => ({ key, hostPath: key.slice(0, key.lastIndexOf("#")), allowed: grants[key] }))
    .sort((x, y) => x.hostPath.localeCompare(y.hostPath) || x.key.localeCompare(y.key));
  const mappedLenses = lenses
    .map(([path, scope]): MapLens => ({ path, name: basename(path), scope, allowed: grantedOf(grants, path) }))
    .sort((x, y) => x.name.localeCompare(y.name));
  return { apps: mapped, embeds, lenses: mappedLenses };
}

/** Why an app may change a note, or nothing when its keys never write it. */
function writeReason(a: AppSummary, path: string, inScope: (scope: string, path: string) => boolean): string | undefined {
  if (a.dataPath === path) return "keeps its data here";
  if (a.writesSelf && a.path === path) return "changes its own note";
  const reasons = a.wanted.filter((perm) => permissionChanges(perm, path, inScope));
  // The note is there already, so what changes it says more than what could have made it.
  const best = reasons.find((perm) => !perm.startsWith("create:")) ?? reasons[0];
  return best && describePermission(best);
}

export interface Writer {
  path: string;
  name: string;
  /** Why its keys let it change the note; undefined when only the log shows it did. */
  reason?: string;
  /** What it last changed in the note, from the activity log. */
  last?: { at: number; actor: string; what: string };
}

/**
 * The apps that can change a note, from their keys, and the ones the activity log saw change it.
 * Embeds whose block sits in the note come with them, since a `save: this` there writes it.
 */
export function writersOf(
  path: string, apps: AppSummary[], activity: Entry[], inScope: (scope: string, path: string) => boolean,
): Writer[] {
  const out = new Map<string, Writer>();
  for (const a of apps) {
    const reason = writeReason(a, path, inScope);
    if (reason) out.set(a.path, { path: a.path, name: a.name, reason });
  }
  for (const e of activity) {
    const change = e.changes.find((c) => c.path === path);
    if (!change) continue;
    const w = out.get(e.app) ?? { path: e.app, name: basename(e.app) };
    w.last ??= { at: e.at, actor: describeActor(e.actor), what: describeChange(change) };
    out.set(e.app, w);
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name) || x.path.localeCompare(y.path));
}

/** The text of each ```gizmo block in a note, as Obsidian hands it to the block's processor. */
export function gizmoBlocks(text: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  let lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (fence === undefined) {
      const open = /^ {0,3}(`{3,}|~{3,})\s*gizmo\s*$/.exec(line);
      if (open) {
        fence = open[1];
        lines = [];
      }
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
      out.push(lines.join("\n"));
      fence = undefined;
    } else {
      lines.push(line);
    }
  }
  return out;
}
