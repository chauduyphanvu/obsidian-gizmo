import { refusal, type Expectation } from "./expect.ts";
import { actionDepsOf, runActions } from "./actions.ts";
import type { Change } from "./activity.ts";
import type { AppEnv } from "./app.ts";
import type { Row } from "./data.ts";
import { editErrors, editableSource } from "./edit.ts";
import { ROW_INDEX } from "./sources/list.ts";
import { sourceDef } from "./sources/registry.ts";
import { kindFiles, kindOfPanel } from "./sources/kind.ts";
import type { Panel } from "./spec.ts";
import type { RunResult } from "./views/registry.ts";
import { frontmatterStore, type DataStore, type Edit } from "./datastore.ts";
import { leftBehind, type Rename } from "./app-cards.ts";
import { rowIdOf } from "./ledger-store.ts";
import { NOT_YET } from "./capture.ts";
import { toTime } from "./time.ts";
import { lineOf } from "./kind.ts";
import { hasRule, settledBy, type MatchRule } from "./match.ts";
import { basename, kindName } from "./store.ts";

/** What a write to a note that was renamed or deleted since it was shown says. */
const GONE = "That note is gone";


/** What the writes read of the open app, each when it is needed. */
export interface WriteSite {
  readonly appPath: string;
  readonly hostPath: string;
  /** The app's data note as it is now; a change to `store` moves it. */
  dataPath(): string;
  /** What the activity log calls a checklist: its panel's title, else the list it ticks into. */
  checklistName(key: string): string;
  /** The app's rules under `expect:`, as it reads now. */
  expect(): readonly Expectation[];
  /** Whether the app asks to change the rows of the kind with this note (`kind-write`); without this, only the kind's own note does. */
  writesKind?(kindPath: string): boolean;
}

/** What bringing rows along with a rename did, as the activity log says it. */
function renameDone(r: Rename, n: number): string {
  const rows = `${n} ${n === 1 ? "row" : "rows"}`;
  if (r.kind === "field") return `Moved ${r.from} into ${r.to} in ${rows} of ${r.list}`;
  if (r.kind === "choice") return `Changed ${r.field} ${r.from} to ${r.to} in ${rows} of ${r.list}`;
  return `Moved ${rows} from ${r.from} to ${r.to}`;
}

/** A drawn panel, whose checked keys are read as they are when a write needs them. */
interface Drawn {
  readonly p: Panel;
}

/**
 * What an open app writes, each change kept in the activity log as the person's: a checklist's
 * ticks, a `save: this` form's fields, edited rows and tasks, and what a panel's actions do.
 */
export class AppWrites {
  private env: AppEnv;
  private site: WriteSite;

  constructor(env: AppEnv, site: WriteSite) {
    this.env = env;
    this.site = site;
  }

  /** Ticks the item, or unticks it when it was ticked: the box's state is whatever the list holds when this runs. */
  async toggleChecked(key: string, item: string): Promise<void> {
    const store = this.store();
    try {
      const ticked = await store.tick(key, item);
      const done = ticked ?? (await store.untick(key, item));
      if (!done) return;
      const event = done.event;
      void this.log(this.site.checklistName(key), [{ kind: "checklist", path: store.dataPath, list: key, item, checked: !!ticked, ...(event && { event }) }]);
    } catch (e) {
      this.env.notify(`Couldn't save: ${(e as Error).message}`);
    }
  }

  async clearChecked(key: string): Promise<void> {
    const store = this.store();
    try {
      const { items, event } = await store.clear(key);
      if (items.length) void this.log(this.site.checklistName(key), [{ kind: "cleared", path: store.dataPath, list: key, items, ...(event && { event }) }]);
    } catch (e) {
      this.env.notify(`Couldn't save: ${(e as Error).message}`);
    }
  }

  /** Where the app's lists are kept. */
  private store(): DataStore {
    return this.storeAt(this.site.dataPath(), this.site.appPath);
  }

  /** Where the lists in a data note are kept, for the note that owns them. */
  private storeAt(dataPath: string, ownerPath: string): DataStore {
    return this.env.store?.(dataPath, ownerPath)
      ?? frontmatterStore(dataPath, (path, fn) => this.env.writeFrontmatter(path, fn), (path) => this.env.frontmatter(path), () => this.env.frontmatter(ownerPath) ?? {});
  }

  /**
   * The saved rows a panel shows: the kind's it links to, else the app's list its source names, which
   * in a kind's own note are the kind's. `own`: the app's own rules are about them.
   */
  private listOf(p: Panel): { store: DataStore; name: string; own: boolean; kind: boolean } {
    const ref = kindOfPanel(p);
    const kind = ref !== undefined || kindName(this.env.frontmatter(this.site.appPath)) === p.source;
    if (!ref) return { store: this.store(), name: p.source!, own: true, kind };
    const files = kindFiles(ref);
    return { store: this.storeAt(files.dataPath, files.appPath), name: ref.name, own: ref.path === this.site.appPath, kind };
  }

  /**
   * Whether a panel may change the saved rows it shows: an app's own list, a kind's rows in the
   * kind's own note, or a kind whose rows the app asks to change. A kind it only reads, it can't.
   */
  mayChange(p: Panel): boolean {
    const ref = kindOfPanel(p);
    return !ref || ref.path === this.site.appPath || this.site.writesKind?.(ref.path) === true;
  }

  /**
   * Why a row a panel shows isn't this vault's to change: another vault's member wrote it, in a
   * shared kind, and only they can change it or take it back; undefined when it is this vault's.
   */
  theirs(p: Panel, row: Row): string | undefined {
    if (typeof row.writer !== "string" || editableSource(p) !== "list" || !this.listOf(p).kind) return undefined;
    const by = typeof row.by === "string" && row.by ? row.by : "someone";
    return `By ${by}; only ${by} can change it`;
  }

  /** Says a write to a kind's rows the app only reads isn't made; true when it isn't. */
  private readOnly(p: Panel, what: string): boolean {
    if (this.mayChange(p)) return false;
    this.env.notify(`Not ${what}: this app reads the rows of ${basename(kindOfPanel(p)!.path)}, and doesn't change them`);
    return true;
  }

  /**
   * Keeps what the person just changed through the app, so the app's activity can show and undo it;
   * gives the entry's id once it is kept, when the env says.
   */
  private log(what: string, changes: Change[]): Promise<string | undefined> | undefined {
    if (!changes.length) return undefined;
    const kept = this.env.log?.({ app: this.site.appPath, actor: "you", what, changes });
    return kept ? kept.then((e) => e?.id, () => undefined) : undefined;
  }

  /** Sets one property of an existing note and keeps what it was; false when the note is gone. */
  private async setField(path: string, field: string, value: unknown, what: string): Promise<boolean> {
    let change: Change | undefined;
    const written = await this.env.updateFrontmatter(path, (fm) => {
      change = { kind: "property", path, field, from: fm[field], to: value, had: Object.hasOwn(fm, field) };
      fm[field] = value;
    });
    if (written && change) void this.log(what, [change]);
    return written;
  }

  /**
   * Writes one field of a `save: this` form to the note the app sits in: only a field the form has,
   * and for a lens only while that note is in the scope it was allowed to change.
   */
  async setProperty(m: Drawn, field: string, value: unknown): Promise<void> {
    const target = m.p.target;
    if (target?.kind !== "this" || !Object.hasOwn(m.p.fields ?? {}, field)) return;
    if (target.scope && !this.env.data.notes(target.scope).some((r) => r.path === this.site.hostPath)) return;
    try {
      if (!(await this.setField(this.site.hostPath, field, value, m.p.title ?? m.p.label ?? field))) this.env.notify(GONE);
    } catch (e) {
      this.env.notify(`Couldn't save: ${(e as Error).message}`);
    }
  }

  /**
   * Writes one field of a row a panel shows back where it came from, as far as the panel's checked
   * keys allow: a note in its `from` (granted as edit:<from>; any note for a base, edit:*), a task
   * line in a note in its `from` (tasks:<from>), or the row's place in the list it reads, which
   * must still hold the row that was shown. When it doesn't, `reload` shows the rows as they are.
   */
  async editRow(m: Drawn, row: Row, field: string, value: unknown, reload: () => void): Promise<void> {
    if (editErrors(m.p, [field]).length) return;
    try {
      if (editableSource(m.p) === "tasks") return await this.tickTask(m, row, value, reload);
      if (editableSource(m.p) === "notes") {
        const path = row.path;
        const scope = sourceDef(m.p.source!).id === "base" ? this.env.data.allNotes() : this.env.data.notes(m.p.from ?? "");
        if (typeof path !== "string" || !scope.some((r) => r.path === path)) return;
        if (!(await this.setField(path, field, value, m.p.title ?? field))) this.env.notify(GONE);
        return;
      }
      const symbols = row as Record<symbol, unknown>;
      const index = symbols[ROW_INDEX];
      const id = rowIdOf(row);
      if (typeof index !== "number" && id === undefined) return;
      if (this.readOnly(m.p, "saved")) return reload();
      const theirs = this.theirs(m.p, row);
      if (theirs) {
        this.env.notify(`Not saved: ${theirs}`);
        return reload();
      }
      const { store, name, own, kind } = this.listOf(m.p);
      // A saved row says when it happened, so it isn't moved to a time still to come; a kind's
      // logged or planned row moved there is planned. A what-if row may be for any time.
      const ahead = field === "at" && (toTime(value) ?? -Infinity) > this.env.now().getTime();
      const plans = ahead && kind && (lineOf(row) === "logged" || lineOf(row) === "planned");
      if (ahead && !plans && !this.env.ahead) {
        this.env.notify(`Not saved: ${NOT_YET}`);
        reload();
        return;
      }
      // The app's rules are about its own lists; a kind's rows answer to the kind.
      const refused = own ? refusal(this.site.expect(), name, { ...row, [field]: value }, this.env.now()) : undefined;
      if (refused) {
        this.env.notify(`Not saved: ${refused}`);
        reload();
        return;
      }
      if (plans && lineOf(row) === "logged") return await this.planRow(m, store, name, row, value, reload);
      const r = await store.set(name, { id, index: typeof index === "number" ? index : undefined, shown: row }, field, value);
      if ("row" in r) {
        void this.log(m.p.title ?? field, [{ kind: "row-edited", path: store.dataPath, list: name, row: r.row, field, from: row[field], to: value, ...(r.event && { event: r.event }) }]);
        return;
      }
      this.env.notify(r.refused === "gone" ? "That row is gone; reload" : "That row has changed; reload");
      // Shows the list as it is now, putting back what the input claimed.
      reload();
    } catch (e) {
      this.env.notify(`Couldn't save: ${(e as Error).message}`);
      // A what-if refuses to change a real row: the input shows the row as it is again.
      if (this.env.ahead) reload();
    }
  }

  /** A kind's logged row moved to a time still to come: its time and its line, in one write and one entry. */
  private async planRow(m: Drawn, store: DataStore, name: string, row: Row, at: unknown, reload: () => void): Promise<void> {
    const index = (row as Record<symbol, unknown>)[ROW_INDEX];
    const ref = { id: rowIdOf(row), index: typeof index === "number" ? index : undefined, shown: row };
    const edits: Edit[] = [{ op: "set", list: name, ref, field: "at", value: at }, { op: "set", list: name, ref, field: "line", value: "planned" }];
    const done = await store.batch(edits);
    if ("refused" in done) {
      this.env.notify(done.refused === "gone" ? "That row is gone; reload" : "That row has changed; reload");
      reload();
      return;
    }
    void this.log(m.p.title ?? "at", edits.map((e, i): Change => {
      const set = e as Extract<Edit, { op: "set" }>;
      return { kind: "row-edited", path: store.dataPath, list: name, row: done[i].row, field: set.field, from: row[set.field], to: set.value, ...(done[i].event && { event: done[i].event }) };
    }));
  }

  /**
   * Deletes a row a panel shows from the saved list it reads, kept in the activity log so Undo can
   * put it back; gives the log's entry once kept. Undefined when nothing was deleted: the row isn't
   * one of a saved list's, or it changed or went meanwhile, which is told, and `reload` shows the
   * rows as they are. A row a kind imported is never deleted: Not mine sets it aside.
   */
  async deleteRow(m: Drawn, row: Row, reload: () => void): Promise<{ entry?: string } | undefined> {
    if (editableSource(m.p) !== "list") return undefined;
    const index = (row as Record<symbol, unknown>)[ROW_INDEX];
    const id = rowIdOf(row);
    if (typeof index !== "number" && id === undefined) return undefined;
    if (this.readOnly(m.p, "deleted")) return undefined;
    const theirs = this.theirs(m.p, row);
    if (theirs) {
      this.env.notify(`Not deleted: ${theirs}; Not mine sets it aside`);
      return undefined;
    }
    try {
      const { store, name, kind } = this.listOf(m.p);
      if (kind && (lineOf(row) === "attested" || lineOf(row) === "dismissed")) {
        this.env.notify("A row read from a file stays, so reading the file again doesn't bring it back; use Not mine to set it aside");
        return undefined;
      }
      const r = await store.delete(name, { id, index: typeof index === "number" ? index : undefined, shown: row });
      if ("row" in r) {
        const change: Change = { kind: "row-deleted", path: store.dataPath, list: name, row: r.row, ...(r.index !== undefined && { index: r.index }), ...(r.event && { event: r.event }) };
        return { entry: await this.log(m.p.title ?? name, [change]) };
      }
      this.env.notify(r.refused === "gone" ? "That row is gone; reload" : "That row has changed; reload");
      reload();
    } catch (e) {
      this.env.notify(`Couldn't delete: ${(e as Error).message}`);
    }
    return undefined;
  }

  /**
   * Not mine, on a row of a shared kind that someone else wrote: sets it aside here, kept in the
   * activity log so Undo can bring it back; gives the log's entry once kept. Their vault keeps it.
   */
  async setAside(m: Drawn, row: Row, reload: () => void): Promise<{ entry?: string } | undefined> {
    const id = rowIdOf(row);
    if (id === undefined || !this.theirs(m.p, row) || this.readOnly(m.p, "set aside")) return undefined;
    try {
      const { store, name } = this.listOf(m.p);
      const r = await store.set(name, { id, shown: row }, "line", "dismissed");
      if ("row" in r) {
        const change: Change = { kind: "row-edited", path: store.dataPath, list: name, row: r.row, field: "line", from: row.line, to: "dismissed", ...(r.event && { event: r.event }) };
        return { entry: await this.log(`Set aside a row from ${typeof row.by === "string" && row.by ? row.by : "someone"}`, [change]) };
      }
      this.env.notify(r.refused === "gone" ? "That row is gone; reload" : "That row has changed; reload");
      reload();
    } catch (e) {
      this.env.notify(`Couldn't set it aside: ${(e as Error).message}`);
    }
    return undefined;
  }

  /**
   * Brings a saved list's rows along with a rename in the app's keys, in one write: the old field's
   * values moved into the new field, the old choice changed to the new, or the old list's rows moved
   * to the new list. Kept in the activity log as one entry of every row's change, so one Undo puts
   * them all back.
   */
  async moveRenamed(r: Rename): Promise<void> {
    try {
      const store = this.store();
      const list = r.kind === "list" ? r.from : r.list;
      const edits: Edit[] = [];
      (await store.rows(list)).forEach((row) => {
        if (!leftBehind(r, row)) return;
        const index = (row as Record<symbol, unknown>)[ROW_INDEX];
        const ref = { id: rowIdOf(row), index: typeof index === "number" ? index : undefined, shown: row };
        if (r.kind === "field") edits.push({ op: "set", list, ref, field: r.to, value: row[r.from] }, { op: "set", list, ref, field: r.from, value: undefined });
        else if (r.kind === "choice") edits.push({ op: "set", list, ref, field: r.field, value: r.value });
        else edits.push({ op: "add", list: r.to, row: { ...row } }, { op: "delete", list, ref });
      });
      if (!edits.length) return;
      const done = await store.batch(edits);
      if ("refused" in done) {
        this.env.notify("Those rows changed meanwhile; nothing was moved");
        return;
      }
      const path = store.dataPath;
      const changes = edits.map((e, i): Change => {
        const { row, event, index } = done[i];
        const kept = { ...(event && { event }) };
        if (e.op === "add") return { kind: "row-added", path, list: e.list, row, ...kept };
        if (e.op === "delete") return { kind: "row-deleted", path, list: e.list, row, ...(index !== undefined && { index }), ...kept };
        return { kind: "row-edited", path, list: e.list, row, field: e.field, from: e.ref.shown[e.field], to: e.value, ...kept };
      });
      const n = edits.length / (r.kind === "choice" ? 1 : 2);
      void this.log(renameDone(r, n), changes);
    } catch (e) {
      this.env.notify(`Couldn't move them: ${(e as Error).message}`);
    }
  }

  /**
   * Settles rows of the kind this note is that were read from a file, in one write kept as one
   * entry: one that pairs with a logged row points at it (`matched`); one that pairs with none
   * becomes logged, its `line` taken out, never copied, and settles the planned row it matches
   * under `rule`, as a row logged by hand does; `dismiss` sets it aside.
   */
  async settleRows(list: string, rows: { row: Row; pair?: Row }[], dismiss: boolean, rule: MatchRule = {}, panel?: Panel): Promise<void> {
    if (panel && this.readOnly(panel, "changed")) return;
    try {
      const store = panel ? this.listOf(panel).store : this.store();
      const edits: Edit[] = rows.flatMap(({ row, pair }): Edit[] => {
        const ref = { id: rowIdOf(row), shown: row };
        if (dismiss) return [{ op: "set", list, ref, field: "line", value: "dismissed" }];
        const id = pair && rowIdOf(pair);
        if (id !== undefined) return [{ op: "set", list, ref, field: "matched", value: id }];
        // Logged now, it keeps the id its import gave it, so it never pairs with a row of a file.
        return [{ op: "set", list, ref, field: "line", value: undefined }, { op: "set", list, ref, field: "imported", value: rowIdOf(row) }];
      });
      if (!dismiss && hasRule(rule)) {
        const all = await store.rows(list);
        const taken = new Set<string>();
        for (const { row, pair } of rows) {
          const id = rowIdOf(row);
          if (pair || id === undefined) continue;
          const plan = settledBy({ ...row, line: undefined }, all.filter((r) => !taken.has(rowIdOf(r) ?? "")), rule);
          const planId = plan && rowIdOf(plan);
          if (!plan || planId === undefined) continue;
          taken.add(planId);
          edits.push({ op: "set", list, ref: { id: planId, shown: plan }, field: "matched", value: id });
        }
      }
      if (!edits.length) return;
      const done = await store.batch(edits);
      if ("refused" in done) {
        this.env.notify("Those rows changed meanwhile; nothing was changed");
        return;
      }
      const changes = edits.map((e, i): Change => {
        const set = e as Extract<Edit, { op: "set" }>;
        return { kind: "row-edited", path: store.dataPath, list, row: done[i].row, field: set.field, from: set.ref.shown[set.field], to: set.value, ...(done[i].event && { event: done[i].event }) };
      });
      const n = rows.length;
      void this.log(`${dismiss ? "Set aside" : "Accepted"} ${n === 1 ? "a row" : `${n} rows`} from a file`, changes);
    } catch (e) {
      this.env.notify(`Couldn't save: ${(e as Error).message}`);
    }
  }

  /** Ticks the task a row shows, in a note of the panel's `from`; when it has moved or changed, shows the notes as they are. */
  private async tickTask(m: Drawn, row: Row, done: unknown, reload: () => void): Promise<void> {
    const { path, line, text } = row;
    if (typeof path !== "string" || typeof line !== "number" || typeof text !== "string" || typeof done !== "boolean") return;
    if (!this.env.data.notes(m.p.from ?? "").some((r) => r.path === path)) return;
    if (await this.env.setTaskDone(path, line, text, done)) {
      void this.log(m.p.title ?? "tasks", [{ kind: "task", path, line, text, done }]);
      return;
    }
    this.env.notify("That task has changed; reload");
    reload();
  }

  /**
   * `inPlace`: the panel tells its `notify` itself, so it isn't also a notice; `at`: what it saves is
   * logged for then; `plan`: each time a row saved to a kind is planned for. Ahead, what it saves is
   * a what-if row, for now unless `at` says.
   */
  async runActions(p: Panel, row: Row, how?: { inPlace?: boolean; at?: Date; plan?: Date[] }): Promise<RunResult> {
    const env = this.env;
    const appPath = this.site.appPath;
    const at = how?.at ?? env.ahead?.live.now();
    const r = await runActions(p, row, {
      ...actionDepsOf(env, appPath, this.site.dataPath()),
      ...(at && { at }),
      ...(how?.plan && { plan: how.plan }),
      ...(env.ahead && { whatIf: true }),
      expect: this.site.expect(),
      log: (what, changes) => this.log(what, changes),
      then: async (panel, ctx) => { if (panel.then) await env.trigger?.(appPath, panel.then, ctx); },
      inPlace: how?.inPlace,
      // A try lists what the run tells among what it does, in order, as well as saying it in place.
      quiet: how?.inPlace && !env.preview,
    });
    const entry = await r.logged;
    if (r.partly !== undefined) return { failed: `${r.partly}: ${r.error}`, ok: false, ...(entry !== undefined && { entry }) };
    if (r.error) return { error: r.error, ok: false };
    return { ok: r.ok, ...(entry !== undefined && { entry }), ...(r.told !== undefined && { told: r.told }) };
  }
}
