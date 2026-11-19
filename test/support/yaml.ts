import { readFileSync } from "node:fs";

/**
 * Enough YAML to read the fixture notes' frontmatter in tests: block maps and lists, one-line
 * flow [lists] and {maps}, quoted and plain scalars. Not a YAML parser; Obsidian reads the real notes.
 */
export function parseYaml(text: string): unknown {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !l.trim().startsWith("#"));
  let i = 0;
  const indent = (l: string) => l.length - l.trimStart().length;
  const isItem = (l: string) => /^-(\s|$)/.test(l.trimStart());
  const keyLine = (s: string) => s.match(/^("[^"]*"|'[^']*'|[^\s"'[{#-][^:]*?):(?:\s+(.*))?$/);

  const block = (): unknown => (isItem(lines[i]) ? list(indent(lines[i])) : map(indent(lines[i])));
  const map = (at: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (i < lines.length && indent(lines[i]) === at && !isItem(lines[i])) {
      const m = keyLine(lines[i].trim());
      if (!m) throw new Error(`can't read line: ${lines[i]}`);
      i++;
      const key = /^["']/.test(m[1]) ? m[1].slice(1, -1) : m[1];
      const next = lines[i];
      const nested = next !== undefined && (indent(next) > at || (indent(next) === at && isItem(next)));
      out[key] = m[2] !== undefined && m[2] !== "" ? scalar(m[2]) : nested ? block() : null;
    }
    return out;
  };
  const list = (at: number): unknown[] => {
    const out: unknown[] = [];
    while (i < lines.length && indent(lines[i]) === at && isItem(lines[i])) {
      const rest = lines[i].trimStart().slice(1).trimStart();
      if (rest === "") {
        i++;
        out.push(block());
      } else if (keyLine(rest)) {
        // "- key: value": a map whose keys line up after the dash.
        lines[i] = `${" ".repeat(at + 2)}${rest}`;
        out.push(map(at + 2));
      } else {
        i++;
        out.push(scalar(rest));
      }
    }
    return out;
  };
  return lines.length ? block() : null;
}

function scalar(text: string): unknown {
  const s = text.trim();
  if (s.startsWith("[") || s.startsWith("{")) return flow(s, { at: 0 });
  return plain(s);
}

function plain(s: string): unknown {
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "true" || s === "false") return s === "true";
  if (s === "null" || s === "~" || s === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function flow(s: string, pos: { at: number }): unknown {
  const open = s[pos.at++];
  const close = open === "[" ? "]" : "}";
  const items: unknown[] = [];
  const map: Record<string, unknown> = {};
  const skip = () => { while (s[pos.at] === " ") pos.at++; };
  const word = (stops: string) => {
    skip();
    if (s[pos.at] === "[" || s[pos.at] === "{") return flow(s, pos);
    let out = "";
    if (s[pos.at] === '"' || s[pos.at] === "'") {
      const q = s[pos.at];
      const end = s.indexOf(q, pos.at + 1);
      out = s.slice(pos.at, end + 1);
      pos.at = end + 1;
      return plain(out);
    }
    while (pos.at < s.length && !stops.includes(s[pos.at])) out += s[pos.at++];
    return plain(out.trim());
  };
  skip();
  while (s[pos.at] !== close) {
    if (open === "[") items.push(word(",]"));
    else {
      const key = String(word(":"));
      pos.at++;
      map[key] = word(",}");
    }
    skip();
    if (s[pos.at] === ",") pos.at++;
    skip();
  }
  pos.at++;
  return open === "[" ? items : map;
}

/** A note in test/vault: its frontmatter and the text after it. */
export function vaultNote(path: string): { fm: Record<string, unknown>; body: string } {
  const text = readFileSync(new URL(`../vault/${path}`, import.meta.url), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return { fm: (m ? parseYaml(m[1]) : {}) as Record<string, unknown>, body: m ? text.slice(m[0].length) : text };
}
