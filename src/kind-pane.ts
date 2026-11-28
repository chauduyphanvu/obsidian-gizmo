import { convertible, type KindPlan } from "./kind-convert.ts";
import { offerKind, type KindOffer } from "./kind-make.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { readSpec, type AppSpec } from "./spec.ts";
import { basename } from "./store.ts";

/** The lists of the app at `path` that could become kinds, or why none can. */
export function kindLists(rt: GizmoRuntime, path: string, fm: Record<string, unknown>): { spec: AppSpec; lists: string[] } | { error: string } {
  const spec = readSpec(fm, { notes: rt.host.notes, path })?.spec;
  if (!spec) return { error: `${basename(path)} has a problem to fix before one of its lists can become a kind` };
  const lists = convertible(spec);
  if (!lists.length) return { error: `${basename(path)} saves no rows of its own to make a kind of` };
  return { spec, lists };
}

/** What making `list` a kind would do, read from the app's note as it is now. */
export async function offerList(rt: GizmoRuntime, path: string, fm: Record<string, unknown>, spec: AppSpec, list: string): Promise<KindOffer | { error: string }> {
  return offerKind(rt, path, await rt.dataLayer.host.readFile(path), fm, spec, list);
}

export interface KindPlanHost {
  /** Makes the kind; says why when it couldn't. */
  make(): Promise<string | undefined>;
  close(): void;
}

export const kindTitle = (plan: KindPlan): string => `Make ${plan.list} a kind`;

/** Says what making the kind does, line by line, before anything is written. */
export function drawKindPlan(parent: HTMLElement, appName: string, plan: KindPlan, rows: number, host: KindPlanHost): void {
  const kind = basename(plan.path);
  const el = parent.createDiv({ cls: "gizmo gz-kind-plan" });
  el.createEl("p", { text: `Any app can then read these rows with source: "[[${kind}]]" and add to them with save: "[[${kind}]]".` });
  const list = el.createEl("ul");
  list.createEl("li", { text: `Makes the note ${plan.path}, with the fields ${appName} gives ${plan.list}.` });
  list.createEl("li", { text: rows === 1 ? "Carries its 1 row over." : `Carries its ${rows} rows over.` });
  const lines = list.createEl("li", { text: `Changes ${plan.changed.length === 1 ? "this line" : "these lines"} of ${appName}:` });
  for (const c of plan.changed) lines.createEl("pre", { text: `${c.from.trim()}  →  ${c.to.trim()}` });
  list.createEl("li", { text: `${appName} then asks once for your OK to read and change the rows of ${kind}.` });
  el.createEl("p", {
    cls: "gz-muted",
    text: `${appName}'s own copy of the rows stays in ${appName} data, where nothing reads it any more. To go back, put the ${plan.changed.length === 1 ? "line" : "lines"} back and delete ${kind}.`,
  });
  const said = el.createDiv({ cls: "gz-new-app-problem" });
  const row = el.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { text: "Cancel" }).addEventListener("click", () => host.close());
  const go = row.createEl("button", { cls: "mod-cta", text: "Make the kind" });
  go.addEventListener("click", () => {
    go.disabled = true;
    void host.make().then((failed) => {
      if (!failed) return host.close();
      said.setText(failed);
      go.disabled = false;
    });
  });
}
