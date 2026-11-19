import { AppController, newMemory, type AppEnv, type AppMemory, type Hosting } from "./app.ts";
import { basename, linkOf } from "./expand.ts";
import { isPlainObject } from "./views/common.ts";

/**
 * What a `note-app` block holds: an app's keys, as an app note's frontmatter holds them (`embed`),
 * or a link to an app note and which of its panels to show (`app`).
 */
export type HostedBlock =
  | { kind: "embed"; definition: Record<string, unknown> }
  | { kind: "app"; link: string; panels?: string[] }
  | { error: string };

/** `app: "[[Meds]]"`, or the same without quotes (YAML for a list holding a list). */
function appLink(value: unknown): string | undefined {
  const unquoted = Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 1;
  return unquoted || (typeof value === "string" && /^\s*\[\[[^\]]+\]\]\s*$/.test(value)) ? linkOf(value) : undefined;
}

/**
 * Checks a block's keys (already read as YAML). Anything an app note's frontmatter holds may go in
 * one, without the `app:` line; `app` as a link instead shows that app, with nothing beside it but
 * `panels`, a list of the titles or labels of the panels to show.
 */
export function parseHosted(value: unknown): HostedBlock {
  if (value === null || value === undefined) return { kind: "embed", definition: { app: "" } };
  if (!isPlainObject(value)) return { error: "a note-app block holds an app's keys, e.g. view: countdown" };
  const link = appLink(value.app);
  if (link === undefined) {
    const app = value.app === undefined || value.app === null || value.app === false ? "" : value.app;
    return { kind: "embed", definition: { ...value, app } };
  }
  const others = Object.keys(value).filter((k) => k !== "app" && k !== "panels");
  if (others.length) return { error: `beside app: "[[${link}]]" only panels can go` };
  if (value.panels === undefined || value.panels === null) return { kind: "app", link };
  const panels = value.panels;
  if (!Array.isArray(panels) || panels.length === 0 || !panels.every((p) => typeof p === "string" || typeof p === "number")) {
    return { error: "panels must be a list of panel titles, e.g. panels: [Took meds]" };
  }
  return { kind: "app", link, panels: panels.map(String) };
}

/** A block's identity for grants and kept state: its note and a hash of its text, so changing the text asks again. */
export function blockKey(hostPath: string, source: string): string {
  const text = source.trimEnd();
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${hostPath}#${(h >>> 0).toString(36)}`;
}

/** The grant keys that belong to a note: its own (an app's) and its embeds' (`<path>#<hash>`). */
function grantKeysOf(grants: Record<string, string>, path: string): string[] {
  return Object.keys(grants).filter((k) => k === path || k.startsWith(`${path}#`));
}

/** Moves a renamed note's grants, its embeds' included; true when there were any. */
export function moveGrants(grants: Record<string, string>, oldPath: string, path: string): boolean {
  const keys = grantKeysOf(grants, oldPath);
  for (const key of keys) {
    const value = grants[key];
    delete grants[key];
    grants[path + key.slice(oldPath.length)] = value;
  }
  return keys.length > 0;
}

/** Drops a deleted note's grants, its embeds' included; true when there were any. */
export function dropGrants(grants: Record<string, string>, path: string): boolean {
  const keys = grantKeysOf(grants, path);
  for (const key of keys) delete grants[key];
  return keys.length > 0;
}

/**
 * What the embeds in open notes keep (input values, selections, the open tab, timers), by block,
 * so a block drawn again keeps them: the editor redraws a block whenever the cursor leaves it or it
 * scrolls back into view. Forgotten once its note is no longer open, as an app's are when closed.
 */
export class Memories {
  private kept = new Map<string, { hostPath: string; memory: AppMemory }>();

  of(key: string, hostPath: string): AppMemory {
    let entry = this.kept.get(key);
    if (!entry) this.kept.set(key, (entry = { hostPath, memory: newMemory() }));
    return entry.memory;
  }

  /** Forgets the blocks of notes that aren't open any more. */
  keepOnly(open: ReadonlySet<string>): void {
    for (const [key, entry] of this.kept) if (!open.has(entry.hostPath)) this.kept.delete(key);
  }

  clear(): void {
    this.kept.clear();
  }
}

/**
 * One `note-app` block drawn in a note. With an app's keys it runs as its own app (grants under
 * its block key, data in the note's `<Note> data.md` unless `store` says otherwise). With a link it
 * runs that app note's keys as that app (its grants and data note), showing the panels `panels`
 * names; while the link finds no note it says so, and tries again when a note of that name appears.
 * `$this` is the note the block is in, either way.
 */
export class HostedApp {
  private root: HTMLElement;
  private block: HostedBlock;
  private key: string;
  private hostPath: string;
  private env: AppEnv;
  private memory: AppMemory;
  private controller: AppController | undefined;
  private shell: HTMLElement | undefined;
  private appPath: string | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(root: HTMLElement, value: unknown, source: string, hostPath: string, env: AppEnv, memory?: AppMemory) {
    this.root = root;
    this.block = parseHosted(value);
    this.key = blockKey(hostPath, source);
    this.hostPath = hostPath;
    this.env = env;
    this.memory = memory ?? newMemory();
  }

  /** The block's identity: what its grants and kept state go under. */
  get identity(): string {
    return this.key;
  }

  load(): void {
    const block = this.block;
    if ("error" in block) return this.showError(block.error);
    if (block.kind === "embed") {
      this.start(this.hostPath, { kind: "embed", grantKey: this.key, hostPath: this.hostPath, definition: () => block.definition, memory: this.memory });
      return;
    }
    this.unsubscribe = this.env.data.subscribe([`name:${basename(block.link)}`], () => {
      if (this.env.notes.resolve(block.link, this.hostPath) !== this.appPath) this.linkApp(block.link, block.panels);
    });
    this.linkApp(block.link, block.panels);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stop();
  }

  resize(): void {
    this.controller?.resize();
  }

  /** Looks again at whether the app is allowed, which may have changed in another tab. */
  recheck(): void {
    this.controller?.recheck();
  }

  private linkApp(link: string, panels: string[] | undefined): void {
    this.stop();
    const appPath = this.env.notes.resolve(link, this.hostPath);
    this.appPath = appPath;
    if (!appPath) return this.showError(`Can't find [[${link}]]`);
    const env = this.env;
    this.start(appPath, { kind: "app", grantKey: appPath, hostPath: this.hostPath, definition: () => env.frontmatter(appPath), panels, memory: this.memory });
  }

  private start(appPath: string, hosting: Hosting): void {
    this.controller = new AppController(this.root, appPath, this.env, hosting);
    this.controller.load();
  }

  private stop(): void {
    this.controller?.dispose();
    this.controller = undefined;
    this.shell?.remove();
    this.shell = undefined;
  }

  private showError(text: string): void {
    this.shell = this.root.createDiv({ cls: "note-app" });
    this.shell.createDiv({ cls: "na-card na-error", text });
  }
}
