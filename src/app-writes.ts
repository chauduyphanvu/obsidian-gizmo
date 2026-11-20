import { actionDepsOf, runActions } from "./actions.ts";
import type { Change } from "./activity.ts";
import type { AppEnv } from "./app.ts";
import type { Row } from "./data.ts";
import { editErrors, editableSource } from "./edit.ts";
import { ROW_INDEX, ROW_SOURCE } from "./sources/list.ts";
import { sourceDef } from "./sources/registry.ts";
import type { Panel } from "./spec.ts";
import { resolveList, type Split } from "./store.ts";

/** What a write to a note that was renamed or deleted since it was shown says. */
const GONE = "That note is gone";

/** Whether a stored list row still holds what was shown for it, apart from the field being changed. */
function holds(stored: unknown, shown: Row, field: string): stored is Row {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return false;
  return Object.entries(stored).every(([k, v]) => k === field || JSON.stringify(v) === JSON.stringify(shown[k]));
}

/** What the writes read of the open app, each when it is needed. */
export interface WriteSite {
  readonly appPath: string;
  readonly hostPath: string;
  /** The app's data note as it is now; a change to `store` moves it. */
  dataPath(): string;
  /** With `devices: split`, where this device's rows go. */
  split(): Split | undefined;
  /** What the activity log calls a checklist: its panel's title, else the list it ticks into. */
  checklistName(key: string): string;
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

  async toggleChecked(key: string, item: string): Promise<void> {
    let checked = false;
    await this.writeData((fm) => {
      const list = Array.isArray(fm[key]) ? (fm[key] as unknown[]).map(String) : [];
      checked = !list.includes(item);
      fm[key] = checked ? [...list, item] : list.filter((i) => i !== item);
    });
    this.log(this.site.checklistName(key), [{ kind: "checklist", path: this.site.dataPath(), list: key, item, checked }]);
  }

  async clearChecked(key: string): Promise<void> {
    let items: string[] = [];
    await this.writeData((fm) => {
      items = Array.isArray(fm[key]) ? (fm[key] as unknown[]).map(String) : [];
      fm[key] = [];
    });
    if (items.length) this.log(this.site.checklistName(key), [{ kind: "cleared", path: this.site.dataPath(), list: key, items }]);
  }

  private writeData(fn: (fm: Record<string, unknown>) => void): Promise<void> {
    return this.env.writeFrontmatter(this.site.dataPath(), fn);
  }

  /** Keeps what the person just changed through the app, so the app's activity can show and undo it. */
  private log(what: string, changes: Change[]): void {
    if (changes.length) this.env.log?.({ app: this.site.appPath, actor: "you", what, changes });
  }

  /** Sets one property of an existing note and keeps what it was; false when the note is gone. */
  private async setField(path: string, field: string, value: unknown, what: string): Promise<boolean> {
    let change: Change | undefined;
    const written = await this.env.updateFrontmatter(path, (fm) => {
      change = { kind: "property", path, field, from: fm[field], to: value, had: Object.hasOwn(fm, field) };
      fm[field] = value;
    });
    if (written && change) this.log(what, [change]);
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
      const index = (row as Record<symbol, unknown>)[ROW_INDEX];
      if (typeof index !== "number") return;
      // A row read from a device's own note is changed there; that device's next save keeps it.
      const source = (row as Record<symbol, unknown>)[ROW_SOURCE];
      const path = typeof source === "string" ? source : this.site.dataPath();
      const name = m.p.source!;
      let changed = false;
      let edit: Change | undefined;
      await this.env.writeFrontmatter(path, (fm) => {
        const list = typeof source === "string" ? fm[name] : resolveList(name, fm, this.env.frontmatter(this.site.appPath) ?? {});
        const stored = Array.isArray(list) ? list[index] : undefined;
        if (!Array.isArray(list) || !holds(stored, row, field)) {
          changed = true;
          return;
        }
        const next = [...list];
        next[index] = { ...stored, [field]: value };
        fm[name] = next;
        edit = { kind: "row-edited", path, list: name, row: next[index] as Row, field, from: stored[field], to: value };
      });
      if (edit) this.log(m.p.title ?? field, [edit]);
      if (changed) {
        this.env.notify("That row has changed; reload");
        // Shows the list as it is now, putting back what the input claimed.
        reload();
      }
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
      this.log(m.p.title ?? "tasks", [{ kind: "task", path, line, text, done }]);
      return;
    }
    this.env.notify("That task has changed; reload");
    reload();
  }

  async runActions(p: Panel, row: Row): Promise<void> {
    const env = this.env;
    const appPath = this.site.appPath;
    const split = this.site.split();
    await runActions(p, row, {
      ...actionDepsOf(env, appPath, split?.mine ?? this.site.dataPath()),
      stamp: split && { device: split.id },
      log: (what, changes) => this.log(what, changes),
      then: async (panel, ctx) => { if (panel.then) await env.trigger?.(appPath, panel.then, ctx); },
    });
  }
}
