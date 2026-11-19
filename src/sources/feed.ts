import type { Row } from "../data.ts";

const SUMMARY_MAX = 500;

const pad = (n: number) => String(n).padStart(2, "0");

const NAMED = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "]]);

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED.get(name) ?? all;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/** Character data as text: CDATA is taken as written, anything else has its entities decoded. */
function xmlText(raw: string): string {
  return raw.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decode(part))).join("");
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text of an element's content: entities decoded, whitespace collapsed. */
const textOf = (raw: string) => collapse(xmlText(raw));

/** Elements that end a line when their tags are dropped; others (`<b>`, `<a>`) vanish without a gap. */
const BLOCK_TAGS = /<\/?(?:p|br|div|li|ul|ol|h[1-6]|tr|td|table|blockquote|pre)\b[^>]*>/gi;
const TAGS = /<\/?[A-Za-z!][^>]*>/g;
/** Script and style elements are code, not text: dropped with their content (an unclosed one runs to the end). */
const CODE = /<(script|style)(?=[\s/>])(?:[^>/]|\/(?!>))*>[\s\S]*?(?:<\/\1\s*>|$)|<(?:script|style)(?=[\s/>])[^>]*\/>/gi;

/** A summary or description holds HTML: its scripts, styles and markup go, its entities are decoded a second time. */
function summaryOf(raw: string): string {
  const text = collapse(decode(xmlText(raw).replace(CODE, "").replace(BLOCK_TAGS, " ").replace(TAGS, "")));
  if (text.length <= SUMMARY_MAX) return text;
  let cut = SUMMARY_MAX - 1;
  // Never cut a character in half.
  if (/[\ud800-\udbff]/.test(text[cut - 1])) cut--;
  return `${text.slice(0, cut)}…`;
}

/** The content of the first `<name>` element in `body` (`name` may carry a prefix, like `dc:creator`). */
function inner(body: string, name: string): string | undefined {
  return body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, "i"))?.[1];
}

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decode(m[2] ?? m[3]);
  return out;
}

/** RSS puts the address in the element, Atom in `href`; of several Atom links the page itself is preferred. */
function linkOf(body: string): string {
  let page: string | undefined, other: string | undefined, text: string | undefined;
  for (const m of body.matchAll(/<link(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/link\s*>)/gi)) {
    const { href, rel } = attributes(m[1] ?? "");
    if (href) {
      if (rel === undefined || rel === "alternate") page ??= href;
      else other ??= href;
    } else if (m[2] !== undefined) {
      text ??= textOf(m[2]);
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
  for (const m of text.matchAll(/<(item|entry)(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi)) rows.push(itemRow(m[2] ?? "", m[3]));
  return rows;
}
