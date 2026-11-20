import { PENDING_MS, RENAME_MS } from "./identity.ts";

/** A note seen going or coming: its keys as a short text, and when. */
interface Seen {
  fingerprint: string;
  at: number;
}

/**
 * A rename another device made reaches this one by sync as a delete and a create, in either order:
 * app notes deleted lately and app notes made lately, by path, so a pair with the same keys is told
 * from two apps (see identity.ts).
 */
export class RenameMatcher {
  private gone = new Map<string, Seen>();
  private appeared = new Map<string, Seen>();

  /** An app note went: the note with the same keys that came lately, now paired with it; else it waits PENDING_MS for its other half. */
  went(path: string, print: string, now: number): string | undefined {
    const twin = this.twinOf(this.appeared, print, now);
    if (twin) {
      this.appeared.delete(twin);
      return twin;
    }
    this.gone.set(path, { fingerprint: print, at: now });
    return undefined;
  }

  /** An app note came: the note with the same keys that went lately, now paired with it; else it waits RENAME_MS for its other half. */
  came(path: string, print: string, now: number): string | undefined {
    const twin = this.twinOf(this.gone, print, now);
    if (twin) {
      this.gone.delete(twin);
      return twin;
    }
    this.appeared.set(path, { fingerprint: print, at: now });
    return undefined;
  }

  /** A rename made here: neither half waits for the other. */
  renamed(from: string, to: string): void {
    this.gone.delete(from);
    this.appeared.delete(to);
  }

  /** Notes gone for PENDING_MS with nothing to match are gone for good, each told to `goneForGood`; notes made long enough ago match nothing. */
  expire(now: number, goneForGood: (path: string) => void): void {
    for (const [path, n] of this.appeared) if (now - n.at > RENAME_MS) this.appeared.delete(path);
    for (const [path, n] of this.gone) {
      if (now - n.at <= PENDING_MS) continue;
      this.gone.delete(path);
      goneForGood(path);
    }
  }

  /** The one note with these keys that went or came within RENAME_MS; none when there are two (two copies aren't a rename). */
  private twinOf(notes: Map<string, Seen>, print: string, now: number): string | undefined {
    const near = [...notes].filter(([, n]) => n.fingerprint === print && now - n.at <= RENAME_MS);
    return near.length === 1 ? near[0][0] : undefined;
  }
}
