import type { Row } from "../data.ts";

const SUMMARY_MAX = 500;

const pad = (n: number) => String(n).padStart(2, "0");

const NAMED = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "]]);

/*
 * Feeds come from anyone, so nothing here backtracks: each scanner moves forward through the text,
 * and a tag that never ends stops the scan, since no later one can end either. Regexes that look
 * for an element's end after each start took minutes on a megabyte of starts with no ends.
 */

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED.get(name) ?? all;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * Text with A–Z in lower case and every other character as it was, so positions in it are
 * positions in the text (toLowerCase makes "İ" two characters). It is also how the regexes this
 * replaced matched tag names, ignoring case only in ASCII.
 */
const lowerAscii = (text: string) => text.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** Where `</name` followed by optional space and `>` first starts at or after `from` (any case), with where it ends. */
function closeOf(text: string, lower: string, name: string, from: number): { start: number; end: number } | undefined {
  const needle = `</${name}`;
  for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, at + 1)) {
    let i = at + needle.length;
    while (isSpace(text[i])) i++;
    if (text[i] === ">") return { start: at, end: i + 1 };
  }
  return undefined;
}

/** An element `<name …>content</name>` in `text` (any case), as the regex `<name(\s[^>]*)?>([\s\S]*?)</name\s*>` reads one. */
interface Element {
  start: number;
  end: number;
  /** What follows the name inside the start tag (from its first space), or undefined when nothing does. */
  attrs: string | undefined;
  content: string;
}

/** Every element of these names in order, none inside another found before it; `lower` is `text` in lower case. */
function* elements(text: string, lower: string, names: string[]): Generator<Element> {
  /** Names with no end after some start: no later start of them can end either. */
  const unended = new Set<string>();
  for (let at = lower.indexOf("<"); at !== -1; at = lower.indexOf("<", at + 1)) {
    const name = names.find((n) => lower.startsWith(n, at + 1) && !unended.has(n));
    if (name === undefined) continue;
    const after = at + 1 + name.length;
    if (text[after] !== ">" && !isSpace(text[after])) continue;
    const gt = text.indexOf(">", after);
    if (gt === -1) return;
    const close = closeOf(text, lower, name, gt + 1);
    if (!close) {
      unended.add(name);
      continue;
    }
    yield { start: at, end: close.end, attrs: gt > after ? text.slice(after, gt) : undefined, content: text.slice(gt + 1, close.start) };
    at = close.end - 1;
  }
}

/** Character data as text: CDATA is taken as written, anything else has its entities decoded. */
function xmlText(raw: string): string {
  // The parts `raw.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)` gives: text, then each CDATA section whole.
  const parts: string[] = [];
  let from = 0;
  for (let at = raw.indexOf("<![CDATA["); at !== -1; at = raw.indexOf("<![CDATA[", from)) {
    const end = raw.indexOf("]]>", at + 9);
    if (end === -1) break;
    parts.push(raw.slice(from, at), raw.slice(at, end + 3));
    from = end + 3;
  }
  parts.push(raw.slice(from));
  return parts.map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decode(part))).join("");
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text of an element's content: entities decoded, whitespace collapsed. */
const textOf = (raw: string) => collapse(xmlText(raw));

/** Elements that end a line when their tags are dropped; others (`<b>`, `<a>`) vanish without a gap. */
const BLOCK_TAGS = new Set(["p", "br", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "table", "blockquote", "pre"]);

/**
 * Text with tags replaced: each `<`, then an optional `/`, then a name `named` accepts, up to the
 * next `>`. With none left after a start, nothing later is a tag either.
 */
function replaceTags(text: string, named: (name: string, after: string | undefined) => boolean, by: string): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
    const slash = text[at + 1] === "/" ? 1 : 0;
    let end = at + 1 + slash;
    while (end < text.length && /\w/.test(text[end])) end++;
    if (!named(text.slice(at + 1 + slash, end), text[at + 1 + slash])) continue;
    const gt = text.indexOf(">", at + 1);
    if (gt === -1) break;
    out += text.slice(from, at) + by;
    from = gt + 1;
    at = gt;
  }
  return out + text.slice(from);
}

/**
 * Script and style elements are code, not text: dropped with their content. One that closes itself
 * (`<script … />`) holds nothing; one with no end runs to the end of the text.
 */
function withoutCode(text: string): string {
  const lower = lowerAscii(text);
  let out = "";
  let from = 0;
  for (let at = lower.indexOf("<"); at !== -1; at = lower.indexOf("<", at + 1)) {
    const name = lower.startsWith("script", at + 1) ? "script" : lower.startsWith("style", at + 1) ? "style" : undefined;
    if (!name) continue;
    const after = at + 1 + name.length;
    if (!isSpace(text[after]) && text[after] !== "/" && text[after] !== ">") continue;
    const gt = text.indexOf(">", after);
    if (gt === -1) break;
    out += text.slice(from, at);
    if (gt > after && text[gt - 1] === "/") {
      from = gt + 1;
    } else {
      from = closeOf(text, lower, name, gt + 1)?.end ?? text.length;
    }
    at = from - 1;
  }
  return out + text.slice(from);
}

/** A summary or description holds HTML: its scripts, styles and markup go, its entities are decoded a second time. */
function summaryOf(raw: string): string {
  const blocks = replaceTags(withoutCode(xmlText(raw)), (name) => BLOCK_TAGS.has(name.toLowerCase()), " ");
  const text = collapse(decode(replaceTags(blocks, (_, first) => first !== undefined && /[A-Za-z!]/.test(first), "")));
  if (text.length <= SUMMARY_MAX) return text;
  let cut = SUMMARY_MAX - 1;
  // Never cut a character in half.
  if (/[\ud800-\udbff]/.test(text[cut - 1])) cut--;
  return `${text.slice(0, cut)}…`;
}

/** The content of the first `<name>` element in `body` (`name` may carry a prefix, like `dc:creator`). */
function inner(body: string, name: string): string | undefined {
  const lower = lowerAscii(body);
  return elements(body, lower, [lowerAscii(name)]).next().value?.content;
}

/** `name="value"` and `name='value'` pairs, names in lower case, values with entities decoded; the last of a name wins. */
function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const nameChar = (ch: string | undefined) => ch !== undefined && /[\w:.-]/.test(ch);
  /** Quotes with no end after some point: none after a later one either. */
  const unended = new Set<string>();
  let at = 0;
  while (at < text.length) {
    if (!nameChar(text[at])) {
      at++;
      continue;
    }
    const start = at;
    while (nameChar(text[at])) at++;
    const name = text.slice(start, at);
    let i = at;
    while (isSpace(text[i])) i++;
    if (text[i] !== "=") continue;
    i++;
    while (isSpace(text[i])) i++;
    const quote = text[i];
    if ((quote !== '"' && quote !== "'") || unended.has(quote)) continue;
    const end = text.indexOf(quote, i + 1);
    if (end === -1) {
      unended.add(quote);
      continue;
    }
    out[name.toLowerCase()] = decode(text.slice(i + 1, end));
    at = end + 1;
  }
  return out;
}

/** RSS puts the address in the element, Atom in `href`; of several Atom links the page itself is preferred. */
function linkOf(body: string): string {
  let page: string | undefined, other: string | undefined, text: string | undefined;
  const lower = lowerAscii(body);
  let unended = false;
  for (let at = lower.indexOf("<link"); at !== -1; at = lower.indexOf("<link", at + 1)) {
    const after = at + 5;
    const gt = body.indexOf(">", after);
    if (gt === -1) break;
    const mid = body.slice(after, gt);
    // `<link …/>` holds nothing; `<link …>` holds what comes before its `</link>`. Anything else (`<linked>`) isn't one.
    const spaced = mid === "" || isSpace(mid[0]);
    let attrs: string | undefined;
    let inside: string | undefined;
    if (mid.endsWith("/") && (mid === "/" || isSpace(mid[0]))) {
      attrs = mid === "/" ? undefined : mid.slice(0, -1);
      at = gt;
    } else if (spaced && !unended) {
      const close = closeOf(body, lower, "link", gt + 1);
      if (!close) {
        unended = true;
        continue;
      }
      attrs = mid || undefined;
      inside = body.slice(gt + 1, close.start);
      at = close.end - 1;
    } else {
      continue;
    }
    const { href, rel } = attributes(attrs ?? "");
    if (href) {
      if (rel === undefined || rel === "alternate") page ??= href;
      else other ??= href;
    } else if (inside !== undefined) {
      text ??= textOf(inside);
    }
  }
  return page ?? other ?? text ?? "";
}

/** `YYYY-MM-DDTHH:mm` in local time from an RFC 822 or ISO 8601 date; anything else comes back as written. */
function dateOf(raw: string): string {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00`;
  const t = Date.parse(text);
  if (Number.isNaN(t)) return text;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function firstOf(body: string, names: string[]): string | undefined {
  for (const name of names) {
    const raw = inner(body, name);
    if (raw !== undefined) return raw;
  }
  return undefined;
}

function itemRow(attrs: string, body: string): Row {
  const author = inner(body, "author");
  const who = author !== undefined ? inner(author, "name") ?? author : inner(body, "dc:creator");
  const date = firstOf(body, ["pubDate", "updated", "published", "dc:date"]);
  const id = firstOf(body, ["guid", "id"]);
  return {
    title: textOf(inner(body, "title") ?? ""),
    link: linkOf(body),
    date: date === undefined ? "" : dateOf(textOf(date)),
    summary: summaryOf(firstOf(body, ["description", "summary", "content:encoded", "content"]) ?? ""),
    author: textOf(who ?? ""),
    // RSS 1.0 names an item in `rdf:about`.
    id: id !== undefined ? textOf(id) : attributes(attrs)["rdf:about"] ?? "",
  };
}

/**
 * The entries of an RSS 2.0, Atom or RSS 1.0 feed as rows `{title, link, date, summary, author,
 * id}`, in feed order. A scanner rather than an XML parser: tolerant of feeds that aren't quite
 * well formed, and free of DOM APIs.
 */
export function parseFeed(text: string): Row[] {
  const rows: Row[] = [];
  for (const e of elements(text, lowerAscii(text), ["item", "entry"])) rows.push(itemRow(e.attrs ?? "", e.content));
  return rows;
}
