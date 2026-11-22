/**
 * Rows from other vaults, taken into a shared kind as this device's own adds. Nothing of the other
 * vault's log comes along: no time it was written at, no device, no id of its own. Each row gets an
 * id seeded from its writer and the id its writer gave it, so a message read twice (a replay, a
 * catch-up, two of this vault's devices) adds it once, and a row taken out here stays out. Its own
 * `at` says when it happened; its place in this vault's log is when it arrived.
 *
 * A writer numbers each add and take-back of a row with a version that only grows (see
 * background-share.ts), so a row it took back and then logged again comes back here, while a copy
 * of an older message, however late or often it arrives, changes nothing.
 */
import { toNumber, type Row } from "./data.ts";
import type { DataStore, Edit } from "./datastore.ts";
import { lineOf } from "./kind.ts";
import { rowIdOf } from "./ledger-store.ts";
import { rowId } from "./ledger.ts";
import { settlements, type MatchRule } from "./match.ts";
import type { Opened } from "./share-crypto.ts";
import { isStamp, stampFrom, toTime } from "./time.ts";

/** What this vault says of a writer of a kind: rows from it arrive logged, or are refused. Unknown writers' arrive attested. */
export type WriterState = "accepted" | "removed";

/** The id a writer's row has here. */
export function remoteRowId(writer: string, id: string): string {
  return rowId(`remote\n${writer}\n${id}`);
}

/** A remote row's time can be ahead of this device's clock by this much at most: clocks differ, a row of what happened can't be later. */
export const AHEAD_MS = 24 * 3_600_000;

/** Text a remote row may hold in one field. */
const MAX_TEXT = 2000;
/** A writer's name as a row keeps it, at most. */
const MAX_NAME = 60;

/**
 * A name as people read it: in its compatible form, without the invisible and control characters
 * that would make two names look alike and differ, its spaces single.
 */
export function plainName(name: string): string {
  return name.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One value of a remote row as the kind's field keeps it; why not, when it doesn't fit the field's type. */
function valueOf(v: unknown, field: string, type: string | string[]): { value: unknown } | { error: string } {
  if (Array.isArray(type)) {
    const choice = type.find((c) => String(c) === String(v));
    return choice !== undefined && (typeof v === "string" || typeof v === "number") ? { value: choice } : { error: `${field} isn't one of ${type.map(String).join(", ")}` };
  }
  if (type === "number") {
    const n = toNumber(v);
    return n !== undefined && Number.isFinite(n) ? { value: n } : { error: `${field} isn't a number` };
  }
  if (type === "checkbox") return typeof v === "boolean" ? { value: v } : { error: `${field} isn't yes or no` };
  if (type === "date") return typeof v === "string" && DATE.test(v) && isStamp(v) ? { value: v } : { error: `${field} isn't a date` };
  if (type === "time") return typeof v === "string" && TIME.test(v) ? { value: v } : { error: `${field} isn't a time` };
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? { value: String(v).slice(0, MAX_TEXT) } : { error: `${field} isn't text` };
}

/**
 * A remote row as this kind keeps it: `at` (a date, a stamp or an ISO time, kept as a stamp) and the
 * kind's own fields, each as its type keeps it; anything else (Gizmo's own fields, fields this kind
 * doesn't have) left out. Why not, when it can't be kept: no time, a time too far ahead, or a value
 * that doesn't fit its field (a choice the kind doesn't have, text for a number).
 */
export function remoteRow(r: Record<string, unknown>, fields: Record<string, string | string[]>, now: Date): { row: Row } | { error: string } {
  const at = typeof r.at === "string" && r.at.length <= 40 ? stampFrom(r.at) : undefined;
  const t = at === undefined ? undefined : toTime(at);
  if (t === undefined) return { error: "it has no time" };
  if (t > now.getTime() + AHEAD_MS) return { error: "its time is more than a day ahead" };
  const row: Row = { at };
  for (const [field, type] of Object.entries(fields)) {
    const v = r[field];
    if (v === undefined || v === null || v === "") continue;
    const read = valueOf(v, field, type);
    if ("error" in read) return read;
    row[field] = read.value;
  }
  return { row };
}

/** What taking messages into a kind did: rows added, changed, taken back and put back, and messages left out with why. */
export interface Ingested {
  added: Row[];
  /** Rows already here whose writer changed their fields. */
  changed: Row[];
  dismissed: Row[];
  /** Rows taken back before, then logged again by their writer, or rows of a writer accepted since that waited: now counted. */
  restored: Row[];
  refused: string[];
  /** The writer of each message in `refused`, in the same order. */
  refusedFrom: string[];
  /** The activity log's change for each edit written, with its event. */
  done: { edit: Edit; row: Row; from?: unknown; event?: string }[];
}

/**
 * Takes opened messages into a kind's rows in one write: an add from a writer this vault accepted
 * arrives logged, from one it doesn't know attested (it then waits for the person to accept the
 * writer), and from one it removed not at all; a later add of a row from its own writer, with a
 * newer version, gives the row the fields it holds (its writer changed it); a retract sets aside a
 * row only that writer added, and a later add of that row from its writer puts it back. The vault's
 * own messages, coming back from the relay, are skipped. `may(writer)` says whether one more row,
 * new or changed, from that writer still fits under its cap; `name(writer)` is the name this vault
 * knows the writer by, which its rows carry.
 *
 * `versions` is kept by the caller across calls: for each row from another vault, the version of
 * the add its fields are from, or, for a row taken back, minus the version of the take-back. A row
 * of a writer accepted since it arrived (on another device, say) that still waits is counted now.
 * Each row that comes to count as logged settles the planned row it matches under the kind's
 * `match`, in the same write.
 */
export async function ingest(
  store: DataStore, kind: { name: string; fields: Record<string, string | string[]>; match?: MatchRule }, messages: readonly Opened[],
  o: {
    self: string; writers: (writer: string) => WriterState | undefined; now: Date; may?: (writer: string) => boolean;
    name?: (writer: string) => string | undefined; versions?: Record<string, number>;
  },
): Promise<Ingested> {
  const rows = await store.rows(kind.name);
  const byId = new Map(rows.map((r) => [rowIdOf(r), r]));
  const versions = o.versions ?? {};
  const edits: Edit[] = [];
  const refused: string[] = [];
  const refusedFrom: string[] = [];
  /** Adds in this batch, by id, so a retract after its add sets the add's own line. */
  const adding = new Map<string, Row>();
  /** Rows already here whose line this batch changes. */
  const relined = new Set<string>();
  const arriving = (writer: string) => (o.writers(writer) === "accepted" ? undefined : "attested");
  const setLine = (id: string, there: Row, line: string | undefined) => {
    edits.push({ op: "set", list: kind.name, ref: { id, shown: there }, field: "line", value: line });
    const row = { ...there };
    if (line === undefined) delete row.line;
    else row.line = line;
    relined.add(id);
    byId.set(id, row);
  };
  const typed = ["at", ...Object.keys(kind.fields).filter((f) => f !== "at")];
  /** The fields of a row here that its writer's newer version has otherwise; true when there were any. */
  const setFields = (id: string, there: Row, fields: Row): boolean => {
    let row = there;
    for (const f of typed) {
      if (row[f] === fields[f]) continue;
      edits.push({ op: "set", list: kind.name, ref: { id, shown: row }, field: f, value: fields[f] });
      row = { ...row };
      if (fields[f] === undefined) delete row[f];
      else row[f] = fields[f];
    }
    byId.set(id, row);
    return row !== there;
  };
  const refuse = (m: Opened, error: string) => {
    refused.push(`a row from ${m.name}: ${error}`);
    refusedFrom.push(m.writer);
  };
  for (const m of messages) {
    if (m.writer === o.self || m.payload.t === "have") continue;
    const state = o.writers(m.writer);
    if (state === "removed") continue;
    const id = remoteRowId(m.writer, m.payload.id);
    const v = m.payload.q ?? 0;
    const kept = versions[id];
    if (m.payload.t === "add") {
      const pending = adding.get(id);
      const there = pending ?? byId.get(id);
      if (there) {
        if (there.writer !== m.writer) continue;
        // A row set aside comes back only after a take-back older than this add; a row set aside
        // here, with no take-back, stays out. Any other changes only with a newer version.
        const back = lineOf(there) === "dismissed";
        if (back ? kept === undefined || kept >= 0 || v <= -kept : v <= (kept ?? 0)) continue;
        const read = remoteRow(m.payload.r, kind.fields, o.now);
        if ("error" in read) {
          refuse(m, read.error);
          continue;
        }
        if (pending) {
          const differs = typed.some((f) => pending[f] !== read.row[f]);
          if (differs && !back && o.may && !o.may(m.writer)) continue;
          for (const f of typed) delete pending[f];
          Object.assign(pending, read.row);
          if (back) {
            if (state === "accepted") delete pending.line;
            else pending.line = "attested";
          }
        } else {
          const differs = typed.some((f) => there[f] !== read.row[f]);
          if (differs && !back && o.may && !o.may(m.writer)) continue;
          setFields(id, there, read.row);
          if (back) setLine(id, byId.get(id)!, arriving(m.writer));
        }
        versions[id] = v;
        continue;
      }
      const read = remoteRow(m.payload.r, kind.fields, o.now);
      if ("error" in read) {
        refuse(m, read.error);
        continue;
      }
      if (o.may && !o.may(m.writer)) continue;
      const by = (o.name?.(m.writer) ?? plainName(m.name)).slice(0, MAX_NAME) || "someone";
      const row: Row = { ...read.row, by, writer: m.writer, ...(state === "accepted" ? {} : { line: "attested" }) };
      adding.set(id, row);
      if (v > 0) versions[id] = v;
      edits.push({ op: "add", list: kind.name, row, id });
      continue;
    }
    // A take-back older than the add that last put the row back is a copy of an old message.
    if (kept !== undefined && kept > 0 && v < kept) continue;
    const pending = adding.get(id);
    if (pending) {
      pending.line = "dismissed";
      versions[id] = -v;
      continue;
    }
    // Only the row this writer added: never a row of this vault's, nor another writer's, whatever id was sent.
    const there = byId.get(id);
    if (!there || there.writer !== m.writer) continue;
    versions[id] = -Math.max(v, kept !== undefined && kept < 0 ? -kept : 0);
    if (lineOf(there) !== "dismissed") setLine(id, there, "dismissed");
  }
  // A writer accepted since its rows arrived (on another device, before this one heard): they count now.
  for (const [id, there] of byId) {
    if (id === undefined || typeof there.writer !== "string" || lineOf(there) !== "attested" || o.writers(there.writer) !== "accepted") continue;
    setLine(id, there, undefined);
  }
  // Each row that comes to count as logged settles the planned row it matches, as a row logged here does.
  const logged = [
    ...[...adding].filter(([, r]) => lineOf(r) === "logged").map(([id, row]) => ({ id, row })),
    ...[...relined].flatMap((id) => (lineOf(byId.get(id)!) === "logged" ? [{ id, row: byId.get(id)! }] : [])),
  ];
  for (const { plan, id } of settlements(logged, rows, kind.match ?? {})) {
    edits.push({ op: "set", list: kind.name, ref: { id: rowIdOf(plan), shown: plan }, field: "matched", value: id });
  }
  if (!edits.length) return { added: [], changed: [], dismissed: [], restored: [], refused, refusedFrom, done: [] };
  const written = await store.batch(edits);
  if ("refused" in written) {
    return { added: [], changed: [], dismissed: [], restored: [], refused: [...refused, "its rows changed meanwhile; read again next time"], refusedFrom: [...refusedFrom, ""], done: [] };
  }
  const done = written.flatMap((d, i) => {
    if (d.already) return [];
    const edit = edits[i];
    return [{ edit, row: d.row, ...(edit.op === "set" && { from: edit.ref.shown[edit.field] }), ...(d.event && { event: d.event }) }];
  });
  const lines = done.filter((d) => d.edit.op === "set" && d.edit.field === "line");
  // A row whose writer changed it, once, as it is after the last of its fields was set.
  const changed = new Map(done.flatMap((d) => (d.edit.op === "set" && typed.includes(d.edit.field) ? [[d.edit.ref.id, d.row] as const] : [])));
  return {
    added: done.filter((d) => d.edit.op === "add").map((d) => d.row),
    changed: [...changed.values()],
    dismissed: lines.filter((d) => lineOf(d.row) === "dismissed").map((d) => d.row),
    restored: lines.filter((d) => lineOf(d.row) !== "dismissed").map((d) => d.row),
    refused,
    refusedFrom,
    done,
  };
}
