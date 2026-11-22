import { textOf } from "./text.ts";
import { handler } from "./handler.ts";
import { PolicyModal } from "./policy-command.ts";
import { ItemView, MarkdownView, Modal, Notice, parseYaml, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { dryLines } from "./background-shortcuts.ts";
import { openActivity, when } from "./activity-view.ts";
import { blockKey, parseHosted } from "./hosted.ts";
import { copyShortcutLink } from "./link-command.ts";
import type GizmoPlugin from "./main.ts";
import { mapCanvas } from "./map-canvas.ts";
import { ASK_GROUPS, buildMap, gizmoBlocks, writersOf, type Ask, type MapApp, type MapEmbed, type MapLens, type VaultMap } from "./map.ts";
import { describePermission } from "./permissions.ts";
import { basename } from "./store.ts";
import { dayIn } from "./time.ts";

export const MAP_VIEW = "gizmo-map";

const STATE_WORDS: Record<MapApp["state"], string> = {
  "allowed": "Allowed", "not-opened": "Never opened", "revoked": "Not allowed: you revoked it", "paused": "Paused (asks for more)", "blocked": "Blocked by your policy",
};
/** A state as the summary counts it: "2 allowed, 1 revoked". */
const countWords = (s: MapApp["state"]) => (s === "revoked" ? "revoked" : STATE_WORDS[s].toLowerCase());

/**
 * Every app in the vault on one page: what each may do, what makes it act and when it last
 * changed something, with Revoke. With a note set, it starts with the apps that can change that note.
 */
export class MapView extends ItemView {
  private plugin: GizmoPlugin;
  private note: string | undefined;
  private query = "";
  private timer: number | undefined;
  private rendering = 0;

  constructor(leaf: WorkspaceLeaf, plugin: GizmoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return MAP_VIEW; }
  getDisplayText(): string { return "Automation map"; }
  getIcon(): string { return "network"; }

  getState(): Record<string, unknown> {
    return { note: this.note };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const note = (state as { note?: unknown } | null)?.note;
    this.note = typeof note === "string" ? note : undefined;
    await super.setState(state, result);
    this.render();
  }

  async onOpen(): Promise<void> {
    const later = () => this.schedule();
    this.register(this.plugin.onGrantsChange(later));
    this.register(this.plugin.activity.onChange(later));
    const bg = this.plugin.background;
    if (bg) this.register(bg.onIndexChange(later));
    this.render();
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.timer);
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
    const plugin = this.plugin;
    const apps = plugin.background?.list() ?? [];
    const activity = await plugin.activity.list();
    if (run !== this.rendering) return;
    const map = buildMap(apps, plugin.store.grants, plugin.lenses.lenses(), activity);
    const el = this.contentEl;
    el.empty();
    const box = el.createDiv({ cls: "gizmo gz-map" });

    const head = box.createDiv({ cls: "gz-map-head" });
    const filter = head.createEl("input", { type: "search", placeholder: "Filter apps", value: this.query });
    filter.addEventListener("input", () => {
      this.query = filter.value;
      this.drawApps(list, map);
      this.drawInNotes(inNotes, map);
    });
    head.createEl("button", { text: "Save as canvas" }).addEventListener("click", () => void saveMapCanvas(plugin));
    this.drawPolicy(box, map);
    if (this.note) this.drawWriters(box, this.note, apps, activity);
    const counts = (["allowed", "blocked", "not-opened", "revoked", "paused"] as const).map((s) => [s, map.apps.filter((a) => a.state === s).length] as const);
    box.createDiv({
      cls: "gz-muted gz-map-summary",
      text: `${map.apps.length} ${map.apps.length === 1 ? "app" : "apps"}: ${counts.filter(([, n]) => n).map(([s, n]) => `${n} ${countWords(s)}`).join(", ") || "none yet"}`,
    });
    const list = box.createDiv({ cls: "gz-map-apps" });
    this.drawApps(list, map);
    const inNotes = box.createDiv();
    this.drawInNotes(inNotes, map);
    this.drawCaptureKeys(box);
  }

  /** Whether a data policy is applied, and when its note says something else, a way to review it. */
  private drawPolicy(el: HTMLElement, map: VaultMap): void {
    const plugin = this.plugin;
    const pending = plugin.policyPending();
    if (!plugin.store.policy && !pending) return;
    const card = el.createDiv({ cls: `gz-card gz-map-policy${pending ? " is-pending" : ""}` });
    const blocked = map.apps.filter((a) => a.state === "blocked").length;
    card.createSpan({
      text: pending && !plugin.store.policy
        ? "Gizmo policy.md isn't applied yet; until it is, apps ask for everything as before."
        : pending
          ? "Gizmo policy.md has changes that aren't applied yet; apps follow the policy as it was."
          : `Your data policy is applied: ${blocked ? `${blocked} ${blocked === 1 ? "app is" : "apps are"} blocked by it` : "every app fits it"}.`,
    });
    card.createEl("button", { text: pending ? "Review and apply" : "Review" }).addEventListener("click", () => new PolicyModal(plugin).open());
  }

  /** Capture links' keys, each with the names it runs without asking, and Revoke. */
  private drawCaptureKeys(el: HTMLElement): void {
    const keys = Object.entries(this.plugin.store.captureKeys ?? {});
    if (!keys.length) return;
    el.createEl("h4", { text: "Capture links" });
    for (const [key, granted] of keys) {
      const names = Object.keys(granted).sort();
      const card = el.createDiv({ cls: "gz-card gz-map-app" });
      const head = card.createDiv({ cls: "gz-map-app-head" });
      head.createSpan({ cls: "gz-title", text: `Key ${key.slice(0, 4)}…` });
      head.createDiv({ cls: "gz-map-actions" }).createEl("button", { text: "Revoke" }).addEventListener("click", handler(async () => {
        await this.plugin.revokeCaptureKey(key);
        new Notice("That capture link's lines now ask before they run");
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
  private drawWriters(box: HTMLElement, note: string, apps: ReturnType<NonNullable<GizmoPlugin["background"]>["list"]>, activity: Awaited<ReturnType<GizmoPlugin["activity"]["list"]>>): void {
    const card = box.createDiv({ cls: "gz-card gz-map-writers" });
    card.createDiv({ cls: "gz-title", text: `Apps that can change ${basename(note)}` });
    const writers = writersOf(note, apps, activity, (scope, path) => this.plugin.dataLayer.inScope(scope, path));
    const embedded = Object.keys(this.plugin.store.grants).filter((k) => k.startsWith(`${note}#`));
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
    card.createEl("button", { text: "Show every app" }).addEventListener("click", () => {
      this.note = undefined;
      this.render();
    });
  }

  private drawApps(list: HTMLElement, map: VaultMap): void {
    list.empty();
    const shown = map.apps.filter((a) => this.matches(a.name, a.description, a.path));
    if (!shown.length) list.createDiv({ cls: "gz-muted", text: map.apps.length ? "No app matches." : "No apps yet: a note whose properties start with app: is one." });
    for (const a of shown) this.drawApp(list.createDiv({ cls: "gz-card gz-map-app" }), a);
  }

  private drawApp(card: HTMLElement, a: MapApp): void {
    const head = card.createDiv({ cls: "gz-map-app-head" });
    this.link(head, a.path, a.name, "gz-title");
    head.createSpan({ cls: `gz-map-state is-${a.state}`, text: STATE_WORDS[a.state] });
    const actions = head.createDiv({ cls: "gz-map-actions" });
    actions.createEl("button", { text: "Activity" }).addEventListener("click", () => openActivity(this.plugin, a.path));
    if (a.state !== "not-opened" && a.state !== "revoked") {
      actions.createEl("button", { text: "Revoke" }).addEventListener("click", handler(async () => {
        await this.plugin.revoke(a.path);
        new Notice(`${a.name} is stopped; open it to allow it again`);
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
    for (const s of a.shortcuts) {
      const li = ul.createEl("li", { cls: "gz-map-shortcut" });
      const answers = s.view === "number" || s.view === "progress";
      li.createSpan({ text: answers ? `Answers “${s.label}” (${s.id}) to its command or link` : `Shortcut “${s.label}” (${s.id}): from its command or link` });
      const row = li.createSpan({ cls: "gz-map-actions" });
      if (!answers && a.state === "allowed") {
        row.createEl("button", { text: "Dry run" }).addEventListener("click", () => new DryRunModal(this.plugin, a.path, a.name, s).open());
      }
      row.createEl("button", { text: "Copy link" }).addEventListener("click", () => {
        const link = this.plugin.background?.shortcutLinks().find((l) => l.path === a.path && l.shortcut === s.id);
        if (link) copyShortcutLink(link);
      });
      row.createEl("button", { text: "New link key" }).addEventListener("click", handler(async () => {
        await this.plugin.resetLinkKey(a.path, s.id);
        new Notice(`Links to “${s.label}” copied before now ask before they run`);
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
    const head = card.createDiv({ cls: "gz-map-app-head" });
    head.createSpan({ cls: "gz-title", text: "A gizmo block in " });
    this.link(head, embed.hostPath, basename(embed.hostPath), "gz-title");
    const actions = head.createDiv({ cls: "gz-map-actions" });
    const file = this.app.vault.getFileByPath(embed.hostPath);
    const source = file ? gizmoBlocks(await this.app.vault.cachedRead(file)).find((b) => blockKey(embed.hostPath, b) === embed.key) : undefined;
    if (source === undefined) {
      card.createDiv({ cls: "gz-muted", text: "This block is no longer in the note; what it was allowed is kept until removed." });
      actions.createEl("button", { text: "Remove" }).addEventListener("click", () => void this.plugin.revoke(embed.key));
      return;
    }
    let what: string;
    try {
      const block = parseHosted(parseYaml(source));
      what = "kind" in block && block.kind === "app" ? `Shows [[${block.link}]]` : "Runs its own keys";
    } catch {
      what = "Its keys aren't YAML Gizmo can read";
    }
    card.createDiv({ cls: "gz-muted", text: what });
    actions.createEl("button", { text: "Revoke" }).addEventListener("click", () => void this.plugin.revoke(embed.key));
    this.drawAllowed(card, embed.allowed);
  }

  private drawLens(card: HTMLElement, lens: MapLens): void {
    const head = card.createDiv({ cls: "gz-map-app-head" });
    this.link(head, lens.path, lens.name, "gz-title");
    head.createSpan({ cls: `gz-map-state is-${lens.allowed ? "allowed" : "not-opened"}`, text: lens.allowed ? "Allowed" : "Not allowed yet" });
    if (lens.allowed) {
      head.createDiv({ cls: "gz-map-actions" }).createEl("button", { text: "Revoke" }).addEventListener("click", () => void this.plugin.revoke(lens.path));
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
      void this.app.workspace.openLinkText(path, "", false);
    });
  }
}

/**
 * What a shortcut would change if it ran now, through every app its `then` reaches, worked out
 * without writing anything. A form's fields can be typed in, and it works it out again as you type.
 */
class DryRunModal extends Modal {
  private plugin: GizmoPlugin;
  private path: string;
  private name: string;
  private shortcut: MapApp["shortcuts"][number];
  private values: Record<string, string> = {};
  private timer: number | undefined;
  private run = 0;

  constructor(plugin: GizmoPlugin, path: string, name: string, shortcut: MapApp["shortcuts"][number]) {
    super(plugin.app);
    this.plugin = plugin;
    this.path = path;
    this.name = name;
    this.shortcut = shortcut;
  }

  onOpen(): void {
    this.titleEl.setText(`If “${this.shortcut.label}” in ${this.name} ran now`);
    const el = this.contentEl.createDiv({ cls: "gizmo gz-share gz-dry" });
    // Each field as the form draws it, holding what a link that left it out would save.
    const start = this.plugin.background?.formStart(this.path, this.shortcut.id);
    if (start) {
      const form = el.createDiv({ cls: "gz-dry-fields" });
      // An empty number is saved empty, as the form saves it; a link can't say empty, so it is left out.
      const changed = (field: string, value: string) => {
        if (value === "" && start.fields[field] === "number") delete this.values[field];
        else this.values[field] = value;
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.show(list), 250);
      };
      for (const [field, type] of Object.entries(start.fields)) {
        const label = form.createEl("label", { cls: "gz-input" });
        label.createSpan({ cls: "gz-input-name", text: field });
        const value = start.row[field];
        if (value !== null && value !== undefined) this.values[field] = textOf(value);
        if (Array.isArray(type)) {
          const select = label.createEl("select", { cls: "dropdown" });
          for (const option of type) select.createEl("option", { text: String(option), value: String(option) });
          select.value = this.values[field] ?? "";
          select.addEventListener("change", () => changed(field, select.value));
        } else if (type === "checkbox") {
          const box = label.createEl("input", { type: "checkbox" });
          box.checked = value === true;
          box.addEventListener("change", () => changed(field, String(box.checked)));
        } else {
          const input = label.createEl("input", { type: ["number", "date", "time"].includes(type) ? type : "text", value: this.values[field] ?? "" });
          input.addEventListener("input", () => changed(field, input.value));
        }
      }
    }
    el.createEl("h4", { text: "It would:" });
    const list = el.createEl("ul", { cls: "gz-effects" });
    el.createEl("p", { cls: "gz-muted", text: "Worked out on copies of the notes it would change; nothing has been written." });
    void this.show(list);
  }

  onClose(): void {
    window.clearTimeout(this.timer);
    this.contentEl.empty();
  }

  private async show(list: HTMLElement): Promise<void> {
    const run = ++this.run;
    const params = this.shortcut.fields.length ? { ...this.values } : undefined;
    const steps = await this.plugin.background?.dryRun(this.path, this.shortcut.id, params);
    if (run !== this.run) return;
    list.empty();
    for (const line of dryLines(steps ?? [])) list.createEl("li", { text: line });
  }
}

/** Saves the map as a new canvas at the vault's top, never over one already there, and opens it. */
export async function saveMapCanvas(plugin: GizmoPlugin): Promise<void> {
  const vault = plugin.app.vault;
  const data = mapCanvas(plugin.background?.list() ?? [], (path) => !!vault.getFileByPath(path));
  const day = dayIn(Date.now());
  let path = `Gizmo map ${day}.canvas`;
  for (let n = 2; vault.getAbstractFileByPath(path); n++) path = `Gizmo map ${day} ${n}.canvas`;
  const file = await vault.create(path, JSON.stringify(data, null, "\t"));
  new Notice(`Saved the map as ${file.basename}`);
  await plugin.app.workspace.getLeaf("tab").openFile(file);
}

/** Opens the map (one tab, reused), optionally starting with the apps that can change a note. */
export async function openMap(plugin: GizmoPlugin, note?: string): Promise<void> {
  const ws = plugin.app.workspace;
  const leaf = ws.getLeavesOfType(MAP_VIEW)[0] ?? ws.getLeaf("tab");
  await leaf.setViewState({ type: MAP_VIEW, state: { note }, active: true });
  void ws.revealLeaf(leaf);
}

export function registerMap(plugin: GizmoPlugin): void {
  plugin.registerView(MAP_VIEW, (leaf) => new MapView(leaf, plugin));
  plugin.addCommand({ id: "open-map", name: "Open the automation map", callback: () => void openMap(plugin) });
  plugin.addCommand({ id: "save-map-canvas", name: "Save the automation map as a canvas", callback: () => void saveMapCanvas(plugin) });
  plugin.addCommand({
    id: "who-changes-note",
    name: "Which apps can change this note?",
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile() ?? plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (!file) return false;
      if (!checking) void openMap(plugin, file.path);
      return true;
    },
  });
}
