/**
 * Making an app's own list a kind, on any host: the plan, how many rows it carries, and the making,
 * in an order that loses nothing if it stops partway. The window that says what it does is the host's.
 */
import { carriedOps, planKind, type KindPlan } from "./kind-convert.ts";
import type { Op } from "./ledger.ts";
import type { GizmoRuntime } from "./runtime.ts";
import type { AppSpec } from "./spec.ts";
import { basename, defaultDataPath } from "./store.ts";

export interface KindOffer {
  plan: KindPlan;
  /** The rows it carries over, as the list holds them now. */
  rows: number;
  /** Makes the kind; what to say, and whether it all went. */
  make(): Promise<{ ok: boolean; said: string }>;
}

/** The list's rows as the app keeps them now, each as an add to the kind's rows (see carriedOps). */
async function carried(rt: GizmoRuntime, appPath: string, fm: Record<string, unknown>, list: string): Promise<Op[]> {
  const ledger = rt.dataLayer.ledger;
  if (!ledger) return [];
  const state = await ledger.state(defaultDataPath(appPath), fm);
  return carriedOps(list, state.lists.get(list)?.rows ?? [], () => ledger.newRowId());
}

/** What making `list` of the app at `appPath` (whose text is `appText`) a kind would do, or why it can't. */
export async function offerKind(
  rt: GizmoRuntime, appPath: string, appText: string, fm: Record<string, unknown>, spec: AppSpec, list: string,
): Promise<KindOffer | { error: string }> {
  const plan = planKind({
    appPath, appText, fm, spec, list, notes: rt.host.notes, parse: (yaml) => rt.dataLayer.host.parseYaml(yaml),
    taken: (path) => rt.host.exists(path),
  });
  if ("error" in plan) return plan;
  const rows = (await carried(rt, appPath, fm, list)).length;
  const app = basename(appPath);
  const kind = basename(plan.path);
  const make = async (): Promise<{ ok: boolean; said: string }> => {
    try {
      // The rows as they are at the click, not as the offer was made.
      const adds = await carried(rt, appPath, fm, list);
      // The kind and its rows first: if the app's lines can't be changed after, nothing is lost and the app still reads its own list.
      if (!(await rt.host.writes.createText(plan.path, plan.text))) throw new Error("File already exists.");
      const kindData = defaultDataPath(plan.path);
      rt.dataLayer.noteApp(kindData, plan.path);
      await rt.dataLayer.ledger?.write(kindData, adds);
      await rt.dataLayer.snapshotNow(kindData, false).catch(() => undefined);
      let changed = false;
      const there = await rt.host.writes.processText(appPath, (now) => {
        changed = now === appText;
        return changed ? plan.appText : now;
      });
      if (!there || !changed) return { ok: false, said: `${kind} is made, but ${app} changed meanwhile; point its source and save at "[[${kind}]]" yourself` };
      return { ok: true, said: `${kind} is a kind now, with ${adds.length} ${adds.length === 1 ? "row" : "rows"} from ${app}` };
    } catch (e) {
      return { ok: false, said: `Couldn't make the kind: ${(e as Error).message}` };
    }
  };
  return { plan, rows, make };
}
