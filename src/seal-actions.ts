/**
 * Seal now, Check seals and Make a sealed extract on a kind note, for any host: what each says, and
 * the extract written as a file of its own beside the kind (see seal-run.ts and seal-extract.ts).
 */
import { readFields } from "./keys.ts";
import { lineOf } from "./kind.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { extractPage } from "./seal-extract.ts";
import { checkNow, checkWords, extractOf, sealNow, sealedKind } from "./seal-run.ts";
import type { KindSpec } from "./spec.ts";
import { basename, defaultDataPath } from "./store.ts";
import { stampParts, toTime } from "./time.ts";

export interface SealedKind {
  path: string;
  kind: KindSpec;
  wanted: string[];
}

/** The note at `path` as a sealed kind; why not when it's a kind that isn't sealed; undefined when it's no kind. */
export function sealedKindAt(rt: GizmoRuntime, path: string): SealedKind | { why: string } | undefined {
  const k = sealedKind(path, rt.host.notes.frontmatter(path), rt.host.notes);
  return k && !("why" in k) ? { path, ...k } : k;
}

/** Seals what isn't sealed yet; says how it went, and that the kind may not ask its authority yet. */
export async function sealSaid(rt: GizmoRuntime, k: SealedKind): Promise<string> {
  const authority = k.kind.seal!.authority !== undefined;
  const host = rt.sealHost(k.path, k.wanted, authority);
  const done = await sealNow(host, defaultDataPath(k.path), k.kind.seal!, rt.device.id, Date.now());
  return authority && !host.postBytes ? `${done.said}. Allow ${basename(k.path)} to ask its authority for a time stamp.` : done.said;
}

/** Checks every device's seals of the kind, in words. */
export async function checkSaid(rt: GizmoRuntime, k: SealedKind): Promise<string> {
  return checkWords((await checkNow(rt.sealHost(k.path, [], false), defaultDataPath(k.path))).checks, basename(k.path));
}

/**
 * Seals first, so every row shows as sealed, then writes the kind's logged rows, its logs and its
 * seals as one HTML file beside the kind note, numbered when the name is taken; gives its path.
 */
export async function sealExtract(rt: GizmoRuntime, k: SealedKind): Promise<string> {
  await sealSaid(rt, k);
  const fm = rt.host.notes.frontmatter(k.path) ?? {};
  const dataPath = defaultDataPath(k.path);
  const ledger = rt.dataLayer.ledger;
  const rows = ledger ? (await ledger.state(dataPath, fm)).lists.get(k.kind.name)?.rows ?? [] : [];
  const logged = rows.filter((r) => lineOf(r) === "logged").sort((a, b) => (toTime(a.at) ?? 0) - (toTime(b.at) ?? 0));
  const info = readFields(fm.fields as Record<string, unknown>).info;
  const fields = Object.keys(k.kind.fields).map((name) => ({ name, label: info[name]?.label ?? name }));
  const name = basename(k.path);
  const x = await extractOf(rt.sealHost(k.path, [], false), dataPath, { name, list: k.kind.name, fields }, logged, Date.now());
  const folder = k.path.includes("/") ? k.path.slice(0, k.path.lastIndexOf("/") + 1) : "";
  // The day here, as the person reads the calendar, not the day in UTC.
  const day = stampParts(new Date()).date;
  const page = extractPage(x);
  for (let n = 1; n < 100; n++) {
    const path = `${folder}${name} sealed ${day}${n === 1 ? "" : ` ${n}`}.html`;
    if (await rt.host.writes.createText(path, page)) return path;
  }
  throw new Error(`${name} has 99 extracts from today already`);
}

/** What Make a sealed extract says once the file is made. */
export const extractSaid = (path: string): string => `Made ${path}: one file that checks itself in any browser`;
