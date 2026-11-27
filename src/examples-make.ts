import type { ExamplePlan } from "./examples-view.ts";
import { carriedOps } from "./kind-convert.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { defaultDataPath } from "./store.ts";

/**
 * Makes what "New app from lines" showed, in `folder` ("" for the vault's top): the kind note, its
 * rows as events written now (each row keeps the day its line gave), then the app note. The kind
 * and its rows come first, so a failure after them loses nothing. The app's path, or why it couldn't.
 */
export async function makeFromLines(rt: GizmoRuntime, folder: string, plan: ExamplePlan): Promise<{ path: string } | { error: string }> {
  const at = (note: string) => (folder ? `${folder}/${note}.md` : `${note}.md`);
  try {
    const kindPath = at(plan.kindNote);
    if (!(await rt.host.writes.createText(kindPath, plan.kindText))) throw new Error("File already exists.");
    const ledger = rt.dataLayer.ledger;
    if (ledger) {
      const data = defaultDataPath(kindPath);
      rt.dataLayer.noteApp(data, kindPath);
      await ledger.write(data, carriedOps(plan.kind, plan.rows, () => ledger.newRowId()));
      await rt.dataLayer.snapshotNow(data, false).catch(() => undefined);
    }
    const path = at(plan.appNote);
    if (!(await rt.host.writes.createText(path, plan.appText))) throw new Error("File already exists.");
    return { path };
  } catch (e) {
    return { error: `Couldn't make the notes: ${(e as Error).message}` };
  }
}
