import type { ViewDef } from "./views/registry.ts";
import type { Position } from "./yamlpos.ts";

/** A change to the note's text: what replaces the range from..to (an insertion when they are the same place). */
export interface Edit {
  from: Position;
  to: Position;
  text: string;
}

export type Insertion = { edit: Edit; cursor: Position } | { refusal: string };

const ONE_PANEL = "This note has one panel typed at the top level; move it under panels: to add more";
const INLINE = "panels: is written on one line; put each panel on its own line under it to add more";

const WORDS = /^(true|false|yes|no|on|off|null|y|n|~)$/i;

/** A value as it can be typed: plain when YAML would read it back as the same text, else in quotes. */
function scalar(value: unknown, flow: boolean): string {
  if (typeof value !== "string") return String(value);
  // A list or set on one line can't hold commas or colons in a plain value.
  const safe = flow ? /^[A-Za-z][\w ./@+%-]*$/ : /^[A-Za-z][\w .:/@+%?=&$,-]*$/;
  const plain = safe.test(value) && !/:(\s|$)|\s#|\s$/.test(value) && !WORDS.test(value);
  return plain ? value : JSON.stringify(value);
}

function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${/^[\w.-]+$/.test(k) ? k : JSON.stringify(k)}: ${inline(v)}`).join(", ")}}`;
  }
  return scalar(value, true);
}

/**
 * The lines of a starter panel for a view, as typed in a note: its first working example, with
 * lists and sets written on one line.
 */
export function skeleton(view: Pick<ViewDef, "examples">): string[] {
  const panel = view.examples.find((e) => !e.errors)?.panel ?? {};
  return Object.entries(panel).map(([key, value]) => `${key}: ${value !== null && typeof value === "object" ? inline(value) : scalar(value, false)}`);
}

/** The line of the closing `---`, when the text opens with a frontmatter. */
function closingFence(lines: string[]): number {
  if (lines[0]?.trimEnd() !== "---") return -1;
  return lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
}

const topKey = (lines: string[], end: number, name: string) => lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${name}\\s*:(\\s|$)`).test(l));

/** Why a panel can't be added to this note without restructuring it, if so. */
export function refusalFor(text: string): string | undefined {
  const found = insertPanel(text, ["view: x"]);
  return "refusal" in found ? found.refusal : undefined;
}

/**
 * Where a new panel goes in a note's text, and where the cursor lands: on the value of the new
 * panel's first line. `item` is the panel's lines (see `skeleton`). The panel becomes the last
 * item of the top-level `panels:` list, written like the items already there; with no `panels:`
 * it is added with its key just before the closing `---`. Only inserts; the rest of the text is
 * left as typed, apart from an empty `[]` after `panels:`, which a list can't follow.
 */
export function insertPanel(text: string, item: string[]): Insertion {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const end = closingFence(lines);
  if (end < 0) return { refusal: "This note has no frontmatter to add a panel to" };

  // The cursor goes on the value of the panel's first line.
  const ch = (pad: string) => pad.length + item[0].indexOf(": ") + 2;
  const panels = topKey(lines, end, "panels");
  if (panels < 0) {
    if (topKey(lines, end, "view") >= 0) return { refusal: ONE_PANEL };
    const pad = "  - ";
    const out = ["panels:", ...item.map((l, i) => (i ? "    " : pad) + l)];
    return {
      edit: { from: { line: end, ch: 0 }, to: { line: end, ch: 0 }, text: out.join(eol) + eol },
      cursor: { line: end + 1, ch: ch(pad) },
    };
  }

  const colon = lines[panels].indexOf(":");
  const value = lines[panels].slice(colon + 1).replace(/(^|\s)#.*$/, "").trim();
  const empty = /^\[\s*\]$/.test(value);
  if (value && !empty) return { refusal: INLINE };

  // The list runs to the next top-level key; a comment at the left edge belongs to neither.
  let last = panels;
  let first: RegExpExecArray | null = null;
  for (let i = panels + 1; i < end; i++) {
    const l = lines[i];
    if (l.trim() === "" || l.startsWith("#")) continue;
    if (/^\S/.test(l) && !/^-(\s|$)/.test(l)) break;
    last = i;
    first ??= /^( *)-( +|$)/.exec(l);
  }
  const dash = first ? first[1].length : 2;
  const gap = first && first[2].length ? first[2].length : 1;
  const pad = `${" ".repeat(dash)}-${" ".repeat(gap)}`;
  const cont = " ".repeat(pad.length);
  const added = item.map((l, i) => (i ? cont : pad) + l);

  const cursor = { line: (empty ? panels : last) + 1, ch: ch(pad) };
  if (empty) {
    // The brackets go, and a comment after them stays on the key's line.
    const comment = lines[panels].slice(lines[panels].indexOf("]") + 1);
    return { edit: { from: { line: panels, ch: colon + 1 }, to: { line: panels, ch: lines[panels].length }, text: comment + eol + added.join(eol) }, cursor };
  }
  const after = { line: last, ch: lines[last].length };
  return { edit: { from: after, to: after, text: eol + added.join(eol) }, cursor };
}
