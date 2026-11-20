import { fnv1a, stableJson } from "./hash.ts";
import { isPlainObject } from "./keys.ts";

/**
 * How private a piece of data is, least first. A value carries the highest label of anything it
 * was made from; a place data goes (a website, a notice) takes data up to the label it is cleared for.
 */
export type Label = "public" | "personal" | "private" | "secret";
export const LABELS: readonly Label[] = ["public", "personal", "private", "secret"];

/** A place cleared for nothing: no label goes there. */
export const NOTHING = -1;

export function rank(label: Label): number {
  return LABELS.indexOf(label);
}

/** The higher of two labels. */
export function join(a: Label, b: Label): Label {
  return rank(a) >= rank(b) ? a : b;
}

/** The vault note whose properties are the policy. No app may write it. */
export const POLICY_PATH = "Gizmo policy.md";

/** Whether a path is the policy note, which apps never write. */
export function isPolicyPath(path: string): boolean {
  return path.toLowerCase() === POLICY_PATH.toLowerCase();
}

/** Why an app can't write a note, as the end of a sentence; undefined when it may. */
export function policyReason(path: string): string | undefined {
  return isPolicyPath(path) ? "which is your Gizmo policy; change it by hand" : undefined;
}

/**
 * What a label rule matches: notes in a folder or by a glob (`Health/**`), notes with a tag
 * (`#finance`, sub-tags too), one note by its path or name, or what a website sends (`host:`).
 */
export interface LabelRule {
  /** The key as written in the policy note. */
  key: string;
  kind: "glob" | "tag" | "note" | "host";
  /** The glob, the tag without `#`, the note's path or name without `.md`, or the host. */
  match: string;
  label?: Label;
  /** Labels of single fields of the notes it matches: `{med: private}`. */
  fields?: Record<string, Label>;
}

/** An exception: one panel's value may go to these places whatever its label. */
export interface Release {
  /** The app note's path, `.md` optional. */
  app: string;
  /** The panel's title or label. */
  panel: string;
  to: string[];
}

/** The policy as read from its note: labels for data, what each place may receive, exceptions. */
export interface Policy {
  labels: LabelRule[];
  /** Hosts and the places named by word (notify, pin, answer, images, gizmod), each with what it may receive. */
  sinks: Record<string, Label>;
  release: Release[];
  /** The label of what you type into an app's text inputs and forms. */
  typed: Label;
}

/** Places named by a word rather than a host. */
export const SINK_WORDS = ["notify", "pin", "answer", "images", "gizmod"] as const;
export type SinkWord = (typeof SINK_WORDS)[number];

/** What each place named by a word may receive when the policy doesn't say. */
const DEFAULT_SINKS: Record<SinkWord, Label> = { notify: "personal", pin: "personal", answer: "personal", images: "public", gizmod: "personal" };

/** What a note's data is when no rule labels it: it's yours, but not secret. */
export const DEFAULT_LABEL: Label = "personal";

const POLICY_KEYS = ["labels", "sinks", "release", "typed"];

function readLabel(v: unknown, where: string, errors: string[]): Label | undefined {
  if (typeof v === "string" && (LABELS as readonly string[]).includes(v)) return v as Label;
  errors.push(`${where} must be one of ${LABELS.join(", ")}`);
  return undefined;
}

function ruleOf(key: string): Pick<LabelRule, "kind" | "match"> {
  if (key.startsWith("host:")) return { kind: "host", match: key.slice(5).trim().toLowerCase() };
  if (key.startsWith("#")) return { kind: "tag", match: key.slice(1).toLowerCase() };
  if (key.includes("*") || key.endsWith("/")) return { kind: "glob", match: key.endsWith("/") ? `${key}**` : key };
  return { kind: "note", match: key.replace(/\.md$/i, "") };
}

/**
 * Reads the policy note's properties. Unknown keys and labels are errors, so a typo never quietly
 * leaves data unlabelled.
 */
export function readPolicy(fm: Record<string, unknown> | undefined): { policy?: Policy; errors: string[] } {
  const errors: string[] = [];
  if (!fm) return { errors: ["the policy note has no properties"] };
  for (const key of Object.keys(fm)) if (!POLICY_KEYS.includes(key) && key !== "tags" && key !== "aliases" && key !== "cssclasses") errors.push(`unknown key "${key}"; a policy has ${POLICY_KEYS.join(", ")}`);
  const labels: LabelRule[] = [];
  if (fm.labels !== undefined) {
    if (!isPlainObject(fm.labels)) errors.push("labels must be a set of what: label, e.g. \"Health/**\": private");
    else for (const [key, value] of Object.entries(fm.labels)) {
      const rule: LabelRule = { key, ...ruleOf(key) };
      if (isPlainObject(value)) {
        if (rule.kind === "host") errors.push(`labels: ${key} takes one label, not fields`);
        const fields: Record<string, Label> = {};
        for (const [field, l] of Object.entries(value)) {
          const read = readLabel(l, `labels: ${key}: ${field}`, errors);
          if (read) fields[field] = read;
        }
        rule.fields = fields;
      } else {
        rule.label = readLabel(value, `labels: ${key}`, errors);
      }
      labels.push(rule);
    }
  }
  const sinks: Record<string, Label> = {};
  if (fm.sinks !== undefined) {
    if (!isPlainObject(fm.sinks)) errors.push("sinks must be a set of place: label, e.g. api.open-meteo.com: public");
    else for (const [place, value] of Object.entries(fm.sinks)) {
      const word = (SINK_WORDS as readonly string[]).includes(place);
      if (!word && !place.includes(".")) errors.push(`sinks: "${place}" is neither a website nor one of ${SINK_WORDS.join(", ")}`);
      const read = readLabel(value, `sinks: ${place}`, errors);
      if (read) sinks[word ? place : place.toLowerCase()] = read;
    }
  }
  const release: Release[] = [];
  if (fm.release !== undefined) {
    if (!Array.isArray(fm.release)) errors.push("release must be a list of {app, panel, to}");
    else fm.release.forEach((r, i) => {
      const at = `release ${i + 1}`;
      if (!isPlainObject(r) || typeof r.app !== "string" || typeof r.panel !== "string") return void errors.push(`${at} needs app (its note's path) and panel (its title)`);
      const to = Array.isArray(r.to) ? r.to.map(String) : typeof r.to === "string" ? [r.to] : [];
      if (!to.length) errors.push(`${at} needs to: the places its value may go, e.g. [pin]`);
      const unknown = to.filter((t) => !(SINK_WORDS as readonly string[]).includes(t));
      if (unknown.length) errors.push(`${at}: to can name ${SINK_WORDS.join(", ")}, not ${unknown.join(", ")}`);
      release.push({ app: r.app.replace(/\.md$/i, ""), panel: r.panel, to });
    });
  }
  const typed = fm.typed === undefined ? "public" : readLabel(fm.typed, "typed", errors) ?? "public";
  if (errors.length) return { errors };
  return { policy: { labels, sinks, release, typed }, errors };
}

/** A policy as Obsidian applied it: its rules and their fingerprint, kept in the plugin's data. */
export interface AppliedPolicy {
  hash: string;
  rules: Policy;
}

/** A policy's fingerprint: equal for equal rules, whatever their order in the note's text. */
export function policyHash(policy: Policy): string {
  return fnv1a(stableJson(policy)).toString(36);
}

/** A glob as a pattern over a path: `**` any depth, `*` within one folder. */
function globPattern(glob: string): RegExp {
  const parts = glob.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"));
  return new RegExp(`^${parts.join(".*")}$`, "i");
}

/** Whether a rule matches the note or file at `path`, with these tags (as Obsidian lists them, `#` first). */
function matches(rule: LabelRule, path: string, tags: readonly string[]): boolean {
  const bare = path.replace(/\.md$/i, "");
  switch (rule.kind) {
    case "glob": {
      const re = globPattern(rule.match);
      return re.test(path) || re.test(bare);
    }
    case "tag": return tags.some((t) => {
      const tag = t.replace(/^#/, "").toLowerCase();
      return tag === rule.match || tag.startsWith(`${rule.match}/`);
    });
    case "note": {
      const name = bare.slice(bare.lastIndexOf("/") + 1);
      return bare.toLowerCase() === rule.match.toLowerCase() || (!rule.match.includes("/") && name.toLowerCase() === rule.match.toLowerCase());
    }
    default: return false;
  }
}

/** A note's data as labels: the label of the whole, and of single fields above it. */
export interface Labels {
  base: Label;
  fields: Record<string, Label>;
}

/** A field's label in data labelled `l`. */
export function fieldLabel(l: Labels, field: string): Label {
  return join(l.base, l.fields[field] ?? l.base);
}

/** The highest label anywhere in `l`. */
export function topLabel(l: Labels): Label {
  return Object.values(l.fields).reduce(join, l.base);
}

function collect(rules: LabelRule[]): Labels {
  let base: Label | undefined;
  const fields: Record<string, Label> = {};
  for (const r of rules) {
    if (r.label) base = base ? join(base, r.label) : r.label;
    for (const [f, l] of Object.entries(r.fields ?? {})) fields[f] = fields[f] ? join(fields[f], l) : l;
  }
  return { base: base ?? DEFAULT_LABEL, fields };
}

/** The labels of one note or file's data, from every rule that matches it. */
export function noteLabels(policy: Policy, path: string, tags: readonly string[] = []): Labels {
  return collect(policy.labels.filter((r) => r.kind !== "host" && matches(r, path, tags)));
}

/** Where a glob's fixed part ends: the folders every path it matches starts with. */
function fixedPrefix(glob: string): string {
  const cut = glob.search(/\*/);
  const head = cut < 0 ? glob : glob.slice(0, cut);
  return head.slice(0, head.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * The labels of what notes in a scope (a folder, or `#tag`) may hold, worked out from the rules
 * alone, before any note is read: every rule that could match a note there counts. A rule by tag
 * counts for any folder, as any note there may carry the tag.
 */
export function scopeLabels(policy: Policy, scope: string): Labels {
  const isTag = scope.startsWith("#");
  const bare = scope.replace(/\/+$/, "");
  const folder = isTag || !bare ? "" : `${bare}/`.toLowerCase();
  const tag = isTag ? scope.slice(1).toLowerCase() : "";
  return collect(policy.labels.filter((r) => {
    if (r.kind === "host") return false;
    if (r.kind === "tag") return !isTag || tag === r.match || tag.startsWith(`${r.match}/`) || r.match.startsWith(`${tag}/`);
    if (isTag) return true;
    if (r.kind === "note") return !r.match.includes("/") || r.match.toLowerCase().startsWith(folder);
    const prefix = fixedPrefix(r.match);
    return prefix.startsWith(folder) || folder.startsWith(prefix);
  }));
}

/** The labels of anything in the vault: every rule counts. */
export function vaultLabels(policy: Policy): Labels {
  return collect(policy.labels.filter((r) => r.kind !== "host"));
}

/** The label a host's answers carry, when a rule names the host. */
export function hostLabel(policy: Policy, host: string): Label | undefined {
  const rules = policy.labels.filter((r) => r.kind === "host" && r.match === host.toLowerCase() && r.label);
  return rules.length ? rules.map((r) => r.label!).reduce(join) : undefined;
}

/**
 * The highest label a place may receive: a place named by word takes its default when the policy
 * doesn't say; a website the policy doesn't list is undefined (asked about, as today).
 */
export function clearance(policy: Policy, place: string): Label | undefined {
  if (Object.hasOwn(policy.sinks, place)) return policy.sinks[place];
  return (SINK_WORDS as readonly string[]).includes(place) ? DEFAULT_SINKS[place as SinkWord] : undefined;
}

/** Whether a panel's value may go to a place whatever its label: the policy releases it there. */
export function released(policy: Policy, appPath: string, panel: string | undefined, place: string): boolean {
  if (!panel) return false;
  const app = appPath.replace(/\.md$/i, "").toLowerCase();
  return policy.release.some((r) => r.app.toLowerCase() === app && r.panel === panel && r.to.includes(place));
}
