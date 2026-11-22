import { panelKey, type Verdict } from "./flows.ts";
import { rowId as ledgerRowId } from "./ledger.ts";
import { fillLine, runActions, tickItem, type ActionDeps, type ActionResult } from "./actions.ts";
import { describeAhead, type Actor } from "./activity.ts";
import type { AppEntry, Background, BackgroundEnv, Evaluation } from "./background.ts";
import { captureTargets, logTime, ownAt, parseLine, plannedText, swallowed, whenText, type CaptureIndex, type Parsed } from "./capture.ts";
import { Overlay, recordingDeps, type DryStep } from "./dryrun.ts";
import type { Row } from "./data.ts";
import {
  answerParams, appOfShortcut, appsNamed, captureCovers, formRow, pickItem, readCallbacks, readLink, shortcutId, shortcutLink, withParams,
  type Callbacks, type ShortcutLink,
} from "./links.ts";
import { panelEntries } from "./expand.ts";
import { isPlainObject } from "./keys.ts";
import { resolvePanel, type AppSpec, type Panel, type PanelSpec, type Then } from "./spec.ts";
import { aliasShortcut } from "./views/alerts.ts";
import { clearance, rank, released } from "./policy.ts";
import { basename, storeTarget } from "./store.ts";
import { InputRef, valueProblem } from "./template.ts";

/** How many shortcuts one action may run through `then`, one app after another. */
export const MAX_CHAIN = 4;
/** How many times one `then` may run in an hour; more is a loop going through data. */
export const MAX_RUNS_PER_HOUR = 20;

/** How running a shortcut went: whether it ran, why not (as the notice told it), and the activity log's entry for what it changed. */
export interface ShortcutResult {
  ok: boolean;
  error?: string;
  entryId?: string;
  /** What a shortcut that answers answered: its value, and as shown. */
  value?: unknown;
  shown?: string;
  /** With `quiet`, what the run would have told in a notice (its `notify`, else that it's done), for the caller to tell once. */
  told?: string;
}

/** A shortcut that answers: whether it had a value, or why not. */
function answered(r: Evaluation): ShortcutResult {
  return "shown" in r ? { ok: true, value: r.value, shown: r.shown } : { ok: false, error: "waiting" in r ? `it waits for ${r.waiting}` : r.error };
}

/** What a link brings besides a form's values: the key it carries and where it wants word back. */
export interface LinkCall {
  key?: string;
  callbacks: Callbacks;
  /** Where an answer goes besides the link's own callback (gizmod's HTTP), checked against the data policy. */
  sink?: "gizmod";
  /** A capture link whose key covers this shortcut's name: it runs as a keyed link does. */
  captureKeyed?: boolean;
}

/** A dry run in progress: the copies of the notes it touched, and what each app would do. */
export interface DryRun {
  overlay: Overlay;
  steps: DryStep[];
}

/** A dry run as lines to read: each change, the apps a `then` reaches named, and what each would tell. */
export function dryLines(steps: DryStep[]): string[] {
  const lines = steps.flatMap((step, i) => {
    const of = i > 0 ? `${step.app}: ` : "";
    return [
      ...step.changes.map((c) => `${of}${describeAhead(c)}`),
      ...step.remarks.map((r) => `${of}${r}`),
      // A notice is said to be one, so one that refuses isn't read as something the run does.
      ...step.notices.map((n) => `Tell you: ${i > 0 && !n.startsWith(`${step.app}:`) ? `${step.app}: ${n}` : n}`),
    ];
  });
  if (!lines.length) return ["Nothing would change"];
  // A row planned on every day of a range is one save said many times; it is said once, with the count.
  const runs: { line: string; n: number }[] = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last?.line === line) last.n++;
    else runs.push({ line, n: 1 });
  }
  return runs.map(({ line, n }) => (n > 1 ? `${line}, ${n} times` : line));
}

/** A shortcut on a panel that shows one value answers with it instead of acting. */
function answers(p: Panel): boolean {
  return p.view === "number" || p.view === "progress";
}

/** What running shortcuts needs of the Background: the apps it knows, and what it works out about them. */
export interface ShortcutsHost {
  apps: ReadonlyMap<string, AppEntry>;
  /** An app by its path: as known, else read into the index while the background runs. */
  lookup: (path: string) => AppEntry | undefined;
  granted: (entry: AppEntry) => boolean;
  valuesOf: (appPath: string, spec: AppSpec, now: Date) => Record<string, unknown>;
  evaluate: Background["evaluate"];
  verdictNow: (entry: AppEntry) => Verdict | undefined;
  say: (message: string) => void;
}

/**
 * Runs apps' shortcuts without opening them: from commands, links (keyed or asking first), capture
 * lines, gizmod's HTTP and other apps' `then`, with their limits, and works out a dry run of any of
 * them. Publishes the shortcuts as commands.
 */
export class Shortcuts {
  private env: BackgroundEnv;
  private apps: ReadonlyMap<string, AppEntry>;
  private lookup: ShortcutsHost["lookup"];
  private granted: ShortcutsHost["granted"];
  private valuesOf: ShortcutsHost["valuesOf"];
  private evaluate: ShortcutsHost["evaluate"];
  private verdictNow: ShortcutsHost["verdictNow"];
  private say: ShortcutsHost["say"];
  /** The command list last published, as JSON. */
  private commands = "";
  /** When each `then` ran in the last hour, by source app and target shortcut; and each shortcut's link runs. */
  private runs = new Map<string, number[]>();
  /** A link without its key is waiting for the person's answer. */
  private asking = false;

  constructor(env: BackgroundEnv, host: ShortcutsHost) {
    this.env = env;
    this.apps = host.apps;
    this.lookup = host.lookup;
    this.granted = host.granted;
    this.valuesOf = host.valuesOf;
    this.evaluate = host.evaluate;
    this.verdictNow = host.verdictNow;
    this.say = host.say;
  }

  /** The names a capture line can start with, from every app's shortcuts. */
  captureIndex(): CaptureIndex {
    return captureTargets(this.apps.values());
  }

  /** What a capture line would run and, worked out by a dry run, what that would change and tell. */
  async previewLine(line: string): Promise<{ parsed: Parsed; effects?: string[] }> {
    const parsed = parseLine(line, this.captureIndex(), this.env.now());
    if (!parsed.ok) return { parsed };
    return { parsed, effects: dryLines(await this.dryRun(parsed.target.path, parsed.target.shortcut, parsed.params)) };
  }

  /**
   * Runs a capture line (`spend 14.5 food lunch`): the shortcut it names, with the values it types,
   * as that shortcut's command would with a link's values. A line that can't be read runs nothing
   * and says why only in its result, for the place it was typed to show.
   */
  /** With `quiet`, what it did isn't told in a notice but given back as `told`, so a window that ran it tells it once, with Undo. */
  async capture(line: string, actor: Actor = "shortcut", quiet = false): Promise<ShortcutResult & { parsed: Parsed }> {
    const parsed = parseLine(line, this.captureIndex(), this.env.now());
    if (!parsed.ok) return { ok: false, error: parsed.error, parsed };
    return { ...(await this.runShortcut(parsed.target.path, parsed.target.shortcut, actor, parsed.params, undefined, undefined, undefined, undefined, quiet)), parsed };
  }

  /**
   * Answers `obsidian://gizmo?key=…&line=…`: a capture line sent from outside Obsidian (a phone's
   * shortcut, a launcher). A key copied with "Copy capture link" runs the names it was made for
   * unattended, as a shortcut's keyed link does; any other line asks first, showing what it would
   * do. As for any link, a line that can't run is told only in Obsidian.
   */
  async runCaptureLink(params: Record<string, string>): Promise<void> {
    const line = (params.line ?? "").trim();
    const callbacks = readCallbacks(params);
    if ("problem" in callbacks) return this.say(`Refused a capture link: ${callbacks.problem}`);
    const parsed = parseLine(line, this.captureIndex(), this.env.now());
    if (!parsed.ok) return this.say(`A capture link couldn't run “${line}”: ${parsed.error}`);
    const granted = params.key !== undefined ? this.env.captureKey(params.key) : undefined;
    const { path, shortcut } = parsed.target;
    // A name that now reaches another shortcut than the one it was copied for asks again.
    const captureKeyed = captureCovers(granted, parsed.target);
    // Run unasked, a line whose text took the rest of it would save what nobody saw first.
    const guess = captureKeyed ? swallowed(parsed) : undefined;
    if (guess) return this.say(`A capture link couldn't run “${line}”: ${guess}`);
    await this.runShortcut(path, shortcut, "link", parsed.params, undefined, { callbacks, captureKeyed });
  }

  /**
   * Runs a shortcut asked for from outside Obsidian (gizmod's HTTP): with `key`, as its copied link
   * runs, which only the key it carries lets run unattended; with `captureKeyed`, a capture key's
   * name; `trusted` (the computer's own user) as its command. Gives what it answered, if it answers.
   */
  runFrom(appPath: string, shortcut: string, opts: { params?: Record<string, string>; key?: string; captureKeyed?: boolean; trusted?: boolean }): Promise<ShortcutResult> {
    if (opts.trusted) return this.runShortcut(appPath, shortcut, "shortcut", opts.params);
    return this.runShortcut(appPath, shortcut, "link", opts.params ?? {}, undefined, { key: opts.key, callbacks: {}, captureKeyed: opts.captureKeyed, sink: "gizmod" });
  }

  /** The app a name or path finds, as a link names it; undefined, with why, when none or several. */
  appFor(name: string): { path: string } | { error: string } {
    const found = appsNamed(this.apps, name);
    if (found.length === 0) return { error: `No app called “${name}”` };
    if (found.length > 1) return { error: `Several apps are called “${name}”; use its path` };
    return { path: found[0].path };
  }

  /** Runs the command `<app path>:<shortcut>`. */
  runCommand(id: string): Promise<ShortcutResult> {
    const cut = id.lastIndexOf(":");
    return this.runShortcut(id.slice(0, cut), id.slice(cut + 1), "shortcut");
  }

  /**
   * Answers `obsidian://gizmo?app=…&do=…&field=value…`. Any web page can send one, so it only
   * runs a panel its author marked with `shortcut`, in an app the user already allowed; the other
   * parameters only fill that form's fields, checked against their types.
   */
  async runUri(params: Record<string, string>): Promise<void> {
    const { app: name, shortcut, key, fields } = readLink(params);
    const callbacks = readCallbacks(params);
    if ("problem" in callbacks) return this.say(`Refused a link to “${shortcut}” in ${name}: ${callbacks.problem}`);
    // Nothing goes back to the caller until the link is allowed, so a page can't find out which apps there are.
    const found = appsNamed(this.apps, name);
    if (found.length === 0) return this.say(`No app called “${name}”`);
    if (found.length > 1) return this.say(`Several apps are called “${name}”; use its path`);
    await this.runShortcut(found[0].path, shortcut, "link", fields, undefined, { key, callbacks });
  }

  /** Every app's shortcuts with the link that runs each, whether or not the app is allowed yet. */
  shortcutLinks(): ShortcutLink[] {
    return [...this.apps.values()]
      .flatMap((e) => [...e.shortcuts].map(([shortcut, ps]): ShortcutLink => {
        const p = ps.panel;
        const apps = this.apps;
        const env = this.env;
        const full = shortcutLink(apps, e.path, shortcut, "");
        return {
          path: e.path, app: e.name, shortcut, label: labelOf(p, shortcut), view: p.view, fields: shortcutFields(p),
          // A key is made, and data.json written, only when a link is copied, not each time the list is drawn.
          get link() { return shortcutLink(apps, e.path, shortcut, env.linkKey(e.path, shortcut, true)!); },
          address: full.slice(0, full.indexOf("&key=")),
          allowed: this.granted(e),
          answers: answers(p),
        };
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.shortcut.localeCompare(b.shortcut));
  }

  /**
   * Runs an app's shortcut panel without opening the app: a button's actions, or a form's with the
   * values a link gives (a command has none, so a form opens its app to be filled in). Notifies the
   * result: the panel's own `notify`, else that it's done.
   */
  /** `seed` makes the rows it saves the same rows wherever it runs: an alert's then on two runners at once saves one. */
  private async runShortcut(
    appPath: string, shortcut: string, actor: Actor, params?: Record<string, string>, chain?: string[], link?: LinkCall, dry?: DryRun, seed?: string, quiet = false,
  ): Promise<ShortcutResult> {
    const entry = this.apps.get(appPath);
    const ps = entry?.shortcuts.get(shortcut);
    // In a dry run, what it would tell is kept with what it would change, and nothing is shown or opened.
    const step: DryStep = { app: entry?.name ?? basename(appPath), what: shortcut, changes: [], notices: [], remarks: [] };
    dry?.steps.push(step);
    const say = (message: string) => (dry ? void step.notices.push(message) : this.say(message));
    const fail = (message: string): ShortcutResult => {
      say(message);
      return { ok: false, error: message };
    };
    const openApp = (path: string) => (dry ? void step.remarks.push(`Open ${basename(path)} for you to fill in`) : this.env.sink.openApp(path));
    const problem = entry?.broken.get(shortcut);
    if (entry && problem !== undefined) return fail(`“${entry.name}”'s shortcut “${shortcut}” has a problem: ${problem}`);
    if (!entry || !ps) return fail(`${entry?.name ?? basename(appPath)} has no shortcut “${shortcut}”`);
    if (!this.granted(entry)) return fail(`Open ${entry.name} once to allow it`);
    const now = this.env.now();
    const r = resolvePanel(ps, this.valuesOf(entry.path, entry.spec, now));
    // Another app's trigger never opens an app: what it can't run is told instead.
    const triggered = chain !== undefined;
    if (!r.panel) {
      if (triggered) return fail(`${entry.name}: “${shortcut}” waits for a choice in the app, so it can't run from ${by(actor)}`);
      openApp(entry.path);
      return { ok: false, error: `“${shortcut}” waits for a choice in ${entry.name}` };
    }
    const p = r.panel;
    const label = labelOf(p, shortcut);
    step.what = label;
    if (answers(p)) {
      if (!dry) return this.answer(entry, ps, p, shortcut, actor, link);
      step.remarks.push(`Answer with the value of “${label}”, changing nothing`);
      return { ok: true };
    }
    let input: Row = {};
    if (triggered && p.view === "button" && params && Object.keys(params).length) {
      return fail(`${entry.name}: “${shortcut}” is a button and takes no values; take fill out of ${by(actor)}'s then`);
    }
    // Another app's then fills fields only; what it saves is logged when it runs.
    const when: { at?: Date; plan?: Date[] } | { error: string } = triggered ? {} : whenOf(p, shortcut, params, now);
    if ("error" in when) return fail(`${entry.name}: ${when.error}`);
    if (p.view === "form" || p.view === "checklist") {
      const form = p.view === "form";
      if (!params && triggered) return fail(`${entry.name}: “${shortcut}” is a ${p.view}; give ${by(actor)}'s then a fill with ${form ? "its values" : "item"}`);
      if (!params) {
        openApp(entry.path);
        say(`${entry.name}: ${form ? "fill in the form" : "tick an item"}`);
        return { ok: false, error: form ? "the form needs its values" : "say which item to tick" };
      }
      // Logged for another day, a field's default of today means that day.
      const read = readParams(p, params, when.at ?? now);
      if ("error" in read) return fail(`${entry.name}: ${read.error}`);
      input = read.row;
    }
    const cb = link?.callbacks ?? {};
    let allowed: "keyed" | "asked" | false = false;
    if (actor === "link" && !dry) {
      const given = params ?? {};
      const lines = Object.keys(input).filter((k) => Object.hasOwn(given, k)).map((k) => `${k}: ${String(input[k])}`);
      if (when.at) lines.push(`at: ${plannedText({ at: when.at, plan: when.plan }, now) ?? whenText(when.at, now)}`);
      if (cb.to) lines.push(`Then it tells ${cb.to} it ran`);
      const effects = async () => dryLines(await this.dryRun(entry.path, shortcut, params));
      allowed = await this.linkMayRun(entry, p, shortcut, link, lines, `A link asks to run “${label}” in ${entry.name}`, effects);
      if (!allowed) return { ok: false, error: "the link wasn't allowed to run" };
    }
    const trail = chain ?? [shortcutId(entry.path, shortcut)];
    // Said before what its `then` runs says, in the order they happen.
    let told = false;
    let toldText: string | undefined;
    const done = () => {
      if (told || p.notify || dry) return;
      told = true;
      const text = `${entry.name}: ${label} done${triggered ? ` for ${by(actor)}` : ""}`;
      if (quiet) toldText = text;
      else say(text);
    };
    let result: ActionResult;
    if (p.view === "checklist") {
      const base = this.env.actionDeps(entry.path, entry.dataPath, dry ? undefined : actor);
      result = await tickItem(p, String(input.item), { ...(dry ? recordingDeps(dry.overlay, base, step) : base), tellsFailure: true });
      const ticked = `${entry.name}: ${result.already ? `${String(input.item)} was already ticked` : `ticked ${String(input.item)}`}${triggered ? ` for ${by(actor)}` : ""}`;
      if (result.ok && quiet) toldText = ticked;
      else if (result.ok) say(ticked);
    } else {
      const base: ActionDeps = this.env.actionDeps(entry.path, entry.dataPath, dry ? undefined : actor);
      const deps: ActionDeps = {
        ...(dry ? recordingDeps(dry.overlay, base, step) : base),
        // Why it stopped is said once, below, naming the shortcut.
        tellsFailure: true,
        ...(quiet && { inPlace: true, quiet: true }),
        expect: entry.spec.expect,
        ...(when.at && { at: when.at }),
        ...(when.plan && { plan: when.plan }),
        ...(seed && { rowId: ledgerRowId(`then\n${seed}`) }),
        then: async (panel, ctx) => {
          done();
          if (panel.then) await this.runThen(entry.path, panel.then, ctx, trail, dry, seed);
        },
      };
      result = await runActions(p, input, deps);
      if (result.ok) done();
      if (quiet && result.told !== undefined) toldText = result.told;
    }
    const failed = `“${label}” didn't run${result.error ? `: ${result.error}` : ""}`;
    if (!result.ok) say(triggered ? `${entry.name}: ${failed}` : failed);
    if (dry) return { ok: result.ok };
    if (allowed && result.ok && cb.success) this.env.sink.openUrl(withParams(cb.success, { result: "done" }));
    // Only a link with its key hears why it failed; any other could be a page finding out what's there.
    if (allowed === "keyed" && !result.ok && cb.error) this.env.sink.openUrl(withParams(cb.error, { errorMessage: failed }));
    const entryId = await result.logged?.catch(() => undefined);
    return result.ok ? { ok: true, entryId, ...(toldText !== undefined && { told: toldText }) } : { ok: false, error: failed, entryId };
  }

  /**
   * A form shortcut's fields, with their types and the values a link that names none of them would
   * save, for a dry run to show and start from; undefined for a button or a shortcut that isn't there.
   */
  formStart(appPath: string, shortcut: string): { fields: Record<string, string | string[]>; row: Row } | undefined {
    const entry = this.apps.get(appPath);
    const ps = entry?.shortcuts.get(shortcut);
    if (!entry || !ps) return undefined;
    const now = this.env.now();
    const p = resolvePanel(ps, this.valuesOf(entry.path, entry.spec, now)).panel;
    if (p?.view === "checklist") {
      const items = (p.items ?? []).map(String);
      return { fields: { item: items }, row: { item: items[0] ?? "" } };
    }
    if (p?.view !== "form") return undefined;
    const fields = p.fields ?? p.schema ?? {};
    const filled = formRow(fields, p.fieldInfo, {}, now);
    return "row" in filled ? { fields, row: filled.row } : undefined;
  }

  /**
   * What running a shortcut would change and tell, app by app through its `then`s, worked out by
   * the same checks and writes as a real run against copies of the notes it touches. Nothing is
   * written, shown or opened, and the hourly limits are neither counted nor read.
   */
  async dryRun(appPath: string, shortcut: string, params?: Record<string, string>): Promise<DryStep[]> {
    const host = this.env.data.host;
    const overlay = new Overlay({
      frontmatter: (path) => this.env.frontmatter(path),
      text: (path) => host.readFile(path).catch(() => undefined),
      exists: (path) => host.fileInfo(path) !== undefined,
    });
    const steps: DryStep[] = [];
    await this.runShortcut(appPath, shortcut, params ? "link" : "shortcut", params, undefined, undefined, { overlay, steps });
    return steps;
  }

  /**
   * A number or progress panel's shortcut: its command tells its value in a notice, its link sends
   * the value back to the app that opened it (x-success). It is worked out only once the link may
   * run, so a link without its key fetches nothing until the person says so.
   */
  private async answer(entry: AppEntry, ps: PanelSpec, p: Panel, shortcut: string, actor: Actor, link: LinkCall | undefined): Promise<ShortcutResult> {
    const label = labelOf(p, shortcut);
    if (actor.startsWith("trigger:")) return this.failed(`${entry.name}: “${shortcut}” answers links with a value; a then can't run it`);
    const tell = (r: Evaluation): ShortcutResult => {
      this.say(`${entry.name}: ${label}: ${"shown" in r ? r.shown : "waiting" in r ? `waits for ${r.waiting}` : r.error}`);
      return answered(r);
    };
    if (actor !== "link") return tell(await this.evaluate(entry.path, ps));
    const cb = link?.callbacks ?? {};
    const lines = cb.to ? [`Its value goes to ${cb.to}`] : [];
    const allowed = await this.linkMayRun(entry, p, shortcut, link, lines, `A link asks for “${label}” from ${entry.name}`);
    if (!allowed) return { ok: false, error: "the link wasn't allowed to run" };
    if (link?.sink && !this.mayAnswerTo(entry, ps, p.title ?? p.label ?? entry.name, link.sink)) {
      return this.failed(`${entry.name}: your data policy keeps “${label}” from ${link.sink}'s answers`);
    }
    const r = await this.evaluate(entry.path, ps);
    if (!("shown" in r)) {
      const why = "waiting" in r ? `it waits for ${r.waiting}` : r.error;
      if (allowed === "keyed" && cb.error) this.env.sink.openUrl(withParams(cb.error, { errorMessage: why }));
      return this.failed(`${entry.name}: couldn't answer “${label}”: ${why}`);
    }
    if (!cb.success) return tell(r);
    this.env.sink.openUrl(withParams(cb.success, answerParams(r.shown, r.value)));
    this.env.logSent({ app: entry.path, actor, what: label, changes: [], sent: { to: cb.to!, shown: r.shown } });
    return answered(r);
  }

  /** Whether the applied data policy lets an answer's value go to `sink`: released there, or labelled no higher than it clears. */
  private mayAnswerTo(entry: AppEntry, ps: PanelSpec, title: string, sink: "gizmod"): boolean {
    const policy = this.env.policy?.()?.rules;
    if (!policy) return true;
    if (released(policy, entry.path, title, sink)) return true;
    // A value whose label can't be found isn't taken for public.
    const label = this.verdictNow(entry)?.answerLabels[panelKey(ps)];
    const cleared = clearance(policy, sink);
    return label !== undefined && cleared !== undefined && rank(label) <= rank(cleared);
  }

  /**
   * Whether a link may run a shortcut. Any web page, email or chat message can send one, so: at most
   * MAX_RUNS_PER_HOUR an hour, and without the key its copied link carries, only once the person
   * says Run in a window showing `lines` (the values it gives, where word goes back) and what it
   * would change (`effects`, from a dry run). A keyed link
   * that sends word back asks the first time it would go to an app, and remembers that app with
   * the key when told Always; Cancel there opens its x-cancel. One window at a time; links that
   * come meanwhile are dropped. Says "keyed" or "asked" when it may run.
   */
  private async linkMayRun(
    entry: AppEntry, p: Panel, shortcut: string, link: LinkCall | undefined, lines: string[], title: string, effects?: () => Promise<string[]>,
  ): Promise<"keyed" | "asked" | false> {
    const label = labelOf(p, shortcut);
    const rateKey = `link\n${shortcutId(entry.path, shortcut)}`;
    const recent = () => (this.runs.get(rateKey) ?? []).filter((t) => this.env.now().getTime() - t < 3_600_000);
    if (recent().length >= MAX_RUNS_PER_HOUR) {
      this.runs.set(rateKey, recent());
      this.say(`${entry.name}: stopped running “${label}” from links: it ran ${MAX_RUNS_PER_HOUR} times this hour`);
      return false;
    }
    const expected = this.env.linkKey(entry.path, shortcut, false);
    const keyed = link?.captureKeyed === true || (expected !== undefined && link?.key === expected);
    const cb = link?.callbacks ?? {};
    const asks = !keyed || (cb.to !== undefined && !this.env.destinations(entry.path, shortcut).includes(cb.to));
    if (asks && this.asking) {
      this.say(`Ignored a link to “${label}” in ${entry.name} while another link waits for an answer`);
      return false;
    }
    if (!keyed) {
      this.asking = true;
      try {
        // What it would do is worked out only now, once the window may open: a dropped link costs nothing.
        if (!(await this.env.sink.confirm(title, lines, await effects?.()))) return false;
      } finally {
        this.asking = false;
      }
    } else if (asks) {
      this.asking = true;
      let choice: number | undefined;
      try {
        const what = answers(p) ? `its value (${label})` : `word that “${label}” ran`;
        choice = await this.env.sink.choose(`${entry.name} would send ${what} to ${cb.to}`, lines, ["Cancel", "Once", "Always"]);
      } finally {
        this.asking = false;
      }
      if (choice !== 1 && choice !== 2) {
        if (cb.cancel) this.env.sink.openUrl(cb.cancel);
        return false;
      }
      if (choice === 2) this.env.allowDestination(entry.path, shortcut, cb.to!);
    }
    this.runs.set(rateKey, [...recent(), this.env.now().getTime()]);
    return keyed ? "keyed" : "asked";
  }

  /**
   * Runs a panel's `then`: the named app's shortcut, as a link would, with `fill` filled from the
   * row the panel ran with. Both apps must be allowed. A shortcut already run in this chain, a
   * chain longer than MAX_CHAIN, or more than MAX_RUNS_PER_HOUR runs of one `then` is a loop, and
   * stops with a notice naming it. Never rejects.
   */
  async runThen(fromPath: string, then: Then, ctx: Row, chain: string[] = [], dry?: DryRun, seed?: string): Promise<void> {
    const say = (message: string) => (dry ? void dry.steps.at(-1)?.notices.push(message) : this.say(message));
    try {
      const from = this.lookup(fromPath);
      if (!from || !this.granted(from)) return;
      // Found as Obsidian finds the link from the app's note, as `use` links are.
      const name = storeTarget(then.app);
      const path = this.env.notes.resolve(name, from.path);
      if (!path) return say(`${from.name}: no app called “${name}” to run “${then.do}” in`);
      const target = this.lookup(path);
      if (!target) return say(`${from.name}: “${name}” isn't an app, so it can't run “${then.do}”`);
      const key = shortcutId(target.path, then.do);
      const names = (keys: string[]) => keys.map((k) => basename(appOfShortcut(k))).join(" → ");
      if (chain.includes(key)) return say(`${from.name}: stopped a loop: ${names([...chain, key])}`);
      if (chain.length >= MAX_CHAIN) return say(`${from.name}: stopped after ${MAX_CHAIN} apps in a row: ${names([...chain, key])}`);
      if (!dry) {
        const now = this.env.now().getTime();
        const rateKey = `${from.path}\n${key}`;
        const recent = (this.runs.get(rateKey) ?? []).filter((t) => now - t < 3_600_000);
        if (recent.length >= MAX_RUNS_PER_HOUR) {
          this.runs.set(rateKey, recent);
          return say(`${from.name}: stopped running “${then.do}” in ${target.name}: it ran ${MAX_RUNS_PER_HOUR} times this hour`);
        }
        this.runs.set(rateKey, [...recent, now]);
      }
      const params = Object.fromEntries(Object.entries(then.fill ?? {}).map(([k, v]) => [k, fillLine(v, ctx)]));
      await this.runShortcut(target.path, then.do, `trigger:${from.name}`, then.fill ? params : undefined, [...chain, key], undefined, dry, seed && `${seed}\n${key}`);
    } catch (e) {
      say(`${basename(fromPath)}: couldn't run “${then.do}”: ${(e as Error).message}`);
    }
  }

  /** Tells why something didn't run, and gives that as a run's result. */
  private failed(message: string): ShortcutResult {
    this.say(message);
    return { ok: false, error: message };
  }

  /** Every app's shortcuts as commands, published when that list changes. */
  publishCommands(): void {
    const list = [...this.apps.values()]
      .flatMap((e) => [...e.shortcuts].map(([id, ps]) => ({ id: `${e.path}:${id}`, name: `${e.name}: ${labelOf(ps.panel, id)}` })))
      .sort((a, b) => a.id.localeCompare(b.id));
    const json = JSON.stringify(list);
    if (json === this.commands) return;
    this.commands = json;
    this.env.sink.setCommands(list);
  }
}

/**
 * The row a link, a `then` or a capture line gives a form or checklist shortcut, or why not. What
 * they carry is refused whole if any of it holds a secret or a line break (rule 0.2); a form reads
 * each value as its field's type, a checklist takes the item to tick.
 */
function readParams(p: Panel, params: Record<string, string>, now: Date): { row: Row } | { error: string } {
  const problem = Object.entries(params).map(([k, v]) => valueProblem(new InputRef(k), v, true)).find(Boolean);
  if (problem) return { error: problem };
  if (p.view === "checklist") return pickItem((p.items ?? []).map(String), params);
  return formRow(p.fields ?? p.schema ?? {}, p.fieldInfo, params, now);
}

/**
 * When a form's or button's row is logged for, from a link's `at=` (which a capture line's `@when`
 * becomes): now when none is given. Refused for a form with a field of its own called at, whose
 * value the row's stamp would take the place of, and refused whole, as any value of a link is, if
 * it holds a secret or a line break. A panel that saves to a kind takes a time still to come, and
 * `every … until …`, which plan rows.
 */
function whenOf(p: Panel, shortcut: string, params: Record<string, string> | undefined, now: Date): { at?: Date; plan?: Date[] } | { error: string } {
  const raw = params?.at;
  if (raw === undefined || p.view === "checklist") return {};
  if (p.view === "form" && Object.hasOwn(p.fields ?? p.schema ?? {}, "at")) return { error: ownAt(shortcut, "at=") };
  const problem = valueProblem(new InputRef("at"), raw, true);
  return problem ? { error: problem } : logTime(raw, now, p.target?.kind === "list" && p.target.at !== undefined);
}

/**
 * The shortcuts an app's own panels name that aren't indexed because their panel has a problem
 * that stops it, each with the first problem readSpec gave for that panel, so a link or a `then`
 * naming one hears that rather than that there's no such shortcut.
 */
export function brokenShortcuts(fm: Record<string, unknown>, spec: AppSpec, errors: readonly string[]): Map<string, string> {
  const listed = Array.isArray(fm.panels) || (fm.tabs !== undefined && fm.tabs !== null);
  const entries = fm.use !== undefined ? [] : listed ? panelEntries(fm, []) : fm.view !== undefined ? [{ raw: fm, label: "" }] : [];
  const out = new Map<string, string>();
  for (const { raw, label } of entries) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.shortcut === "string" ? raw.shortcut : typeof raw.alias === "string" ? aliasShortcut(raw.alias) : undefined;
    if (id === undefined || out.has(id) || spec.panels.some((ps) => ps.panel.shortcut === id)) continue;
    // A note that is one panel gives its problems without a label.
    const problem = label ? errors.find((e) => e.startsWith(`${label}: `))?.slice(label.length + 2) : errors[0];
    if (problem !== undefined) out.set(id, problem);
  }
  return out;
}

/** The values a shortcut takes from a link: a form's fields, a checklist's item; a button takes none. */
export function shortcutFields(p: Panel): string[] {
  if (p.view === "checklist") return ["item"];
  return p.view === "form" ? Object.keys(p.fields ?? p.schema ?? {}) : [];
}

/** Who ran a shortcut, as a notice names them. */
function by(actor: Actor): string {
  return actor.startsWith("trigger:") ? actor.slice("trigger:".length) : actor === "link" ? "a link" : "a command";
}

/** What a command or notice calls a panel. */
export function labelOf(p: Panel, fallback: string): string {
  return p.label ?? p.title ?? fallback;
}
