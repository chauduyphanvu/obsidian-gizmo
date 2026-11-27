import { when, type Entry } from "./activity.ts";
import type { MapShortcut } from "./dry-run-pane.ts";
import { handler } from "./handler.ts";
import { blockKey, parseHosted } from "./hosted.ts";
import type { ShortcutLink } from "./links.ts";
import { ASK_GROUPS, buildMap, gizmoBlocks, writersOf, type AppSummary, type Ask, type MapApp, type MapEmbed, type MapLens, type VaultMap } from "./map.ts";
import { isFigure } from "./panel.ts";
import { describePermission } from "./permissions.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { writersOf as storedWriters } from "./stored.ts";
import { basename } from "./store.ts";

/** What only the host does for the map: notices, opening an app, and the windows it opens. */
export interface MapHost {
  rt: GizmoRuntime;
  notify(message: string): void;
  open(path: string): void;
  /** What one app did, in a window. */
  activity(path: string): void;
  dryRun(path: string, name: string, shortcut: MapShortcut): void;
  /** Reviews and applies the policy note. */
  policy(): void;
  /** Copies a shortcut's link, where its links open this host. */
  copyLink?: (link: ShortcutLink) => void;
  /** Saves the map as a canvas, where canvases open. */
  saveCanvas?: () => void;
}

const STATE_WORDS: Record<MapApp["state"], string> = {
  "allowed": "Allowed", "not-opened": "Never opened", "revoked": "Not allowed: you revoked it", "paused": "Paused (asks for more)", "blocked": "Blocked by your policy",
};
/** A state as the summary counts it: "2 allowed, 1 revoked". */
const countWords = (s: MapApp["state"]) => (s === "revoked" ? "revoked" : STATE_WORDS[s].toLowerCase());

/**
 * Every app in the vault on one page: what each may do, what makes it act and when it last
 * changed something, with Revoke. With a note set, it starts with the apps that can change that note.
 * It draws again as what is allowed, the log or the apps change.
 */
export class MapPane {
  private readonly el: HTMLElement;
  private readonly host: MapHost;
  private shownNote: string | undefined;
  private query = "";
  private timer: number | undefined;
  private rendering = 0;
  private readonly unwatch: (() => void)[];

  constructor(el: HTMLElement, host: MapHost, note?: string) {
    this.el = el;
    this.host = host;
    this.shownNote = note;
    const later = () => this.schedule();
    const rt = host.rt;
    this.unwatch = [rt.onGrantsChange(later), rt.activity.onChange(later), rt.background.onIndexChange(later)];
    this.render();
  }

  /** The note whose writers it starts with, if any. */
  get note(): string | undefined {
    return this.shownNote;
  }

  setNote(note: string | undefined): void {
    this.shownNote = note;
    this.render();
  }

  stop(): void {
    window.clearTimeout(this.timer);
    this.rendering++;
    for (const off of this.unwatch.splice(0)) off();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 200);
  }

  private render(): void {
    void this.draw();
  }

  private async draw(): Promise<void> {
    const run = ++this.rendering;
    const rt = this.host.rt;
    const apps = rt.background.list();
    const activity = await rt.activity.list();
    if (run !== this.rendering) return;
    const map = buildMap(apps, rt.store.grants, rt.lenses.lenses(), activity);
    const el = this.el;
    el.empty();
    const box = el.createDiv({ cls: "gizmo gz-map" });

    const head = box.createDiv({ cls: "gz-map-head" });
    const filter = head.createEl("input", { type: "search", placeholder: "Filter apps", value: this.query, attr: { "aria-label": "Filter apps" } });
    filter.addEventListener("input", () => {
      this.query = filter.value;
      this.drawApps(list, map);
      this.drawInNotes(inNotes, map);
    });
    const saveCanvas = this.host.saveCanvas;
    if (saveCanvas) head.createEl("button", { text: "Save as canvas" }).addEventListener("click", () => saveCanvas());
    this.drawPolicy(box, map);
    if (this.shownNote) this.drawWriters(box, this.shownNote, apps, activity);
    const counts = (["allowed", "blocked", "not-opened", "revoked", "paused"] as const).map((s) => [s, map.apps.filter((a) => a.state === s).length] as const);
    box.createDiv({
      cls: "gz-muted gz-map-summary",
      text: `${map.apps.length} ${map.apps.length === 1 ? "app" : "apps"}: ${counts.filter(([, n]) => n).map(([s, n]) => `${n} ${countWords(s)}`).join(", ") || "none yet"}`,
    });
    const list = box.createDiv({ cls: "gz-map-apps" });
    this.drawApps(list, map);
    const inNotes = box.createDiv();
    this.drawInNotes(inNotes, map);
    this.drawShared(box, apps);
    this.drawCaptureKeys(box);
  }

  /** Each shared kind with the writers this vault decided about: Remove ends what comes from one; what came stays. */
  private drawShared(el: HTMLElement, apps: AppSummary[]): void {
    const shared = apps.filter((a) => a.shared);
    if (!shared.length) return;
    el.createEl("h4", { text: "Shared kinds" });
    const rt = this.host.rt;
    const waiting = rt.background.asks.list().filter((a) => a.id.startsWith("writer\n"));
    for (const a of shared) {
      const card = el.createDiv({ cls: "gz-card gz-map-app gz-map-shared" });
      const head = card.createDiv({ cls: "gz-map-app-head" });
      this.link(head, a.path, a.name, "gz-title");
      card.createDiv({ cls: "gz-muted", text: `Shared through ${a.shared!.host}. Rows from the writers you accept count as logged.` });
      const writers = Object.entries(storedWriters(rt.store, a.path)).sort(([, x], [, y]) => x.name.localeCompare(y.name));
      const asked = waiting.filter((w) => w.path === a.path);
      if (!writers.length && !asked.length) card.createDiv({ cls: "gz-muted", text: "No one else has written to it yet." });
      const ul = card.createEl("ul", { cls: "gz-map-writer-list" });
      for (const [writer, w] of writers) {
        const li = ul.createEl("li");
        li.createSpan({ text: `${w.name}${w.guest ? " (guest page)" : ""}: ${w.state === "accepted" ? "accepted" : "removed; nothing more comes in from them"}` });
        const set = (state: "accepted" | "removed") => () => {
          rt.setWriter(a.path, writer, { ...w, state, at: Date.now() });
          this.host.notify(state === "removed"
            ? `${a.name}: rows from ${w.name} no longer come in. The rows of theirs already here stay; delete them like any row if you want them gone.`
            : `${a.name}: rows from ${w.name} come in again, from what they send next`);
          this.render();
        };
        const row = li.createSpan({ cls: "gz-map-actions" });
        if (w.state === "accepted") row.createEl("button", { text: "Remove" }).addEventListener("click", set("removed"));
        else row.createEl("button", { text: "Accept again" }).addEventListener("click", set("accepted"));
      }
      for (const ask of asked) ul.createEl("li", { cls: "gz-muted", text: `${ask.text.replace(/^Accept rows from (.*?) in .*$/, "$1")}: waits in Next to be accepted` });
    }
  }

  /** Whether a data policy is applied, and when its note says something else, a way to review it. */
  private drawPolicy(el: HTMLElement, map: VaultMap): void {
    const rt = this.host.rt;
    const pending = rt.policyPending();
    if (!rt.store.policy && !pending) return;
    const card = el.createDiv({ cls: `gz-card gz-map-policy${pending ? " is-pending" : ""}` });
    const blocked = map.apps.filter((a) => a.state === "blocked").length;
    card.createSpan({
      text: pending && !rt.store.policy
        ? "Gizmo policy.md isn't applied yet; until it is, apps ask for everything as before."
        : pending
          ? "Gizmo policy.md has changes that aren't applied yet; apps follow the policy as it was."
          : `Your data policy is applied: ${blocked ? `${blocked} ${blocked === 1 ? "app is" : "apps are"} blocked by it` : "every app fits it"}.`,
    });
    card.createEl("button", { text: pending ? "Review and apply" : "Review" }).addEventListener("click", () => this.host.policy());
  }

  /** Capture links' keys, each with the names it runs without asking, and Revoke. */
  private drawCaptureKeys(el: HTMLElement): void {
    const rt = this.host.rt;
    const keys = Object.entries(rt.store.captureKeys ?? {});
    if (!keys.length) return;
    el.createEl("h4", { text: "Capture links" });
    for (const [key, granted] of keys) {
      const names = Object.keys(granted).sort();
      const card = el.createDiv({ cls: "gz-card gz-map-app" });
      const head = card.createDiv({ cls: "gz-map-app-head" });
      head.createSpan({ cls: "gz-title", text: `Key ${key.slice(0, 4)}…` });
      head.createDiv({ cls: "gz-map-actions" }).createEl("button", { text: "Revoke" }).addEventListener("click", handler(async () => {
        await rt.revokeCaptureKey(key);
        this.host.notify("That capture link's lines now ask before they run");
      }));
      card.createDiv({ cls: "gz-muted", text: names.length ? `Runs without asking: ${names.join(", ")}` : "Every line it sends asks first" });
    }
  }

  /** The filter's words, if any, in what is shown for an app. */
  private matches(...text: string[]): boolean {
    const q = this.query.trim().toLowerCase();
    return !q || text.join(" ").toLowerCase().includes(q);
  }

  /** Embeds and lenses, as far as the filter leaves them. */
  private drawInNotes(el: HTMLElement, map: VaultMap): void {
    el.empty();
    const embeds = map.embeds.filter((e) => this.matches(e.hostPath));
    if (embeds.length) {
      el.createEl("h4", { text: "Apps inside notes" });
      for (const embed of embeds) void this.drawEmbed(el.createDiv({ cls: "gz-card gz-map-app" }), embed);
    }
    const lenses = map.lenses.filter((l) => this.matches(l.name, l.scope, l.path));
    if (lenses.length) {
      el.createEl("h4", { text: "Lenses" });
      for (const lens of lenses) this.drawLens(el.createDiv({ cls: "gz-card gz-map-app" }), lens);
    }
  }

  /** The apps that can change one note, from their keys and from what the log saw. */
  private drawWriters(box: HTMLElement, note: string, apps: AppSummary[], activity: Entry[]): void {
    const rt = this.host.rt;
    const card = box.createDiv({ cls: "gz-card gz-map-writers" });
    card.createDiv({ cls: "gz-title", text: `Apps that can change ${basename(note)}` });
    const writers = writersOf(note, apps, activity, (scope, path) => rt.dataLayer.inScope(scope, path));
    const embedded = Object.keys(rt.store.grants).filter((k) => k.startsWith(`${note}#`));
    if (!writers.length && !embedded.length) card.createDiv({ cls: "gz-muted", text: "None: no app's keys let it change this note, and the log has no change to it." });
    const ul = card.createEl("ul");
    const now = new Date();
    for (const w of writers) {
      const li = ul.createEl("li");
      this.link(li, w.path, w.name);
      if (w.reason) li.createSpan({ text: `: ${w.reason}` });
      if (w.last) li.createDiv({ cls: "gz-muted", text: `Last: ${when(w.last.at, now)} · ${w.last.actor}: ${w.last.what}` });
    }
    if (embedded.length) ul.createEl("li", { text: `${embedded.length === 1 ? "A gizmo block" : `${embedded.length} gizmo blocks`} in this note (listed under Apps inside notes)` });
    card.createEl("button", { text: "Show every app" }).addEventListener("click", () => this.setNote(undefined));
  }

  private drawApps(list: HTMLElement, map: VaultMap): void {
    list.empty();
    const shown = map.apps.filter((a) => this.matches(a.name, a.description, a.path));
    if (!shown.length) list.createDiv({ cls: "gz-muted", text: map.apps.length ? "No app matches." : "No apps yet: a note whose properties start with app: is one." });
    for (const a of shown) this.drawApp(list.createDiv({ cls: "gz-card gz-map-app" }), a);
  }

  private drawApp(card: HTMLElement, a: MapApp): void {
    const rt = this.host.rt;
    const head = card.createDiv({ cls: "gz-map-app-head" });
    this.link(head, a.path, a.name, "gz-title");
    head.createSpan({ cls: `gz-map-state is-${a.state}`, text: STATE_WORDS[a.state] });
    const actions = head.createDiv({ cls: "gz-map-actions" });
    actions.createEl("button", { text: "Activity" }).addEventListener("click", () => this.host.activity(a.path));
    if (a.state !== "not-opened" && a.state !== "revoked") {
      actions.createEl("button", { text: "Revoke" }).addEventListener("click", handler(async () => {
        await rt.revoke(a.path);
        this.host.notify(`${a.name} is stopped; open it to allow it again`);
      }));
    }
    if (a.description) card.createDiv({ cls: "gz-muted gz-map-desc", text: a.description });
    if (a.policy?.violations.length) {
      const blocked = card.createDiv({ cls: "gz-map-blocked" });
      blocked.createDiv({ cls: "gz-label", text: "Breaks your policy" });
      const ul = blocked.createEl("ul");
      for (const v of a.policy.violations) ul.createEl("li", { text: v });
    } else if (a.policy) {
      card.createDiv({ cls: "gz-muted gz-map-fits", text: "Fits your policy" });
    }
    this.drawAsks(card, a.asks);

    const acts = card.createDiv({ cls: "gz-map-acts" });
    if (a.shortcuts.length || a.acts.length || a.runBy.length) acts.createDiv({ cls: "gz-label", text: "Acts" });
    const ul = acts.createEl("ul");
    const copyLink = this.host.copyLink;
    for (const s of a.shortcuts) {
      const li = ul.createEl("li", { cls: "gz-map-shortcut" });
      const answers = isFigure(s);
      li.createSpan({ text: answers ? `Answers “${s.label}” (${s.id}) to its command or link` : `Shortcut “${s.label}” (${s.id}): from its command or link` });
      const row = li.createSpan({ cls: "gz-map-actions" });
      if (!answers && a.state === "allowed") {
        row.createEl("button", { text: "Dry run" }).addEventListener("click", () => this.host.dryRun(a.path, a.name, s));
      }
      if (copyLink) {
        row.createEl("button", { text: "Copy link" }).addEventListener("click", () => {
          const link = rt.background.shortcutLinks().find((l) => l.path === a.path && l.shortcut === s.id);
          if (link) copyLink(link);
        });
      }
      row.createEl("button", { text: "New link key" }).addEventListener("click", handler(async () => {
        await rt.resetLinkKey(a.path, s.id);
        this.host.notify(`Links to “${s.label}” copied before now ask before they run`);
      }));
    }
    for (const line of a.acts) ul.createEl("li", { text: line });
    for (const r of a.runBy) {
      const li = ul.createEl("li");
      li.createSpan({ text: `Runs “${r.do}” when ` });
      this.link(li, r.path, r.name);
      li.createSpan({ text: " asks" });
    }
    if (a.last) card.createDiv({ cls: "gz-muted gz-map-last", text: `Last change: ${when(a.last.at, new Date())} · ${a.last.actor}: ${a.last.what}` });
  }

  private drawAsks(card: HTMLElement, asks: Ask[]): void {
    if (!asks.length) {
      card.createDiv({ cls: "gz-muted", text: "Asks for nothing: it only reads and writes its own notes." });
      return;
    }
    const groups = card.createDiv({ cls: "gz-map-groups" });
    for (const group of ASK_GROUPS) {
      const mine = asks.filter((x) => x.group === group);
      if (!mine.length) continue;
      const g = groups.createDiv({ cls: "gz-map-group" });
      g.createDiv({ cls: "gz-label", text: group });
      const ul = g.createEl("ul");
      for (const ask of mine) {
        const li = ul.createEl("li");
        if (ask.isNew) li.createSpan({ cls: "gz-new", text: "New" });
        if (ask.covered) li.createSpan({ cls: "gz-covered-tag", text: "Policy", attr: { title: "Your data policy grants this without asking" } });
        li.createSpan({ text: ask.text + (ask.by.length ? ` — for ${ask.by.map((p) => `[[${basename(p)}]]`).join(", ")}` : "") });
      }
    }
  }

  /** A block's app, found in its note by the hash its grant is kept under. */
  private async drawEmbed(card: HTMLElement, embed: MapEmbed): Promise<void> {
    const rt = this.host.rt;
    const head = card.createDiv({ cls: "gz-map-app-head" });
    head.createSpan({ cls: "gz-title", text: "A gizmo block in " });
    this.link(head, embed.hostPath, basename(embed.hostPath), "gz-title");
    const actions = head.createDiv({ cls: "gz-map-actions" });
    const text = await rt.dataLayer.host.readFile(embed.hostPath).catch(() => undefined);
    const source = text === undefined ? undefined : gizmoBlocks(text).find((b) => blockKey(embed.hostPath, b) === embed.key);
    if (source === undefined) {
      card.createDiv({ cls: "gz-muted", text: "This block is no longer in the note; what it was allowed is kept until removed." });
      actions.createEl("button", { text: "Remove" }).addEventListener("click", () => void rt.revoke(embed.key));
      return;
    }
    let what: string;
    try {
      const block = parseHosted(rt.dataLayer.host.parseYaml(source));
      what = "kind" in block && block.kind === "app" ? `Shows [[${block.link}]]` : "Runs its own keys";
    } catch {
      what = "Its keys aren't YAML Gizmo can read";
    }
    card.createDiv({ cls: "gz-muted", text: what });
    actions.createEl("button", { text: "Revoke" }).addEventListener("click", () => void rt.revoke(embed.key));
    this.drawAllowed(card, embed.allowed);
  }

  private drawLens(card: HTMLElement, lens: MapLens): void {
    const head = card.createDiv({ cls: "gz-map-app-head" });
    this.link(head, lens.path, lens.name, "gz-title");
    head.createSpan({ cls: `gz-map-state is-${lens.allowed ? "allowed" : "not-opened"}`, text: lens.allowed ? "Allowed" : "Not allowed yet" });
    if (lens.allowed) {
      head.createDiv({ cls: "gz-map-actions" }).createEl("button", { text: "Revoke" }).addEventListener("click", () => void this.host.rt.revoke(lens.path));
    }
    card.createDiv({ cls: "gz-muted", text: `Shows on every note in ${lens.scope}` });
    if (lens.allowed) this.drawAllowed(card, lens.allowed);
  }

  private drawAllowed(card: HTMLElement, allowed: string[]): void {
    if (!allowed.length) return void card.createDiv({ cls: "gz-muted", text: "Allowed to do nothing beyond its own notes." });
    const ul = card.createEl("ul");
    for (const perm of allowed) ul.createEl("li", { text: describePermission(perm) });
  }

  private link(parent: HTMLElement, path: string, text: string, cls = ""): void {
    const a = parent.createEl("a", { cls: `internal-link ${cls}`.trim(), text, href: "#" });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      this.host.open(path);
    });
  }
}
