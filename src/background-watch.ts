import { panelKey, type Verdict } from "./flows.ts";
import { rowIdOf } from "./ledger-store.ts";
import type { FiredStore } from "./background-fired.ts";
import type { AppEntry, Background, BackgroundEnv, StatusItem } from "./background.ts";
import { compileWhere, matches, rowsOf, type Row } from "./data.ts";
import { alertRowsText } from "./format.ts";
import { stableJson } from "./hash.ts";
import type { Then } from "./spec.ts";
import type { AlertFeed, AlertItem } from "./alert-keys.ts";

/** What watching apps' pinned and alerting panels needs of the Background. */
export interface WatchHost {
  apps: ReadonlyMap<string, AppEntry>;
  fired: FiredStore;
  granted: (entry: AppEntry) => boolean;
  verdictNow: (entry: AppEntry) => Verdict | undefined;
  evaluate: Background["evaluate"];
  runThen: Background["runThen"];
  /** An app that isn't allowed now: paused or forgotten (see background-pauses.ts). */
  pauseOrForget: (entry: AppEntry) => Promise<void>;
  say: (message: string) => void;
}

/**
 * The status bar items and alerts of every allowed app: evaluates its pinned and alerting panels,
 * tells an alert when it turns true, runs its `then` for what is new, and publishes both lists.
 */
export class Watch {
  private env: BackgroundEnv;
  private apps: ReadonlyMap<string, AppEntry>;
  private fired: FiredStore;
  private granted: WatchHost["granted"];
  private verdictNow: WatchHost["verdictNow"];
  private evaluate: WatchHost["evaluate"];
  private runThen: WatchHost["runThen"];
  private pauseOrForget: WatchHost["pauseOrForget"];
  private say: WatchHost["say"];
  /** Status bar items and alerts true now, by watched panel key; the status list last published. */
  private pins = new Map<string, StatusItem>();
  private active = new Map<string, AlertItem>();
  private status = "";
  /** Whether each alert was true when last evaluated this session (unknown at first, so one already true is told). */
  private alertOn = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  private alertsShown = "[]";

  /** Alerts true now across the vault, for `view: alerts`. */
  readonly alerts: AlertFeed = {
    list: () => this.inOrder(this.active),
    subscribe: (cb) => {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    },
  };

  constructor(env: BackgroundEnv, host: WatchHost) {
    this.env = env;
    this.apps = host.apps;
    this.fired = host.fired;
    this.granted = host.granted;
    this.verdictNow = host.verdictNow;
    this.evaluate = host.evaluate;
    this.runThen = host.runThen;
    this.pauseOrForget = host.pauseOrForget;
    this.say = host.say;
  }

  /** The background stopped: nothing is shown, and nobody is told. */
  clear(): void {
    this.pins.clear();
    this.active.clear();
    this.listeners.clear();
  }

  /** Evaluates an app's pinned and alerting panels; asked again meanwhile, it runs once more after. */
  check(entry: AppEntry): Promise<void> {
    if (entry.checking) {
      entry.again = true;
      return entry.checking;
    }
    entry.checking = (async () => {
      try {
        do {
          entry.again = false;
          await this.checkOnce(entry);
        } while (entry.again && this.apps.get(entry.path) === entry);
      } finally {
        entry.checking = undefined;
      }
    })();
    return entry.checking;
  }

  /** A panel that can't be evaluated now (a failed fetch) keeps what it showed last. */
  private async checkOnce(entry: AppEntry): Promise<void> {
    if (entry.watched.length === 0) return;
    if (!this.granted(entry)) return this.pauseOrForget(entry);
    const now = this.env.now();
    entry.checkedAt = now.getTime();
    for (const { key, ps } of entry.watched) {
      const r = await this.evaluate(entry.path, ps);
      if (this.apps.get(entry.path) !== entry) return;
      if (!("panel" in r)) continue;
      const p = r.panel;
      const title = p.title ?? p.label ?? entry.name;
      const { shown } = r;
      if (p.pin === "status") this.pins.set(key, { appPath: entry.path, text: `${title}: ${shown}`, title: entry.name });
      if (p.alert === undefined) continue;
      const rows = typeof p.alert === "string" ? undefined : rowsOf(r.rows).filter(compileWhere(p.alert, now));
      const matching = rows?.length;
      const on = matching === undefined ? matches(r.value, p.alert as string, now) : matching > 0;
      // Whether it was told is kept with what alerts ran for, so a restart doesn't tell it again.
      const fired = await this.fired.state();
      const toldKey = `${key}\ntold`;
      const kept = fired[toldKey];
      const was = this.alertOn.get(key) ?? (kept && "on" in kept ? kept.on : undefined);
      this.alertOn.set(key, on);
      if (on !== was) {
        if (on) fired[toldKey] = { on: true };
        else delete fired[toldKey];
        this.fired.save();
      }
      if (p.then) await this.alertThen(entry, key, p.then, r.value, on, rows);
      if (this.apps.get(entry.path) !== entry) return;
      if (!on) {
        this.active.delete(key);
        continue;
      }
      const text = matching === undefined ? shown : `${matching} ${matching === 1 ? "row" : "rows"}`;
      this.active.set(key, { appPath: entry.path, app: entry.name, title, text });
      // Told when it turns true, not again until it has been false, a restart between included.
      if (was !== true) {
        const told = `${entry.name}: ${title}${matching === undefined ? ` ${text}` : `: ${alertRowsText(p, rows!, now)}`}`;
        if (!this.env.quietAlerts?.()) this.say(told);
        if (this.env.runsBackground()) this.env.sink.alert?.({ app: entry.name, panel: title, text: told, label: this.verdictNow(entry)?.alertLabels[panelKey(ps)] });
      }
    }
    this.publish();
  }

  /**
   * Runs an alert's `then` for what is new since it last ran: once when a condition on its value
   * turns true, and once for each row that newly matches a condition on rows. With nothing kept for
   * the alert yet (the app was just allowed, the panel is new or was edited), it only notes what is
   * true now, so already-true alerts don't all run at once.
   */
  private async alertThen(entry: AppEntry, key: string, then: Then, value: unknown, on: boolean, rows: Row[] | undefined): Promise<void> {
    if (!this.env.runsBackground()) return;
    const fired = await this.fired.state();
    const before = fired[key];
    if (rows === undefined) {
      fired[key] = { on };
      this.fired.save();
      if (before && "on" in before && !before.on && on) await this.runThen(entry.path, then, { value });
      return;
    }
    const ids = rows.map(rowId);
    fired[key] = { rows: [...new Set(ids)] };
    this.fired.save();
    if (!before || !("rows" in before)) return;
    const seen = new Set(before.rows);
    // A row's then saves under an id from the alert and the row as it is now, the same on any runner;
    // a value turning true has no such row, and its then saves as a save does.
    for (const [i, row] of rows.entries()) {
      if (!seen.has(ids[i])) await this.runThen(entry.path, then, { ...row, value }, [], undefined, `${key}\n${ids[i]}\n${stableJson(row)}`);
    }
  }

  /** Moves whether an app's alerts were true to another path (a rename). */
  move(from: string, to: string): void {
    const prefix = `${from}\n`;
    for (const [key, on] of [...this.alertOn]) {
      if (!key.startsWith(prefix)) continue;
      this.alertOn.delete(key);
      this.alertOn.set(to + key.slice(from.length), on);
    }
  }

  /** Takes an app's status items and alerts off the screen; what it was doing is kept. */
  hide(path: string): void {
    let dropped = false;
    for (const map of [this.pins, this.active]) {
      for (const key of map.keys()) {
        if (!key.startsWith(`${path}\n`)) continue;
        map.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.publish();
  }

  /** Drops an app's status items, alerts and whether they were true, but the panels in `keep`; whether any went. Publishing is left to the caller. */
  drop(path: string, keep: ReadonlySet<string>): boolean {
    let dropped = false;
    for (const map of [this.pins, this.active, this.alertOn]) {
      for (const key of map.keys()) {
        if (!key.startsWith(`${path}\n`) || keep.has(key)) continue;
        map.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  /** Tells the status bar and the alert views what changed. */
  publish(): void {
    const status = this.inOrder(this.pins);
    const json = JSON.stringify(status);
    if (json !== this.status) {
      this.status = json;
      this.env.sink.setStatus(status);
    }
    const alerts = JSON.stringify(this.alerts.list());
    if (alerts === this.alertsShown) return;
    this.alertsShown = alerts;
    for (const cb of [...this.listeners]) cb();
  }

  /** Items by app path, then in the order the app's panels are written. */
  private inOrder<T>(items: Map<string, T>): T[] {
    return [...this.apps.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .flatMap((e) => e.watched.flatMap((w) => (items.has(w.key) ? [items.get(w.key)!] : [])));
  }
}

/**
 * A row as an alert's `then` remembers it: its note (and task text), else its id in the app's
 * ledger, else when it was saved, else all of it.
 */
function rowId(row: Row): string {
  if (typeof row.path === "string") return typeof row.text === "string" ? `${row.path}\n${row.text}` : row.path;
  const id = rowIdOf(row);
  if (id) return `id:${id}`;
  if (typeof row.at === "string") return `at:${row.at}`;
  return stableJson(row);
}
