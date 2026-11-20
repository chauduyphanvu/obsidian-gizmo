/**
 * An app as it was at a past time: its own data layer, so nothing of now mixes in, with lists from
 * the ledger's events up to then and web answers from the response history at or before then; notes
 * are read as they are now. Nothing can be changed, nothing is logged and no then runs.
 */
import type { AppEnv } from "./app.ts";
import { DataLayer } from "./datalayer.ts";
import { ledgerStore } from "./datastore.ts";
import { PAST } from "./ledger-store.ts";
import type { AppSpec } from "./spec.ts";
import { sourceDef } from "./sources/registry.ts";

/** `back` shows the app as it is now again, from the banner. */
export function pastEnv(env: AppEnv, at: number, back?: () => void): AppEnv {
  const host = env.data.host;
  // Another device's history may have grown since it was last read.
  host.responses?.changed?.();
  const data = new DataLayer(host, { at, like: env.data });
  const ledger = data.ledger;
  const refuse = () => Promise.reject(new Error(PAST));
  return {
    ...env,
    data,
    now: () => new Date(at),
    writeFrontmatter: refuse,
    updateFrontmatter: refuse,
    appendLine: refuse,
    createNote: refuse,
    setTaskDone: refuse,
    store: ledger && ((dataPath, appPath) => ledgerStore(ledger, dataPath, () => env.frontmatter(appPath) ?? {})),
    log: undefined,
    trigger: undefined,
    opened: undefined,
    backToNow: back,
  };
}

/** Panels whose sources keep no history (notes, tasks, a base, a file, the note itself): shown as they are now. */
export function shownAsNow(spec: AppSpec): string[] {
  const out: string[] = [];
  for (const ps of spec.panels) {
    const p = ps.panel;
    if (!p.source) continue;
    const kind = sourceDef(p.source).id;
    if (["notes", "tasks", "base", "file", "this"].includes(kind)) out.push(p.title ?? p.label ?? p.view);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `Tue 17 Nov 2026, 09:30`: a past time as the app's banner says it. */
export function pastText(at: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
