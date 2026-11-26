import { aheadLines, discard, keep, lookAhead, readAsNow, whatIfNotes, whatIfRows } from "./ahead.ts";
import { renderAheadCard, type AheadActions, type AheadCard } from "./ahead-card.ts";
import type { AppEnv, Hosting } from "./app.ts";
import { editWords, findRenames, renameKey, renderHandEdit, renderRename, type KindToAllow } from "./app-cards.ts";
import type { AppWrites } from "./app-writes.ts";
import type { Row } from "./data.ts";
import type { AppFiles } from "./datalayer.ts";
import { fileRowIds, importable } from "./import.ts";
import { rowIdOf } from "./ledger-store.ts";
import { reconcileOf, ruleOf } from "./match.ts";
import { checklistList } from "./panel.ts";
import { describePermission, permissionsOf } from "./permissions.ts";
import { cardFields, renderReconcile } from "./views/reconcile-card.ts";
import { kindFiles } from "./sources/kind.ts";
import { readSpec, type AppSpec, type Panel } from "./spec.ts";
import { basename, defaultDataPath } from "./store.ts";
import { toTime } from "./time.ts";
import { watches } from "./backtest.ts";
import type { PanelCtx } from "./views/registry.ts";

/** What the checks ask of the app they belong to, as it is at the moment they ask. */
export interface ChecksApp {
  env: AppEnv;
  appPath: string;
  hosting: Hosting | undefined;
  writes: AppWrites;
  shell: HTMLElement;
  spec(): AppSpec | undefined;
  dataPath(): string;
  files(): AppFiles;
  /** The app's input values and selections, as panels are filled with them. */
  current(): Record<string, unknown>;
}

/**
 * What an app says above its panels about the notes it keeps and reads, each looked up again as
 * they change: the data note edited by hand, a rename its saved rows didn't follow, rows from a
 * file waiting to be checked, kinds not allowed yet, and, shown ahead, the what-if's card.
 */
export class AppChecks {
  private app: ChecksApp;
  /** The card saying the data note was edited by hand, while it is. */
  private handEdit: HTMLElement | undefined;
  /** The card offering to bring saved rows along with a rename in the app's keys, while one is found; and which look for one is the latest. */
  private renameCard: HTMLElement | undefined;
  private renameChecks = 0;
  /** In a kind's own tab: the rows read from a file that wait to be accepted or set aside. */
  private reconcileCard: HTMLElement | undefined;
  private reconcileChecks = 0;
  /** Shown ahead: the what-if's card, which fill of it is the latest, and the fill waiting for changes to stop. */
  private aheadCard: AheadCard | undefined;
  private aheadChecks = 0;
  private aheadTimer: number | undefined;

  constructor(app: ChecksApp) {
    this.app = app;
  }

  private get env() { return this.app.env; }
  private get appPath() { return this.app.appPath; }
  private get hosting() { return this.app.hosting; }
  private get writes() { return this.app.writes; }
  private get shell() { return this.app.shell; }
  private get spec() { return this.app.spec(); }
  private get dataPath() { return this.app.dataPath(); }
  /** Shown as it was, ahead or in a try: nothing there may be changed, and nothing waits to be. */
  private get frozen(): boolean { return this.env.data.at !== undefined || !!this.env.ahead || !!this.env.preview; }
  private files(): AppFiles { return this.app.files(); }
  private current(): Record<string, unknown> { return this.app.current(); }

  /** Stops the fill that waits, and any still running from showing. */
  stop(): void {
    window.clearTimeout(this.aheadTimer);
    this.aheadChecks++;
  }

  /** Shown ahead, puts the what-if's card in the header just drawn; no card otherwise. */
  drawAhead(header: HTMLElement): void {
    const ahead = this.env.ahead;
    this.aheadCard = ahead && this.spec ? renderAheadCard(header, ahead, readAsNow(this.spec), this.aheadActions()) : undefined;
  }

  /**
   * The kinds this app reads or saves to whose own notes aren't allowed yet: never opened, asking for
   * more than was allowed, or blocked by the data policy. The app shows their rows, but each kind's
   * own work (its import folders, its asks in Next) waits until it is, as anything unseen does.
   */
  kindsToAllow(spec: AppSpec): KindToAllow[] {
    if (this.frozen) return [];
    const paths = spec.panels.flatMap(({ panel: p }) => [p.kind?.path, p.target?.kind === "list" ? p.target.at : undefined]);
    return [...new Set(paths)].flatMap((path) => {
      const k = path === undefined || path === this.appPath ? undefined : this.kindToAllow(path);
      return k ? [k] : [];
    });
  }

  /** A kind note as kindsToAllow says it; undefined when it is allowed, or isn't a kind. */
  private kindToAllow(path: string): KindToAllow | undefined {
    const env = this.env;
    const fm = env.frontmatter(path);
    const kind = fm ? readSpec(fm, { now: env.now(), notes: env.notes, path })?.spec : undefined;
    if (!kind?.kind) return undefined;
    const wanted = permissionsOf(kind, path);
    const verdict = env.verdict?.(kind, wanted, { appPath: path, dataPath: defaultDataPath(path), hostPath: path });
    const blocked = !!verdict?.violations.length;
    // The background acts only for a note that was allowed, which an opened one is even when it asks for nothing.
    if (!blocked && env.granted(path) !== undefined && env.isGranted(path, wanted, verdict?.asked)) return undefined;
    const asked = verdict?.asked ?? wanted;
    const folders = kind.kind.imports.flatMap((m) => (m.folder === undefined ? [] : [m.folder]));
    const reads = new Set(folders.map((f) => `read:${f}`));
    const adds = [
      ...folders.map((f) => `Read each file in ${f} into its rows, now and as new ones come`),
      ...asked.filter((p) => !reads.has(p)).map(describePermission),
      `Ask in Next about a planned row whose time passed with nothing settling it${folders.length ? ", and about rows from a file to check" : ""}`,
    ];
    return { path, name: basename(path), adds, asked, blocked };
  }

  /** What the what-if's card does, through the app shown ahead; Keep's Undo through the app as it is now. */
  private aheadActions(): AheadActions {
    const env = this.env;
    const live = env.ahead!.live;
    return {
      remove: async ({ note, list, row }) => {
        const done = await env.store!(note.dataPath, note.owner).delete(list, { id: rowIdOf(row), shown: row });
        if ("refused" in done) env.notify("That what-if row is gone");
      },
      keep: (rows) => keep(env, this.appPath, rows),
      discard: () => discard(env, whatIfNotes(this.spec!, this.appPath, this.dataPath)),
      ...(live.undo && { undo: (entry: string) => live.undo!(entry) }),
      ...(env.backToNow && { back: env.backToNow }),
    };
  }

  /** Fills the what-if's card again once changes stop coming. */
  aheadSoon(): void {
    window.clearTimeout(this.aheadTimer);
    this.aheadTimer = window.setTimeout(() => void this.checkAhead(), 50);
  }

  /** Shown ahead: the what-if rows there are now, and what the app's alerts and rules would do on the way to the time shown. */
  async checkAhead(): Promise<void> {
    const env = this.env;
    const ahead = env.ahead;
    const spec = this.spec;
    const card = this.aheadCard;
    const ledger = env.data.ledger;
    const check = ++this.aheadChecks;
    if (!ahead || !spec || !card || !ledger) return;
    const notes = whatIfNotes(spec, this.appPath, this.dataPath);
    const rows = await whatIfRows(ledger, notes, (path) => env.frontmatter(path));
    const r = watches(spec) ? await lookAhead(env, ahead.live.data, spec, this.files(), notes).catch(() => undefined) : undefined;
    if (check !== this.aheadChecks || card !== this.aheadCard) return;
    ahead.marked?.(rows.map((r) => toTime(r.row.at)).filter((t): t is number => t !== undefined));
    card.fill({ rows, ...(r && { lines: aheadLines(r, spec, ahead.live.now(), this.current()), ...(r.cut && { cutAt: r.to }) }), errors: r?.errors ?? [] });
  }

  /**
   * In a kind's own tab, as it is now: the rows read from a file that no one accepted or set aside
   * yet, how they pair with what was logged, and a way to settle them.
   */
  async checkReconcile(): Promise<void> {
    const ledger = this.env.data.ledger;
    const kind = this.spec?.kind;
    const check = ++this.reconcileChecks;
    if (!ledger || !this.env.store || this.hosting || this.frozen || !kind) return;
    const state = await ledger.state(this.dataPath, this.env.frontmatter(this.appPath) ?? {});
    if (check !== this.reconcileChecks || kind !== this.spec?.kind) return;
    this.reconcileCard?.remove();
    this.reconcileCard = undefined;
    const r = reconcileOf(state.lists.get(kind.name)?.rows ?? [], kind.match);
    const host = r && attentionSection(this.shell);
    if (!r || !host) return;
    this.reconcileCard = renderReconcile(host, r, cardFields(this.env.frontmatter(this.appPath)?.fields, this.env.now()), {
      accept: (open) => this.writes.settleRows(kind.name, open, false, kind.match),
      dismiss: (rows) => this.writes.settleRows(kind.name, rows.map((row) => ({ row })), true),
    }, this);
  }

  /**
   * What `view: reconcile` shows of the kind its panel reads, as the kind's own note does (see
   * checkReconcile), with Accept and Not mine writing there; undefined where nothing may be changed.
   */
  async reconcileOf(p: Panel): Promise<Awaited<ReturnType<NonNullable<PanelCtx["reconcile"]>>>> {
    const env = this.env;
    const ledger = env.data.ledger;
    const ref = p.kind;
    if (!ledger || !ref || this.frozen) return undefined;
    const kindFm = env.frontmatter(ref.path);
    const state = await ledger.state(kindFiles(ref).dataPath, kindFm ?? {});
    const rule = ruleOf(kindFm);
    const card = reconcileOf(state.lists.get(ref.name)?.rows ?? [], rule);
    const waiting = card ? undefined : await this.unread(ref.path, state);
    return {
      card,
      ...(waiting && { waiting }),
      fields: cardFields(kindFm?.fields, env.now()),
      accept: (open) => this.writes.settleRows(ref.name, open, false, rule, p),
      dismiss: (rows) => this.writes.settleRows(ref.name, rows.map((row) => ({ row })), true, {}, p),
    };
  }

  /**
   * Files in a kind's import folders that hold rows the kind doesn't have (nor had and lost to an
   * undo), while the kind isn't allowed to read them: said so; undefined when none waits.
   */
  private async unread(kindPath: string, state: { lists: Map<string, { rows: Row[] }>; gone(list: string, id: string): boolean }): Promise<string | undefined> {
    const k = this.kindToAllow(kindPath);
    const fm = this.env.frontmatter(kindPath);
    const kind = !k || k.blocked || !fm ? undefined : readSpec(fm, { now: this.env.now(), notes: this.env.notes, path: kindPath })?.spec?.kind;
    if (!k || !kind) return undefined;
    const has = new Set((state.lists.get(kind.name)?.rows ?? []).map(rowIdOf));
    const files: string[] = [];
    for (const map of kind.imports) {
      for (const path of map.folder === undefined ? [] : (this.env.data.host.filesIn?.(map.folder) ?? []).filter(importable)) {
        const text = await this.env.data.host.readFile(path).catch(() => "");
        if (fileRowIds(kind, map, { path, text }, this.env.now()).some((id) => !has.has(id) && !state.gone(kind.name, id))) files.push(path);
      }
    }
    if (!files.length) return undefined;
    const where = [...new Set(files.map((f) => f.slice(0, f.lastIndexOf("/"))))].join(" and ");
    return files.length === 1 ? `${basename(files[0])} waits in ${where}; allow ${k.name} to read it.` : `${files.length} files wait in ${where}; allow ${k.name} to read them.`;
  }

  /** Says so when the data note was edited by hand since the app's log was last written into it, with Import and Discard. */
  async checkHandEdit(): Promise<void> {
    const ledger = this.env.data.ledger;
    // Only where the app's lists are kept in the ledger; a lens keeps no data note of its own. A what-if changes no data note.
    if (!ledger || !this.env.store || this.hosting?.kind === "lens" || this.env.ahead) return;
    const dataPath = this.dataPath;
    const appFm = this.env.frontmatter(this.appPath) ?? {};
    const state = await ledger.state(dataPath, appFm);
    const ops = state.handEdited ? await ledger.importOps(dataPath, appFm) : [];
    if (this.dataPath !== dataPath) return;
    this.handEdit?.remove();
    this.handEdit = undefined;
    const header = this.shell.querySelector<HTMLElement>(".gz-header");
    if (!state.handEdited || !header) return;
    const checklists = new Set(this.spec?.panels.filter((ps) => ps.panel.view === "checklist").map((ps) => checklistList(ps.panel)));
    const words = editWords(ops, checklists);
    this.handEdit = renderHandEdit(header, basename(dataPath), words.length ? words : ["its layout only"], {
      import: async () => {
        await ledger.write(dataPath, ops);
        await this.env.data.snapshotNow(dataPath, true);
      },
      discard: () => this.env.data.snapshotNow(dataPath, true),
    });
  }

  /**
   * In the app's own tab, as it is now, says so when its keys renamed a field, a choice or a list
   * that its saved rows still use, with a way to bring the rows along; unless the person chose to
   * leave that rename as it is. Read from the ledger's lists, as the panels are.
   */
  async checkRenames(): Promise<void> {
    const ledger = this.env.data.ledger;
    const spec = this.spec;
    const check = ++this.renameChecks;
    if (!ledger || !this.env.store || this.hosting || this.frozen || !spec) return;
    const dataPath = this.dataPath;
    const appFm = this.env.frontmatter(this.appPath) ?? {};
    const state = await ledger.state(dataPath, appFm);
    if (check !== this.renameChecks || spec !== this.spec) return;
    this.renameCard?.remove();
    this.renameCard = undefined;
    const rename = findRenames(spec, state.lists, appFm).find((r) => !this.env.leftAlone?.(renameKey(this.appPath, r)));
    const header = this.shell.querySelector<HTMLElement>(".gz-header");
    if (!rename || !header) return;
    this.renameCard = renderRename(header, basename(dataPath), rename, {
      fix: () => this.writes.moveRenamed(rename),
      leave: () => {
        this.env.leaveAlone?.(renameKey(this.appPath, rename));
        void this.checkRenames();
      },
    });
  }
}

/**
 * Where what waits for the person is drawn in an app: laid out by role, the section for it after the
 * answer and the line to add things, made there when no panel has drawn one; on the grid, the header.
 * Undefined while the app shows no panels.
 */
export function attentionSection(shell: HTMLElement): HTMLElement | undefined {
  const child = (el: Element, cls: string) => [...el.children].find((c) => c.classList.contains(cls)) as HTMLElement | undefined;
  const body = child(shell, "gz-body");
  if (!body) return child(shell, "gz-grid") && child(shell, "gz-header");
  const own = child(body, "gz-attention");
  if (own) return own;
  const section = body.createEl("section", { cls: "gz-attention" });
  const after = [...body.children].filter((c) => c.classList.contains("gz-answer") || c.classList.contains("gz-compose")).at(-1);
  body.insertBefore(section, after ? after.nextSibling : body.firstChild);
  return section;
}
