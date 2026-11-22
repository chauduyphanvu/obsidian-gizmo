/**
 * Where the cursor is in a note's hand-typed frontmatter, and where an error's panel or block
 * starts. The text is often half typed and not valid YAML, so nothing here parses it: lines are
 * read by indentation alone, and anything unclear (a flow map, a multi-line string, a comment, a
 * tab) is reported as "other" rather than guessed at.
 */

/** What the cursor sits in: the note's own keys, a panel's, a data block's, or a map of another kind. */
export type Where = "top" | "panel" | "block" | "inputs" | "with" | "fields" | "other";

export interface Position {
  line: number;
  ch: number;
}

export interface Context {
  where: Where;
  position: "key" | "value";
  /** The key whose value is being typed (value positions only). */
  key?: string;
  /** What is typed so far of the key or value. */
  prefix: string;
  /** The value is one item of a list typed on one line, `columns: [at, am`, and `prefix` is that item. */
  inList?: true;
  /** The `view:` of the same list item (where is "panel"), or at the top of a single-panel note. */
  view?: string;
  /** Keys already typed in the same map, apart from the cursor's own line. */
  present: string[];
  /** Where the text to replace starts; it ends at the cursor. */
  from: Position;
}

interface Line {
  /** Column of the first "- " when the line starts a list item. */
  dash?: number;
  /** Column where the line's own content starts, after its indentation and any "- ". */
  col: number;
  key?: string;
  /** Column of the colon after `key`. */
  colon?: number;
  /** The text after `key:`, without quotes or a trailing comment. */
  value: string;
  /** Not structure: blank, a comment, tab-indented, or part of a multi-line value. */
  skip: boolean;
  /** Part of a multi-line value: a block scalar, a flow collection or a quote that runs on. */
  inside: boolean;
  /** A blank line in the middle of such a value: text typed deeper than this column goes on with it. */
  within?: number;
}

const KEY = /^("[^"]*"|'[^']*'|[^\s"'#[\]{}&*!|>%@`,-][^:#]*?)\s*:(?=\s|$)/;

function plainValue(raw: string): string {
  const v = raw.trim();
  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const end = v.indexOf(quote, 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  return v.replace(/(^|\s)#.*$/, "").trim();
}

function parseLine(text: string): Line {
  const lead = /^ */.exec(text)![0].length;
  if (text[lead] === "\t") return { col: lead, value: "", skip: true, inside: false };
  let col = lead;
  let dash: number | undefined;
  let rest = text.slice(lead);
  for (let m = /^-(?: +|$)/.exec(rest); m; m = /^-(?: +|$)/.exec(rest)) {
    dash ??= col;
    col += Math.max(m[0].length, 2);
    rest = rest.slice(m[0].length);
  }
  const blank = rest.trim() === "" && dash === undefined;
  const key = KEY.exec(rest);
  const line: Line = { col, value: "", skip: blank || rest.startsWith("#"), inside: false };
  if (dash !== undefined) line.dash = dash;
  if (key) {
    line.key = /^["']/.test(key[1]) ? key[1].slice(1, -1) : key[1].trim();
    line.colon = col + key[0].length - 1;
    line.value = plainValue(rest.slice(key[0].length));
  }
  return line;
}

/** How a flow collection or quote that started on one line stands at the end of it. */
function flowState(text: string, depth: number, quote: string): { depth: number; quote: string } {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = "";
      }
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(text[i - 1]))) quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) break;
  }
  return { depth, quote };
}

/** A value that runs over several lines, as it stands after the lines read so far. */
type Run = { kind: "indented"; parent: number } | { kind: "flow"; depth: number; quote: string };

/** The run a line starts, from the text after its `key:` (or its "- "). */
function runAfter(raw: string, line: Line): Run | undefined {
  const v = raw.trim();
  if (!v || v.startsWith("#")) return undefined;
  if (/^[|>]/.test(v)) return { kind: "indented", parent: line.key !== undefined ? line.col : line.dash ?? line.col };
  if (/^[[{"']/.test(v)) {
    const state = flowState(v, 0, "");
    return state.depth > 0 || state.quote ? { kind: "flow", ...state } : undefined;
  }
  return line.key !== undefined ? { kind: "indented", parent: line.col } : undefined;
}

/** The lines between the `---` fences, read once. */
interface Frontmatter {
  lines: string[];
  /** The line of the closing `---`. */
  end: number;
  /** One entry per line from 1 to end - 1. */
  rows: Line[];
}

function frontmatter(raw: string[]): Frontmatter | undefined {
  if (raw.length < 2 || raw[0].trimEnd() !== "---") return undefined;
  const end = raw.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return undefined;
  const lines = raw.slice(0, end + 1).map((l) => l.replace(/\r$/, ""));
  const rows: Line[] = [];
  let run: Run | undefined;
  for (let i = 1; i < end; i++) {
    const text = lines[i];
    if (run?.kind === "flow") {
      const state = flowState(text, run.depth, run.quote);
      run = state.depth > 0 || state.quote ? { kind: "flow", ...state } : undefined;
      rows[i] = { col: 0, value: "", skip: true, inside: true };
      continue;
    }
    if (run) {
      const indent = /^[ \t]*/.exec(text)![0].length;
      if (text.trim() === "") {
        rows[i] = { col: indent, value: "", skip: true, inside: false, within: run.parent };
        continue;
      }
      if (indent > run.parent) {
        rows[i] = { col: indent, value: "", skip: true, inside: true };
        continue;
      }
      run = undefined;
    }
    const row = parseLine(text);
    rows[i] = row;
    if (!row.skip) run = runAfter(text.slice(row.key !== undefined ? row.colon! + 1 : row.col), row);
  }
  return { lines, end, rows };
}

/** The line of the top-level key with this name. */
function topKey(fm: Frontmatter, name: string): number | undefined {
  for (let i = 1; i < fm.end; i++) {
    const row = fm.rows[i];
    if (!row.skip && row.col === 0 && row.dash === undefined && row.key === name) return i;
  }
  return undefined;
}

/**
 * Whether the note is an app or a component, from its top-level keys. The metadata cache lags
 * while typing, so the text is read instead.
 */
export function noteKind(raw: string[]): "app" | "component" | undefined {
  const fm = frontmatter(raw);
  if (!fm) return undefined;
  if (topKey(fm, "app") !== undefined) return "app";
  return topKey(fm, "component") !== undefined ? "component" : undefined;
}

type Hop = { key: string } | { item: true };

/**
 * The keys and list items the map at column `col` sits inside, innermost first, read upward from
 * `line`. `dashed` says the cursor's own line starts a list item. Undefined when the lines above
 * don't make a structure (a stray word, no key to own a list).
 */
function hopsAbove(rows: Line[], line: number, col: number, dash: number | undefined): Hop[] | undefined {
  const hops: Hop[] = [];
  const enter = (x: Line) => {
    if (x.dash === undefined) return;
    hops.push({ item: true });
    dash = x.dash;
  };
  if (dash !== undefined) hops.push({ item: true });
  for (let j = line - 1; j >= 1; j--) {
    const x = rows[j];
    if (x.skip) continue;
    if (dash === undefined) {
      if (x.col > col) continue;
      if (x.col === col) {
        enter(x);
        continue;
      }
      if (x.key === undefined) return undefined;
      hops.push({ key: x.key });
      col = x.col;
      enter(x);
    } else {
      if (x.dash === dash || x.col > dash) continue;
      if (x.key === undefined) return undefined;
      hops.push({ key: x.key });
      col = x.col;
      dash = undefined;
      enter(x);
    }
  }
  return dash === undefined && col === 0 ? hops : undefined;
}

function whereOf(hops: Hop[]): Where {
  const path = [...hops].reverse();
  const key = (i: number) => ("key" in path[i] ? path[i].key : undefined);
  const item = (i: number) => "item" in path[i];
  if (path.length === 0) return "top";
  if (path.length === 1) return key(0) === "inputs" ? "inputs" : key(0) === "with" ? "with" : "other";
  if (path.length === 2) {
    if (key(0) === "panels" && item(1)) return "panel";
    return key(0) === "data" && key(1) !== undefined ? "block" : "other";
  }
  // A panel listed under a tab, `tabs: {Score: [ ... ]}`, is a panel one level down.
  const tabbed = key(0) === "tabs" && key(1) !== undefined && path.length >= 3 && item(2);
  if (tabbed) return path.length === 3 ? "panel" : path.length === 4 && (key(3) === "with" || key(3) === "fields") ? key(3) as Where : "other";
  if (path.length === 3 && key(2) === "with" && key(0) === "panels" && item(1)) return "with";
  if (path.length === 3 && key(2) === "fields" && ((key(0) === "panels" && item(1)) || (key(0) === "data" && key(1) !== undefined))) return "fields";
  return "other";
}

/** The other lines of the map the cursor's line is in, in the order they are written. */
function siblings(fm: Frontmatter, line: number, col: number, dashed: boolean): Line[] {
  const before: Line[] = [];
  if (!dashed) {
    for (let j = line - 1; j >= 1; j--) {
      const x = fm.rows[j];
      if (x.skip || x.col > col) continue;
      if (x.col < col) break;
      before.unshift(x);
      if (x.dash !== undefined) break;
    }
  }
  const after: Line[] = [];
  for (let j = line + 1; j < fm.end; j++) {
    const x = fm.rows[j];
    if (x.skip || x.col > col) continue;
    if (x.col < col || x.dash !== undefined) break;
    after.push(x);
  }
  return [...before, ...after];
}

/**
 * Where the cursor is in a note, from its lines (with or without line endings) and the cursor's
 * 0-based line and column. Undefined outside the frontmatter. Position and replacement start
 * are only reported where something could be suggested; otherwise `where` is "other".
 */
export function contextAt(raw: string[], line: number, ch: number): Context | undefined {
  const fm = frontmatter(raw);
  if (!fm || line < 1 || line >= fm.end) return undefined;
  const text = fm.lines[line];
  ch = Math.max(0, Math.min(ch, text.length));
  const other = (): Context => ({ where: "other", position: "key", prefix: "", present: [], from: { line, ch } });
  const row = fm.rows[line];
  const lead = /^ */.exec(text)![0].length;
  const blank = text.trim() === "";
  if (row.inside || (blank && row.within !== undefined && ch > row.within) || text[lead] === "\t" || text.slice(lead).startsWith("#") || (!blank && ch < row.col)) return other();

  let position: Context["position"] = "key";
  let key: string | undefined;
  let prefix: string;
  let from = ch;
  let inList = false;
  if (blank) {
    prefix = "";
  } else if (row.key !== undefined && ch > row.colon!) {
    // Right after the colon the space is still to come.
    if (ch === row.colon! + 1) return other();
    const start = row.colon! + 1 + /^ */.exec(text.slice(row.colon! + 1))![0].length;
    const typed = ch >= start ? text.slice(start, ch) : "";
    // The last item of a list on one line, its closing bracket typed already (an editor pairs it) or still to come.
    const item = /^\[(?:[^[\]{}"'#,]*,)*\s*([^[\]{}"'#,]*)$/.exec(typed);
    if (item && /^\s*\]?\s*$/.test(text.slice(ch))) {
      prefix = item[1];
      inList = true;
      from = ch - prefix.length;
    } else {
      if (text.slice(ch).trim() !== "") return other();
      prefix = typed;
      if (/^[[{"'|>&*!#%@`]/.test(prefix) || /(^|\s)#/.test(prefix)) return other();
      from = ch >= start ? start : ch;
    }
    position = "value";
    key = row.key;
  } else {
    prefix = text.slice(row.col, ch);
    const tail = text.slice(ch, row.key !== undefined ? row.colon : text.length);
    if (!/^[\w.-]*$/.test(prefix) || tail.trim() !== "") return other();
    from = row.col;
  }

  const col = blank ? ch : row.col;
  const dash = blank ? undefined : row.dash;
  const hops = hopsAbove(fm.rows, line, col, dash);
  const where = hops ? whereOf(hops) : "other";
  if (where === "other") return other();
  const around = siblings(fm, line, col, dash !== undefined);
  const view = around.find((x) => x.key === "view" && x.value)?.value;
  const context: Context = {
    where,
    position,
    prefix,
    present: around.flatMap((x) => (x.key === undefined ? [] : [x.key])),
    from: { line, ch: from },
  };
  if (key !== undefined) context.key = key;
  if (inList) context.inList = true;
  if ((where === "panel" || where === "top") && view) context.view = view;
  return context;
}

/**
 * The value typed for `key` in the map the cursor is in (a panel's `source:`, say), wherever in that
 * map it is written; undefined when it isn't there.
 */
export function valueBeside(raw: string[], line: number, ch: number, key: string): string | undefined {
  const fm = frontmatter(raw);
  if (!fm || line < 1 || line >= fm.end) return undefined;
  const blank = fm.lines[line].trim() === "";
  const row = fm.rows[line];
  return siblings(fm, line, blank ? ch : row.col, !blank && row.dash !== undefined).find((x) => x.key === key && x.value)?.value;
}

// ---- Errors that name a place ---------------------------------------------------------------------

/** The thing an error message starts by naming. */
export type Label = { kind: "panel"; n: number } | { kind: "tab"; tab: string; n: number } | { kind: "data" | "input"; name: string };

/**
 * What an error from `readSpec` names at its start: `panel 2`, `panel 2 (from [[Ticker]] panel 1)`,
 * `tabs.Score panel 1`, `data.quakes`, `inputs.period`, `input "period"`. Anything else, such as a message with no
 * location, names nothing. Takes the whole message or just its label.
 */
export function labelOf(error: string): Label | undefined {
  const panel = /^panel (\d+)(?: \(from .*?\))?(?=: |$)/.exec(error);
  if (panel) return { kind: "panel", n: Number(panel[1]) };
  const tab = /^tabs\.(.+?) panel (\d+)(?: \(from .*?\))?(?=: |$)/.exec(error);
  if (tab) return { kind: "tab", tab: tab[1], n: Number(tab[2]) };
  const data = /^data\.(.+?)(?=: | → | needs a source| must be a set of keys| use each other| is more than|$)/.exec(error);
  if (data) return { kind: "data", name: data[1] };
  const input = /^inputs\.(.+?)(?=: | must be |$)/.exec(error) ?? /^input "([^"]*)"/.exec(error) ?? /^inputs: "([^"]*)"/.exec(error);
  return input ? { kind: "input", name: input[1] } : undefined;
}

/** The line of the key named `name` inside the map `parent` opens, or the parent's own line for a map written on one line. */
function childKey(fm: Frontmatter, parent: number, name: string): number | undefined {
  const above = fm.rows[parent].col;
  if (fm.rows[parent].value) return parent;
  let col: number | undefined;
  for (let i = parent + 1; i < fm.end; i++) {
    const row = fm.rows[i];
    if (row.skip) continue;
    if (col === undefined) {
      if (row.col <= above || row.dash !== undefined) return undefined;
      col = row.col;
    } else if (row.col <= above || row.col < col) {
      return undefined;
    }
    if (row.col === col && row.key === name) return i;
  }
  return undefined;
}

/** The line of the Nth item of the list under the key on line `list` (the top-level `panels:`, a tab under `tabs:`). */
function itemLine(fm: Frontmatter, list: number | undefined, n: number): number | undefined {
  if (list === undefined) return undefined;
  let dash: number | undefined;
  let seen = 0;
  for (let i = list + 1; i < fm.end; i++) {
    const row = fm.rows[i];
    if (row.skip) continue;
    dash ??= row.dash;
    if (dash === undefined) return undefined;
    if (row.dash === dash) {
      if (++seen === n) return i;
    } else if (row.col <= dash) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The 0-based line where the thing an error names starts: the Nth panel (of `panels`, or of a tab
 * in `tabs`), a data block, an input.
 * `label` is the error message or its leading label; undefined when it names nothing this note has.
 */
export function lineOf(raw: string[], label: string): number | undefined {
  const fm = frontmatter(raw);
  const target = labelOf(label);
  if (!fm || !target) return undefined;
  if (target.kind === "panel") return itemLine(fm, topKey(fm, "panels"), target.n);
  if (target.kind === "tab") {
    const tabs = topKey(fm, "tabs");
    return itemLine(fm, tabs === undefined ? undefined : childKey(fm, tabs, target.tab), target.n);
  }
  const section = topKey(fm, target.kind === "data" ? "data" : "inputs");
  return section === undefined ? undefined : childKey(fm, section, target.name);
}

/**
 * The 0-based line a panel starts on, by where it is written (`panel 2`, `tabs.Score panel 1`); a
 * note that is one panel, written with no label, starts at its `view:`.
 */
export function panelLine(raw: string[], label: string): number | undefined {
  if (label) return lineOf(raw, label);
  const fm = frontmatter(raw);
  return fm && topKey(fm, "view");
}
