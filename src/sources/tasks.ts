import type { Row } from "../data.ts";
import { notesDep } from "../deps.ts";
import { fenceStep } from "../fences.ts";
import type { SourceDef } from "./types.ts";

/** One checkbox line of a note. `line` counts from 0 at the top of the file. */
export interface Task {
  text: string;
  done: boolean;
  status: string;
  line: number;
  due: string | null;
  tags: string[];
}

/**
 * A list item with a checkbox: indentation, a bullet (-, *, +) or number (1. or 1)), a space,
 * `[c]`, a space, the text. Groups: everything before the status character, the status, the text.
 */
const TASK = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)(.)\][ \t](.*)$/u;
const DUE = /📅\s*(\d{4}-\d{2}-\d{2})|due::\s*(\d{4}-\d{2}-\d{2})/u;
const TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;

interface Found {
  line: number;
  /** Where the status character starts in the line. */
  at: number;
  status: string;
  text: string;
}

/** The task lines of a note's text; lines in its frontmatter or in a code block aren't tasks. */
function scan(lines: string[]): Found[] {
  const out: Found[] = [];
  let i = 0;
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && l.trimEnd() === "---");
    if (end > 0) i = end + 1;
  }
  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, "");
    const step = fenceStep(fence, l);
    fence = step.open;
    if (step.code) continue;
    const m = l.match(TASK);
    if (m) out.push({ line: i, at: m[1].length, status: m[2], text: m[3].trimEnd() });
  }
  return out;
}

/** Every task in a note's text, nested ones included. */
export function parseTasks(text: string): Task[] {
  return scan(text.split("\n")).map(({ line, status, text: t }) => {
    const due = t.match(DUE);
    const tags = [...t.matchAll(TAG)].map((m) => m[1]).filter((tag) => !/^\d+$/.test(tag)).map((tag) => `#${tag}`);
    return { text: t, done: status === "x" || status === "X", status, line, due: due ? due[1] ?? due[2] : null, tags };
  });
}

/**
 * The note's text with one task ticked (status `x`) or unticked (a space): the task on `line` if
 * it still reads `text`, else the only other task that does (lines move when text is added above).
 * Only that status character changes. Undefined, meaning write nothing, when no task or more than
 * one other task reads `text`.
 */
export function tickLine(fileText: string, line: number, text: string, done: boolean): string | undefined {
  const lines = fileText.split("\n");
  const same = scan(lines).filter((t) => t.text === text);
  const task = same.find((t) => t.line === line) ?? (same.length === 1 ? same[0] : undefined);
  if (!task) return undefined;
  if (done ? task.status === "x" || task.status === "X" : task.status === " ") return fileText;
  const l = lines[task.line];
  lines[task.line] = `${l.slice(0, task.at)}${done ? "x" : " "}${l.slice(task.at + task.status.length)}`;
  return lines.join("\n");
}

/** `source: tasks`: one row per checkbox line in the notes of the `from` scopes. */
export const tasks: SourceDef = {
  id: "tasks",
  matches: (source) => source === "tasks",
  validate: (p) => (p.from ? [] : ['source "tasks" needs "from" (a #tag or folder)']),
  permissions: (p) => (p.from ? [[`read:${p.from}`, "from"]] : []),
  // Any change to a note in scope is heard under this key, a change to its text alone included.
  deps: (p) => [notesDep(p.from ?? "")],
  async load(p, _files, layer) {
    const notes = layer.notes(p.from ?? "");
    // A note deleted while this loads has no tasks; its deletion reloads the panel anyway.
    const found = await Promise.all(notes.map((n) => layer.parseNote(String(n.path), parseTasks).catch(() => [] as Task[])));
    return notes.flatMap((n, i): Row[] => found[i].map((t) => ({
      text: t.text, done: t.done, status: t.status, path: n.path, name: n.name, line: t.line, due: t.due, tags: [...t.tags],
    })));
  },
};
