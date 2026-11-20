import { fnv1a, stableJson } from "./hash.ts";
import { dropGrants, moveGrants } from "./grants.ts";
import type { StoredData } from "./stored.ts";

/**
 * An app is known by its note's path: its grants, link keys and where its links answer in data.json,
 * what its alerts and rhythms did in each device's own files, its activity, its data note. This is
 * where a rename or a delete reaches all of them.
 *
 * A rename made in Obsidian on this device arrives as a rename, and only it writes data.json. One
 * made elsewhere arrives by sync as a delete and a create, in either order: the background matches
 * them by the note's keys and carries this device's own files over, and the renaming device's
 * data.json, already moved, comes by sync. A delete with no create to match waits PENDING_MS before
 * what was kept for the app is dropped.
 */

/** How far apart a delete and a create may arrive and still be one rename. */
export const RENAME_MS = 2 * 60_000;
/** How long what was kept for a deleted app waits for its note to come back under another name. */
export const PENDING_MS = 24 * 60 * 60_000;

/** An app note's keys as a short text, the same on every device: how a sync's delete and create are matched. */
export function fingerprint(fm: Record<string, unknown>): string {
  return fnv1a(stableJson(fm)).toString(36);
}

/** A capture key's targets, `<app path>#<shortcut>`, under one app's path. */
const targetsApp = (target: string, path: string) => target.startsWith(`${path}#`);

/** Moves what data.json keeps for an app (its embeds' too) to its new path; true when anything moved. */
export function moveKeys(stored: StoredData, oldPath: string, newPath: string): boolean {
  let moved = [stored.grants, stored.linkKeys ?? {}, stored.answerTo ?? {}].map((m: Record<string, unknown>) => moveGrants(m, oldPath, newPath)).some(Boolean);
  for (const names of Object.values(stored.captureKeys ?? {})) {
    for (const [name, target] of Object.entries(names)) {
      if (!targetsApp(target, oldPath)) continue;
      names[name] = newPath + target.slice(oldPath.length);
      moved = true;
    }
  }
  return moved;
}

/** Drops what data.json keeps for an app that is gone; a capture key keeps the names it runs elsewhere. True when anything went. */
export function dropKeys(stored: StoredData, path: string): boolean {
  let dropped = [stored.grants, stored.linkKeys ?? {}, stored.answerTo ?? {}].map((m: Record<string, unknown>) => dropGrants(m, path)).some(Boolean);
  for (const [key, names] of Object.entries(stored.captureKeys ?? {})) {
    for (const [name, target] of Object.entries(names)) {
      if (!targetsApp(target, path)) continue;
      delete names[name];
      dropped = true;
    }
    if (!Object.keys(names).length) delete stored.captureKeys![key];
  }
  return dropped;
}
