/**
 * Making and reading a kind's seals through the host's files (see seal.ts): each device keeps its
 * own chain in a file of its own beside the kind's event logs, and reads every device's.
 */
import type { Row } from "./data.ts";
import type { Host } from "./datalayer.ts";
import type { NoteReader } from "./expand.ts";
import { stableJson } from "./hash.ts";
import { logFileParts, logFolder } from "./ledger.ts";
import { rowIdOf } from "./ledger-store.ts";
import { LATE_MS, type Extract } from "./seal-extract.ts";
import { permissionsOf } from "./permissions.ts";
import { readSpec, type KindSpec } from "./spec.ts";
import { basename, isKind } from "./store.ts";
import { checkSeals, fromBase64, isSealsFile, makeSeal, parseSeals, readTimestamp, sealsFile, timestampQuery, toBase64, type Seal, type SealCheck, type SealSpec } from "./seal.ts";

/** What sealing needs of the host beyond its files: a request with bytes in and out, for the authority. */
export type SealHost = Pick<Host, "filesIn" | "readFile" | "append"> & {
  /** Posts bytes and gives the answer's bytes; absent where nothing may be sent. */
  postBytes?(url: string, body: Uint8Array, contentType: string): Promise<{ status: number; bytes: Uint8Array }>;
};

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Every event log of a data note, by file name, as it is now. */
export async function logsOf(host: SealHost, dataPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of host.filesIn?.(logFolder(dataPath)) ?? []) {
    if (!path.endsWith(".jsonl") || !logFileParts(path)) continue;
    try {
      out[nameOf(path)] = await host.readFile(path);
    } catch {
      // Gone, or being written by a sync: sealed next time.
    }
  }
  return out;
}

/** Every device's chain of seals for a data note, oldest first in each. */
export async function chainsOf(host: SealHost, dataPath: string): Promise<{ device: string; seals: Seal[] }[]> {
  const out: { device: string; seals: Seal[] }[] = [];
  for (const path of host.filesIn?.(logFolder(dataPath)) ?? []) {
    if (!isSealsFile(path)) continue;
    try {
      out.push({ device: nameOf(path).replace(/\.seals$/, ""), seals: parseSeals(await host.readFile(path)) });
    } catch {
      // As a log that can't be read.
    }
  }
  return out.sort((a, b) => (a.device < b.device ? -1 : 1));
}

/** How a sealing went, in words, with the seal when one was made. */
export interface Sealed {
  seal?: Seal;
  said: string;
}

/**
 * Seals a data note's logs as they are now, going on from this device's last seal; with an
 * authority, asks it to time-stamp the seal's hash. A seal the authority couldn't stamp is kept
 * without a token, and says so: the next sealing asks again, even with no new line, and adds a seal
 * of the same lines only when the authority stamps it.
 */
export async function sealNow(host: SealHost, dataPath: string, spec: SealSpec, device: string, now: number): Promise<Sealed> {
  if (!host.append) return { said: "This vault keeps no event logs to seal" };
  const logs = await logsOf(host, dataPath);
  const mine = (await chainsOf(host, dataPath)).find((c) => c.device === device)?.seals ?? [];
  const last = mine[mine.length - 1];
  const unstamped = spec.authority !== undefined && host.postBytes !== undefined && last !== undefined && last.token === undefined;
  const seal = await makeSeal(logs, last, now, device, unstamped);
  if (!seal) return { said: Object.keys(logs).length ? "Nothing new to seal: every line is under the last seal" : "No rows are logged yet, so there is nothing to seal" };
  const lines = Object.values(seal.files).reduce((n, f) => n + f.lines, 0);
  let stamp = "";
  if (spec.authority && host.postBytes) {
    try {
      const answer = await host.postBytes(spec.authority, timestampQuery(seal.root), "application/timestamp-query");
      const read = answer.status === 200 ? readTimestamp(answer.bytes) : { error: `${spec.host} answered ${answer.status}` };
      if ("error" in read) stamp = `, without a time stamp: ${read.error}`;
      else if (read.imprint !== seal.root) stamp = ", without a time stamp: the authority answered for another hash";
      else {
        seal.token = toBase64(answer.bytes);
        seal.authority = spec.authority;
        stamp = `, time-stamped by ${spec.host} at ${new Date(read.time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      }
    } catch (e) {
      stamp = `, without a time stamp: couldn't reach ${spec.host} (${(e as Error).message})`;
    }
  } else if (spec.authority) stamp = ", without a time stamp: nothing may be sent from here";
  if (seal.token === undefined && last !== undefined && stableJson(last.files) === stableJson(seal.files)) return { said: `Nothing new to seal${stamp}` };
  await host.append(sealsFile(dataPath, device), `${JSON.stringify(seal)}\n`);
  return { seal, said: `Sealed ${lines} ${lines === 1 ? "line" : "lines"}${stamp}` };
}

/** Each device's chain checked against the logs as they are now. */
export async function checkNow(host: SealHost, dataPath: string): Promise<{ checks: (SealCheck & { device: string })[]; logs: Record<string, string> }> {
  const logs = await logsOf(host, dataPath);
  const checks: (SealCheck & { device: string })[] = [];
  for (const c of await chainsOf(host, dataPath)) checks.push({ device: c.device, ...(await checkSeals(c.seals, logs)) });
  return { checks, logs };
}

/** What a check found, in a sentence or two. */
export function checkWords(checks: readonly (SealCheck & { device: string })[], kind: string): string {
  const seals = checks.reduce((n, c) => n + c.held.length, 0);
  const problems = checks.flatMap((c) => c.problems);
  if (!checks.length || (!seals && !problems.length)) return `${kind} has no seal yet`;
  if (problems.length) return `${kind}: ${problems.length === 1 ? "a seal doesn't hold" : `${problems.length} problems with its seals`}: ${problems[0]}`;
  const stamped = checks.reduce((n, c) => n + c.held.filter((h) => h.stamped).length, 0);
  const last = Math.max(...checks.flatMap((c) => c.held.map((h) => h.time)));
  return `${kind}: ${seals} ${seals === 1 ? "seal holds" : "seals hold"}${stamped ? `, ${stamped} time-stamped by an authority` : ""}; the last is of ${new Date(last).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** When a kind's logs were last sealed by this device (ms); 0 for never. */
export async function lastSealed(host: SealHost, dataPath: string, device: string): Promise<number> {
  const mine = (await chainsOf(host, dataPath)).find((c) => c.device === device)?.seals ?? [];
  return mine.length ? mine[mine.length - 1].at : 0;
}

/** A kind's rows with its logs and seals, as a sealed extract holds them. */
export async function extractOf(host: SealHost, dataPath: string, kind: { name: string; list: string; fields: { name: string; label: string }[] }, rows: readonly Row[], now: number): Promise<Extract> {
  const logs = await logsOf(host, dataPath);
  const chains = (await chainsOf(host, dataPath)).map((c) => c.seals).filter((s) => s.length);
  const shown = rows.flatMap((row) => {
    const id = rowIdOf(row);
    return id === undefined ? [] : [{ id, row: { ...row } }];
  });
  return { kind: kind.name, fields: kind.fields, rows: shown, list: kind.list, logs, chains, made: now, lateMs: LATE_MS };
}

/** A token as bytes, for a tool that checks its signature (`openssl ts -verify`). */
export const tokenBytes = (seal: Seal): Uint8Array | undefined => (seal.token === undefined ? undefined : fromBase64(seal.token));

/** How old this device's last seal of a kind may get before the next one is made on its own. */
export const SEAL_EVERY_MS = 24 * 3_600_000;
/** How often the kinds are looked at for a seal that is due. */
export const SEAL_LOOK_MS = 30 * 60_000;

/** A note as a sealed kind with what it asks for, or why it can't be sealed; undefined when it isn't a kind. */
export function sealedKind(path: string, fm: Record<string, unknown> | undefined, notes: NoteReader): { kind: KindSpec; wanted: string[] } | { why: string } | undefined {
  if (!fm || !isKind(fm)) return undefined;
  const name = basename(path);
  const spec = readSpec(fm, { notes, path })?.spec;
  if (!spec?.kind) return { why: `${name} has a problem to fix first` };
  if (!spec.kind.seal) return { why: `${name} isn't sealed: add seal: true to its properties, or seal: {authority: https://…} for a signed time stamp` };
  return { kind: spec.kind, wanted: permissionsOf(spec, path) };
}

/** Sealing through a host's files; `may` lets it send the hash to the kind's authority. */
export function sealHostOf(host: Host, may: boolean): SealHost {
  const post = host.postBytes?.bind(host);
  return {
    filesIn: (folder) => host.filesIn?.(folder) ?? [],
    readFile: (path) => host.readFile(path),
    ...(host.append && { append: (path: string, text: string) => host.append!(path, text) }),
    ...(may && post && { postBytes: post }),
  };
}
