/**
 * An app's environment on any host the runtime runs in. What an app reads, writes, is allowed and
 * asks for goes through the runtime; the host gives only what is its own: how it tells, opens a
 * note, shows the source, copies, and reads a linked note's body as it finds links.
 */
import type { AppEnv } from "./app.ts";
import type { AppAsks } from "./app-asks.ts";
import { ledgerStore } from "./datastore.ts";
import type { GizmoRuntime } from "./runtime.ts";

/** What only the host can do for an app. */
export type HostParts = Pick<AppEnv, "readBody" | "notify" | "openNote" | "showSource" | "showSourceAt" | "sourceLines" | "copy">
  & Pick<AppEnv, "addPanels" | "tryFirst" | "explain">
  & Pick<AppAsks, "fill">;

/** What the person is asked, and how an app answers, through the background service. */
function appAsks(rt: GizmoRuntime, fill: AppAsks["fill"]): AppAsks {
  const bg = rt.background;
  return {
    list: () => bg.asks.list(),
    subscribe: (cb) => bg.asks.subscribe(cb),
    settle: (ask, how) => bg.settleAsk(ask, how),
    skip: async (id) => bg.skipAsk(id),
    run: (line) => bg.capture(line, undefined, true),
    fill,
  };
}

export function runtimeAppEnv(rt: GizmoRuntime, parts: HostParts): AppEnv {
  const frontmatter = (path: string) => rt.dataLayer.host.frontmatter(path);
  const writes = rt.host.writes;
  const ledger = rt.dataLayer.ledger;
  const { fill, addPanels, ...own } = parts;
  return {
    ...own,
    data: rt.dataLayer,
    frontmatter,
    notes: rt.host.notes,
    isGranted: (path, wanted, asked) => rt.isGranted(path, wanted, false, asked),
    granted: (path) => rt.granted(path),
    grant: (path, wanted) => rt.grant(path, wanted),
    verdict: (spec, wanted, where) => rt.verdict(spec, wanted, where),
    policyPending: () => rt.policyPending(),
    storePath: (store, fromPath) => rt.host.storePath(store, fromPath),
    writeFrontmatter: (path, fn) => writes.writeFrontmatter(path, fn),
    store: ledger && ((dataPath, appPath) => ledgerStore(ledger, dataPath, () => frontmatter(appPath) ?? {})),
    updateFrontmatter: (path, fn) => writes.updateFrontmatter(path, fn),
    appendLine: (path, line) => writes.appendLine(path, line),
    createNote: (path, fm, body) => writes.createNote(path, fm, body),
    setTaskDone: (path, line, text, done) => writes.setTaskDone(path, line, text, done),
    // An edit of the app note the person asks for, as Insert panel is: only where the host can show it.
    ...(addPanels && { addPanels }),
    log: (entry) => rt.activity.add(entry),
    undo: (id) => rt.undoById(id),
    trigger: async (from, then, ctx) => rt.background.runThen(from, then, ctx),
    now: () => new Date(),
    opened: (path) => rt.background.opened(path),
    alerts: rt.background.alerts,
    asks: appAsks(rt, fill),
    headline: (path, text) => rt.setHeadline(path, text),
    definitions: rt.definitions,
    deviceName: (id) => (id === rt.device.id ? rt.device.name : rt.beat.beats.find((b) => b.id === id)?.name),
    leftAlone: (key) => rt.leftAlone(key),
    leaveAlone: (key) => rt.leaveAlone(key),
  };
}
