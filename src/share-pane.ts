import type { BundleNote, InstallPreview } from "./bundle.ts";
import type { Plan } from "./gallery.ts";
import { planShared, previewShared, readShared, sharedLink } from "./install.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { basename } from "./store.ts";

export interface ShareHost {
  /** Copies `text`, calling `done` once it's on the clipboard. */
  copy(text: string, done: () => void): void;
  notify(message: string): void;
  close(): void;
}

export const shareTitle = (name: string): string => `Share ${name}`;

/** Shows the shared text before it leaves: every line of it travels, the note's own text included. */
export function drawShare(parent: HTMLElement, name: string, notes: BundleNote[], text: string, warnings: string[], host: ShareHost): void {
  const el = parent.createDiv({ cls: "gizmo gz-share" });
  const names = notes.map((n) => n.name);
  el.createEl("p", {
    text: names.length > 1 ? `It takes ${names.slice(1).join(", ")} along with ${names[0]}.` : `It's ${names[0]} on its own.`,
  });
  for (const w of warnings) el.createEl("p", { cls: "gz-warning-text", text: w });
  el.createEl("p", {
    cls: "gz-muted",
    text: "Whoever gets this can read every line below, the notes' own text included. Your saved data and other notes aren't in it.",
  });
  const area = el.createEl("textarea", { cls: "gz-share-text", attr: { readonly: "", rows: "14", spellcheck: "false" } });
  area.value = text;
  const row = el.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { cls: "mod-cta", text: "Copy" }).addEventListener("click", () => {
    host.copy(text, () => {
      host.notify(`Copied ${name}; paste it in a gist or a message to share it`);
      host.close();
    });
  });
}

export interface InstallHost {
  /** A link or shared text to start with: a link is only fetched on Preview, any other text is read at once. */
  start?: string;
  /** Tries the shared app on its own notes, placed as the install would place them; its Install installs. */
  tryIt(notes: BundleNote[], folder: string, install: () => Promise<void>): void;
  /** Installs the plan and opens what it made; false, having said why, when it couldn't. */
  install(plan: Plan, name: string): Promise<boolean>;
  close(): void;
}

export const INSTALL_TITLE = "Install an app";

/** Reads shared text or a link, shows what installing it would do, and installs it on a click. */
export function drawInstall(parent: HTMLElement, rt: GizmoRuntime, host: InstallHost): void {
  const start = host.start ?? "";
  const el = parent.createDiv({ cls: "gizmo gz-share" });
  el.createEl("p", { text: "Paste an app someone shared, or a link to one (a gist, or a note's raw text)." });
  const area = el.createEl("textarea", { cls: "gz-share-text", attr: { rows: "6", spellcheck: "false", placeholder: "https://… or the shared text" } });
  area.value = start;
  const output = el.createDiv({ cls: "gz-install-preview" });
  const row = el.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { text: "Preview" }).addEventListener("click", () => void read(area.value));
  const tryButton = row.createEl("button", { text: "Try it" });
  tryButton.disabled = true;
  const installButton = row.createEl("button", { cls: "mod-cta", text: "Install" });
  installButton.disabled = true;

  let notes: BundleNote[] = [];
  let preview: InstallPreview | undefined;
  let folder = "";

  const say = (text: string, cls = "gz-muted") => {
    output.empty();
    output.createEl("p", { cls, text });
    installButton.disabled = true;
    tryButton.disabled = true;
    preview = undefined;
  };

  const read = async (input: string) => {
    if (!input.trim()) return say("Paste something first");
    const layer = rt.dataLayer.host;
    const got = await readShared(input, (url, headers) => layer.fetch(url, headers), (yaml) => layer.parseYaml(yaml), (name) => say(`Fetching ${name}…`));
    if ("error" in got) return say(got.error, "gz-error-text");
    notes = got.notes;
    const previewed = await previewShared(rt, got.notes);
    if ("error" in previewed) return say(previewed.error, "gz-error-text");
    folder = previewed.folder;
    show(previewed.preview);
  };

  const list = (items: string[]) => {
    const ul = output.createEl("ul");
    for (const item of items) ul.createEl("li", { text: item });
  };

  const show = (p: InstallPreview) => {
    preview = p;
    output.empty();
    output.createEl("h4", { text: p.name });
    if (p.about) output.createEl("p", { text: p.about });
    if ("refusal" in p.plan) {
      output.createEl("p", { cls: "gz-error-text", text: `${p.plan.refusal}; rename or move that note to install this.` });
    } else {
      const created = p.plan.create.map((n) => basename(n.path));
      output.createEl("p", { text: `Creates ${created.join(", ")}${p.plan.reuse.length ? `, and uses your ${p.plan.reuse.join(", ")}` : ""}.` });
    }
    for (const extra of p.extras) output.createEl("p", { cls: "gz-warning-text", text: `${extra}.` });
    if (p.errors.length) {
      output.createEl("p", { cls: "gz-error-text", text: "Its own check says:" });
      list(p.errors);
    }
    if (p.policy?.violations.length) {
      output.createEl("p", { cls: "gz-error-text", text: "Checked against your data policy: it would be blocked, as it sends data where your policy keeps it from going:" });
      list(p.policy.violations);
    } else if (p.policy) {
      output.createEl("p", { text: `Checked against your data policy: it fits${p.policy.covered.length ? `, and your policy lets it ${p.policy.covered.join("; ")} without asking` : ""}.` });
    }
    if (p.asks.length) {
      output.createEl("p", { text: p.kind === "app" ? "When you open it, it will ask your OK to:" : "Where it's used, it will ask your OK to:" });
      list(p.asks);
    } else {
      output.createEl("p", { text: "It asks for nothing: it only keeps its own data beside it." });
    }
    installButton.disabled = "refusal" in p.plan;
    tryButton.disabled = p.kind !== "app";
  };

  // The plan is made again at the click: the vault may have changed since the preview.
  const install = async () => {
    const p = preview;
    if (!p || "refusal" in p.plan) return;
    if (await host.install(await planShared(rt, notes), p.name)) host.close();
  };
  tryButton.addEventListener("click", () => host.tryIt(notes, folder, install));
  installButton.addEventListener("click", () => void install());

  // A link fills the box but fetches nothing until Preview: any web page can send an install link.
  const { url } = sharedLink(start);
  if (url) say(`Press Preview to fetch ${new URL(url).hostname}`);
  else if (start) void read(start);
  else window.setTimeout(() => area.focus(), 0);
}
