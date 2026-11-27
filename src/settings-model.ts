import { when } from "./activity.ts";
import { PRIORITY } from "./device.ts";
import type { GizmoRuntime } from "./runtime.ts";

/** Where background work runs, in a line, and the other devices with when each was last open. */
export function devicesNow(rt: GizmoRuntime, now: Date): { background: string; others: { name: string; desc: string }[] } {
  const { device, beat } = rt;
  // One device runs records and alerts' thens: the one most suited to it that is open, chosen by every device alike.
  const runner = beat.runner;
  const background = !runner || runner.id === device.id
    ? "Runs on this device: records, and the thens alerts run. Shortcuts, links, pins and alert notices work on every device."
    : `Runs on ${runner.name}${runner.priority === PRIORITY.gizmod ? " (gizmod)" : ""}, last heard from ${when(runner.seen, now)}. This device takes it over if that one isn't heard from for 20 minutes.`;
  const others = beat.beats.filter((s) => s.id !== device.id).sort((a, b) => b.seen - a.seen)
    .map((s) => ({ name: s.name, desc: `${s.id === runner?.id ? "Runs background work" : "Doesn't run background work"} · last open ${when(s.seen, now)}` }));
  return { background, others };
}

/** Each secret the vault's apps use (a request's `{secret:id}`, a shared kind's key), with the names of the apps that use it, both in order. */
export function secretsWanted(rt: GizmoRuntime): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const app of rt.background.list()) {
    for (const p of app.wanted) {
      if (!p.startsWith("secret:")) continue;
      const id = p.slice("secret:".length);
      const names = out.get(id) ?? [];
      if (!names.includes(app.name)) names.push(app.name);
      out.set(id, names);
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)).map(([id, names]) => [id, names.sort((a, b) => a.localeCompare(b))]));
}
