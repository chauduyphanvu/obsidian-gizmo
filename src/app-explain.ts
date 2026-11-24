import type { AppEnv, Hosting, Mounted } from "./app.ts";
import type { AppWrites } from "./app-writes.ts";
import type { Row } from "./data.ts";
import { DataLayer, type AppFiles } from "./datalayer.ts";
import { panelName } from "./definitions.ts";
import { editableSource } from "./edit.ts";
import { explain, waterfall, type Explanation } from "./explain.ts";
import type { ExplainSource } from "./explain-view.ts";
import { rowIdOf } from "./ledger-store.ts";
import { knobsOf, solve, withProperty } from "./pull.ts";
import { kindFiles, kindOfPanel } from "./sources/kind.ts";
import type { AppSpec } from "./spec.ts";

/** What Explain asks of the app its panel is in, as it is at the moment it asks. */
export interface ExplainApp {
  env: AppEnv;
  appPath: string;
  hosting: Hosting | undefined;
  writes: AppWrites;
  spec(): AppSpec | undefined;
  dataPath(): string;
  files(): AppFiles;
  /** How long a web answer is good for in this app. */
  ttlMs(): number;
  /** Loads the panel again, after a row of it was deleted. */
  reload(m: Mounted): void;
}

/**
 * What the Explain window shows of a panel's figure: its rows as shown, as they were at any past time
 * (read as As of… reads them), where each came from and, in an app's own tab as it is now, the
 * rows it may delete and what the figure could be pulled by.
 */
export function explainSource(m: Mounted, app: ExplainApp): ExplainSource {
  const env = app.env;
  const opts = (now: Date) => ({ ttlMs: app.ttlMs(), now });
  const raw = () => env.data.rawData(m.source, m.p, app.files(), opts(env.now()));
  // A property Pull just set reads at its new value here, before the app has drawn it again.
  let read = m.p;
  const shown = async () => explain(read, await raw(), env.now());
  const at = async (t: number): Promise<Explanation | undefined> => {
    const past = new DataLayer(env.data.host, { at: t, like: env.data });
    try {
      return explain(read, await past.rawData(m.source, m.p, app.files(), opts(new Date(t))), new Date(t));
    } finally {
      past.dispose();
    }
  };
  const saved = editableSource(m.p) === "list";
  const ref = kindOfPanel(m.p);
  const dataPath = ref ? kindFiles(ref).dataPath : app.dataPath();
  const sourceRow = async (rowId: string) => {
    const data = await raw();
    return Array.isArray(data) ? (data as Row[]).find((r) => rowIdOf(r) === rowId) : undefined;
  };
  // Nothing is changed from the past, a what-if, a try, or a note the app is only shown in.
  const live = env.data.at === undefined && !env.ahead && !env.preview && !app.hosting;
  const undoOf = (entry: string | undefined) => (entry && env.undo ? { undo: () => env.undo!(entry) } : {});
  return {
    panel: m.p,
    now: env.now(),
    past: env.data.at !== undefined,
    shown,
    at,
    since: async (t) => {
      const [before, after] = await Promise.all([at(t), shown()]);
      return before && after ? waterfall(before, after) : undefined;
    },
    origins: async () => (saved && env.data.ledger ? env.data.ledger.origins(dataPath) : new Map()),
    keysSince: async (t) => {
      const index = app.spec()?.panels.indexOf(m.ps) ?? -1;
      return index < 0 || app.hosting || !env.definitions ? [] : env.definitions.since(app.appPath, panelName(m.ps, index), t);
    },
    deviceName: (device) => env.deviceName?.(device),
    ...(live && saved && app.writes.mayChange(m.p) && {
      remove: async (part) => {
        const row = part.id === undefined ? undefined : await sourceRow(part.id);
        const done = row ? await app.writes.deleteRow(m, row, () => app.reload(m)) : undefined;
        return done ? { text: "Deleted the row.", ...undoOf(done.entry) } : { text: "The row wasn't deleted." };
      },
    }),
    ...(live && {
      pull: {
        knobs: async () => knobsOf(read, await raw(), env.now()).filter((k) => k.kind === "property" || (saved && app.writes.mayChange(m.p))),
        solve: async (knob, target) => solve(read, await raw(), env.now(), knob, target),
        keep: async (knob, value) => {
          if (knob.kind === "property") {
            const done = await app.writes.pullProperty(m, knob.name, value);
            if (!done.written) return { text: done.text };
            read = withProperty(read, knob.name, value);
            const back = undoOf(done.entry).undo;
            return {
              text: done.text,
              ...(back && { undo: async () => {
                const said = await back();
                read = withProperty(read, knob.name, knob.value);
                return said;
              } }),
            };
          }
          const done = await app.writes.pullRow(m, knob.row, knob.field, value);
          return { text: done.text, ...undoOf(done.entry) };
        },
      },
    }),
  };
}
