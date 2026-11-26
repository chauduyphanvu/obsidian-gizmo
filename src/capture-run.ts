/**
 * Running a capture line, on any host the runtime runs in: what Enter does with it (asks, a what-if,
 * a line it can't read, or a run), which app a what-if is tried in, what the run is told as, and the
 * one row a run saved. The line box, the editor's `;;` and the notices are the host's.
 */
import { parseWhatIf, whatIfLine } from "./ahead.ts";
import { askLine } from "./ask.ts";
import { plannedText, whenText, type CaptureTarget, type Parsed } from "./capture.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { kindOfPanel } from "./sources/kind.ts";

/**
 * What a line that can run runs, and for when if not now: `Budget: Spent something at Thu Nov 19,
 * 13:00`; for a kind, `planned for` a time still to come, or each time of an `@every`.
 */
export function runsText(parsed: Parsed & { ok: true }, now: Date): string {
  const when = parsed.at && (plannedText({ at: parsed.at, plan: parsed.plan }, now) ?? `at ${whenText(parsed.at, now)}`);
  return `${parsed.target.app}: ${parsed.target.label}${when ? ` ${when}` : ""}`;
}

/**
 * The app a `what if` line is tried in: the app `open` in the active tab, when the line saves to a
 * kind that app reads or saves to; else the app the line's shortcut is in.
 */
export function whatIfAppOf(rt: GizmoRuntime, target: CaptureTarget, open: string | undefined): string {
  const kindIn = (path: string, shortcut?: string) => rt.background.spec(path)?.panels
    .filter((ps) => shortcut === undefined || ps.panel.shortcut === shortcut)
    .map((ps) => kindOfPanel(ps.panel)?.path)
    .filter((p): p is string => p !== undefined) ?? [];
  const [kind] = kindIn(target.path, target.shortcut);
  return kind !== undefined && open !== undefined && kindIn(open).includes(kind) ? open : target.path;
}

/** What a run is told as: what it said, as a sentence, or that the line ran. */
export function capturedText(line: string, told: string | undefined): string {
  return told === undefined ? `Ran “${line}”.` : /[.!?]$/.test(told) ? told : `${told}.`;
}

/** The id of the one row a run saved, from its entry in the activity log; undefined when it saved none, or several. */
export async function singleRowAdded(rt: GizmoRuntime, entryId: string | undefined): Promise<string | undefined> {
  const entry = entryId === undefined ? undefined : await rt.activity.get(entryId);
  const added = entry?.changes.filter((c) => c.kind === "row-added") ?? [];
  return added.length === 1 && added[0].kind === "row-added" ? added[0].id : undefined;
}

/** What Enter on a line came to. */
export type Submitted =
  | { kind: "empty" }
  /** A question for the ask pane: it saves nothing, and its answer is shown at once. */
  | { kind: "ask" }
  /** A line it couldn't read: shown where it was typed. */
  | { kind: "unread" }
  /** A what-if, to be shown ahead in this app; nothing real is run. */
  | { kind: "what-if"; app: string; line: string }
  /** It ran and failed, and has said why itself. */
  | { kind: "failed" }
  /** It ran: what to tell, once, with Undo for its entry when it changed something. */
  | { kind: "ran"; text: string; entryId?: string };

/**
 * Enter on a capture line: `asks` when the host has an ask pane for `?` lines, `open` the app in
 * the active tab, and `busy` told while the line runs.
 */
export async function submitLine(
  rt: GizmoRuntime, input: string, opts: { asks: boolean; open?: string; busy?: (busy: boolean) => void; now?: Date },
): Promise<Submitted> {
  const line = input.trim();
  if (!line) return { kind: "empty" };
  if (opts.asks && askLine(input) !== undefined) return { kind: "ask" };
  const bg = rt.background;
  const whatIf = whatIfLine(input);
  if (whatIf !== undefined) {
    const parsed = parseWhatIf(whatIf, bg.captureIndex(), opts.now ?? new Date());
    return parsed.ok ? { kind: "what-if", app: whatIfAppOf(rt, parsed.target, opts.open), line: whatIf } : { kind: "unread" };
  }
  opts.busy?.(true);
  try {
    // What it did is told once, by the host, with Undo, not also by the run.
    const result = await bg.capture(line, undefined, true);
    if (!result.ok) return result.parsed.ok ? { kind: "failed" } : { kind: "unread" };
    return { kind: "ran", text: capturedText(line, result.told), entryId: result.entryId };
  } finally {
    opts.busy?.(false);
  }
}
