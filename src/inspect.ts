import { isPlainObject } from "./keys.ts";
import { sourceDef } from "./sources/registry.ts";
import { plural } from "./text.ts";

/** One source an app reads, with what it returned before any `pick`, `where` or other step. */
export interface InspectedSource {
  /** The title of the first panel that uses it. */
  title: string;
  /** The web address's host, or "notes: Books", "list: doses", "file: Finance/bank.csv". */
  kind: string;
  /** A web address as typed, `{secret:…}` placeholders unfilled. */
  source?: string;
  /** What the source returned, or `{error: message}` when it couldn't be read. */
  data: unknown;
}

const SECRET = /\{secret:[a-z0-9-]+\}/g;

/** What a panel's source is, in a few words. `from` is the panel's own `from`. */
export function sourceKind(source: string, from: string | undefined): string {
  const id = sourceDef(source).id;
  if (id === "url") {
    try {
      return new URL(source.replace(SECRET, "x")).host;
    } catch {
      return source;
    }
  }
  return `${id}: ${id === "notes" || source === id ? from ?? "" : source}`;
}

/** Text past this many characters is cut in the tree, which is only there to recognise what a value is. */
const PREVIEW_CHARS = 80;
/** Items of a list drawn before "… N more": the first few show what the rest look like. */
const LIST_CAP = 50;
/** How long "Copied" stays beside a key. */
const COPIED_MS = 1000;

type Container = unknown[] | Record<string, unknown>;

const isContainer = (v: unknown): v is Container => Array.isArray(v) || (v !== null && typeof v === "object");

/** How a value looks in one line, and the class that colours it. */
function preview(value: unknown): { text: string; cls: string } {
  if (Array.isArray(value)) return { text: `[…] ${plural(value.length, "item")}`, cls: "gz-t-meta" };
  if (isContainer(value)) return { text: `{…} ${plural(Object.keys(value).length, "key")}`, cls: "gz-t-meta" };
  if (typeof value === "string") {
    const one = value.replace(/\s+/g, " ");
    return { text: `"${one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS)}…` : one}"`, cls: "gz-t-string" };
  }
  if (typeof value === "number") return { text: String(value), cls: "gz-t-number" };
  if (typeof value === "boolean") return { text: String(value), cls: "gz-t-bool" };
  return { text: String(value), cls: "gz-t-null" };
}

/** Puts "Copied" beside a key for a moment. */
function flashing(row: HTMLElement, key: HTMLElement): () => void {
  let badge: HTMLElement | undefined;
  let timer: number | undefined;
  return () => {
    if (!badge) {
      badge = row.createSpan({ cls: "gz-copied", text: "Copied", attr: { role: "status" } });
      row.insertBefore(badge, key.nextSibling);
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      badge?.remove();
      badge = undefined;
    }, COPIED_MS);
  };
}

/** A key as a button: pressing it copies the path to it, as typed in `pick` or `field`. */
function keyButton(row: HTMLElement, label: string, path: string[], copy: (text: string) => void): void {
  const typed = path.join(".");
  const dotted = label.includes(".");
  const title = dotted
    ? `This name has a dot in it. Gizmo reads a name with a dot as one name only when it is the whole path, at the top of the data; elsewhere the dot splits the path. ${typed}`
    : `Copy ${typed}`;
  const key = row.createEl("button", { cls: "gz-key", text: label, title });
  const flash = flashing(row, key);
  key.addEventListener("click", (e) => {
    // Inside a summary, a click would also open or close the node.
    e.preventDefault();
    e.stopPropagation();
    copy(typed);
    flash();
  });
}

function drawChildren(el: HTMLElement, value: Container, path: string[], depth: number, copy: (text: string) => void): void {
  if (Array.isArray(value)) {
    value.slice(0, LIST_CAP).forEach((item, i) => drawNode(el, String(i), item, [...path, String(i)], depth + 1, copy));
    if (value.length > LIST_CAP) el.createDiv({ cls: "gz-inspect-more", text: `… ${value.length - LIST_CAP} more` });
    return;
  }
  for (const [k, v] of Object.entries(value)) drawNode(el, k, v, [...path, k], depth + 1, copy);
}

/**
 * One value in the tree. A list or set of keys is a `<details>` (the top one open); its children
 * are only drawn when it is first opened, so a big response costs nothing until it is explored.
 */
function drawNode(parent: HTMLElement, label: string | undefined, value: unknown, path: string[], depth: number, copy: (text: string) => void): void {
  const { text, cls } = preview(value);
  if (!isContainer(value)) {
    const row = parent.createDiv({ cls: "gz-node gz-leaf" });
    if (label !== undefined) keyButton(row, label, path, copy);
    row.createSpan({ cls: `gz-val ${cls}`, text });
    return;
  }
  const node = parent.createEl("details", { cls: "gz-node" });
  const summary = node.createEl("summary");
  if (label !== undefined) keyButton(summary, label, path, copy);
  summary.createSpan({ cls: `gz-val ${cls}`, text });
  let drawn = false;
  const fill = () => {
    if (drawn) return;
    drawn = true;
    drawChildren(node.createDiv({ cls: "gz-children" }), value, path, depth, copy);
  };
  if (depth === 0) {
    node.setAttribute("open", "");
    fill();
  } else {
    node.addEventListener("toggle", () => { if (node.hasAttribute("open")) fill(); });
  }
}

const isError = (data: unknown): data is { error: string } =>
  isPlainObject(data) && Object.keys(data).length === 1 && typeof data.error === "string";

/**
 * Draws each source into `el`: a heading, then what the source returned as a tree to open and
 * explore. Pressing a key calls `copy` with the path to it, written as `pick` and `field` take it
 * (`features.0.properties.mag`). `focus`, a source's place in `sources`, is scrolled into view.
 */
export function renderInspector(el: HTMLElement, sources: InspectedSource[], copy: (text: string) => void, focus?: number): void {
  el.empty();
  if (sources.length === 0) {
    el.createDiv({ cls: "gz-label", text: "No data to inspect: none of this app's panels reads a source right now." });
    return;
  }
  for (const [i, s] of sources.entries()) {
    const box = el.createDiv({ cls: "gz-inspect-source" });
    const head = box.createDiv({ cls: "gz-inspect-head" });
    head.createSpan({ cls: "gz-inspect-title", text: s.title });
    head.createSpan({ cls: "gz-inspect-kind", text: ` · ${s.kind}` });
    if (s.source) box.createDiv({ cls: "gz-inspect-url", text: s.source });
    if (isError(s.data)) box.createDiv({ cls: "gz-inspect-error", text: s.data.error });
    else drawNode(box.createDiv({ cls: "gz-tree" }), undefined, s.data, [], 0, copy);
    if (i === focus) box.scrollIntoView({ block: "start" });
  }
}
