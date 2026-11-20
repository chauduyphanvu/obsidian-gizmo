import type { AppEnv } from "./app.ts";
import { describePermission } from "./permissions.ts";
import type { ComponentPreview } from "./spec.ts";
import { basename } from "./store.ts";
import { labelOf, lineOf } from "./yamlpos.ts";

/** What the cards above an app's panels read of the app, and do when they are used. */
export interface CardApp {
  env: AppEnv;
  appPath: string;
  hostPath: string;
  grantKey: string;
  /** In an embed or a lens: not an app note opened on its own. */
  hosted: boolean;
  /** A lens's `for` scope: its grant covers every note there. */
  scope?: string;
  /** Draws the app from scratch, as once it is allowed. */
  load(): void;
}

export function renderPermissionPrompt(header: HTMLElement, wanted: string[], askers: Map<string, Set<string>>, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card" });
  card.createDiv({ cls: "gz-title", text: "This app needs your OK to:" });
  const ul = card.createEl("ul");
  const before = new Set(app.env.granted(app.grantKey));
  for (const p of wanted) {
    const li = ul.createEl("li");
    if (before.size && !before.has(p)) li.createSpan({ cls: "gz-new", text: "New" });
    const who = [...(askers.get(p) ?? [])];
    const others = who.filter((path) => path !== app.appPath).map((path) => `[[${basename(path)}]]`);
    const names = [...(others.length && who.includes(app.appPath) ? ["this note"] : []), ...others];
    li.createSpan({ text: describePermission(p) + (others.length ? ` — for ${names.join(", ")}` : "") });
  }
  if (app.scope) card.createDiv({ cls: "gz-label gz-scope", text: `It shows on every note in ${app.scope}; this OK covers all of them.` });
  const row = card.createDiv({ cls: "gz-actions" });
  row.createEl("button", { cls: "mod-cta", text: "Allow" }).addEventListener("click", async () => {
    await app.env.grant(app.grantKey, wanted);
    app.load();
  });
  // An embed's keys are in the note it is drawn in, and a lens's in its component.
  if (!app.hosted) row.createEl("button", { text: "Edit source" }).addEventListener("click", () => app.env.showSource());
}

/** In an embed of an app that isn't allowed yet: the app asks for itself when it is opened. */
export function renderOpenOnce(header: HTMLElement, app: CardApp): void {
  const line = header.createDiv({ cls: "gz-waiting" });
  line.createSpan({ text: "Open " });
  const link = line.createEl("a", { cls: "internal-link", text: `[[${basename(app.appPath)}]]`, href: "#" });
  link.addEventListener("click", (e) => {
    e.preventDefault();
    app.env.openNote(app.appPath, app.hostPath);
  });
  line.createSpan({ text: " once to allow it" });
}

export function renderErrors(header: HTMLElement, errors: string[], app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card gz-error" });
  card.createDiv({ cls: "gz-title", text: "This app's keys have problems" });
  const ul = card.createEl("ul");
  for (const e of errors) renderError(ul, e, app);
}

/** An error that names a panel, a data block or an input is a link to that place in the note's source. */
function renderError(ul: HTMLElement, error: string, app: CardApp): void {
  const li = ul.createEl("li");
  if (!labelOf(error)) return li.setText(error);
  const link = li.createEl("button", { cls: "gz-error-link", text: error, title: "Show it in the note" });
  link.addEventListener("click", () => void showErrorSource(error, app));
}

/** Reads the note when the link is used, since it may have changed since the card was drawn. */
async function showErrorSource(error: string, app: CardApp): Promise<void> {
  const line = lineOf(await app.env.sourceLines(), error);
  if (line === undefined) app.env.showSource();
  else app.env.showSourceAt(line);
}

export function renderUsage(header: HTMLElement, c: ComponentPreview, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card" });
  card.createDiv({ text: "A component. Use it in an app's panels:" });
  card.createEl("pre", { cls: "gz-example", text: c.usage });
  const copy = card.createDiv({ cls: "gz-actions" }).createEl("button", { text: "Copy" });
  copy.addEventListener("click", () => {
    app.env.copy(c.usage);
    copy.setText("Copied");
    setTimeout(() => copy.setText("Copy"), 1000);
  });
  if (c.lens) card.createDiv({ cls: "gz-label", text: `It is also a lens: it shows above every note in ${c.lens}.` });
  else if (c.missing.length) card.createDiv({ cls: "gz-label", text: "Give every param a default to preview it here." });
}

export function renderEmpty(header: HTMLElement, app: CardApp): void {
  const card = header.createDiv({ cls: "gz-card" });
  card.createDiv({ text: "No app keys yet. Add a view under the app line, for example:" });
  card.createEl("pre", { cls: "gz-example", text: "view: countdown\nto: 2027-01-01\nlabel: New year" });
  if (app.hosted) return;
  card.createDiv({ cls: "gz-actions" }).createEl("button", { cls: "mod-cta", text: "Edit source" })
    .addEventListener("click", () => app.env.showSource());
}
