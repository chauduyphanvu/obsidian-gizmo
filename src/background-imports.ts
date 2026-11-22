import { storeOf } from "./actions.ts";
import type { Actor } from "./activity.ts";
import type { AppEntry, BackgroundEnv } from "./background.ts";
import { importable, importedText, runImport, type ImportMap, type Imported } from "./import.ts";
import { basename } from "./store.ts";

/**
 * Reads files into kinds: one a person picks (the command), and every file in a folder a kind's
 * `import:` names, which the device running background work reads when the kind is indexed and
 * whenever the folder changes. Reading a file again adds nothing, so a folder is read whole each
 * time; only rows that weren't there are added, and only that is told. One import runs at a time.
 */
export class Imports {
  private env: BackgroundEnv;
  private granted: (entry: AppEntry) => boolean;
  private say: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(env: BackgroundEnv, host: { granted: (entry: AppEntry) => boolean; say: (message: string) => void }) {
    this.env = env;
    this.granted = host.granted;
    this.say = host.say;
  }

  /** The folders a kind reads files from, as the data layer names their changes. */
  static foldersOf(entry: AppEntry): string[] {
    return (entry.spec.kind?.imports ?? []).flatMap((m) => (m.folder === undefined ? [] : [m.folder]));
  }

  /** Reads every file in each folder the kind's maps name, here only where background work runs and the kind is allowed. */
  folders(entry: AppEntry): Promise<void> {
    const kind = entry.spec.kind;
    if (!kind || !this.env.runsBackground() || !this.granted(entry)) return Promise.resolve();
    entry.imported = true;
    return this.next(async () => {
      for (const map of kind.imports) {
        if (map.folder === undefined) continue;
        for (const path of (this.env.data.host.filesIn?.(map.folder) ?? []).filter(importable).sort()) {
          const r = await this.read(entry, map, path, "import").catch((e: Error) => ({ error: e.message }));
          if ("error" in r) this.say(`${entry.name}: couldn't import ${basename(path)}: ${r.error}`);
          else if (r.added) this.say(importedText(r, entry.name, basename(path)));
        }
      }
    });
  }

  /** Reads one file into a kind under the map called `name`, as a person asked. */
  file(entry: AppEntry, name: string, path: string, actor: Actor): Promise<Imported | { error: string }> {
    const map = entry.spec.kind?.imports.find((m) => m.name === name);
    if (!map) return Promise.resolve({ error: `${entry.name} has no import called ${name}` });
    return this.next(() => this.read(entry, map, path, actor).catch((e: Error) => ({ error: e.message })));
  }

  private async read(entry: AppEntry, map: ImportMap, path: string, actor: Actor): Promise<Imported> {
    const kind = entry.spec.kind!;
    const text = await this.env.data.host.readFile(path);
    const deps = this.env.actionDeps(entry.path, entry.dataPath, actor);
    return runImport({ store: storeOf(deps), now: () => this.env.now(), log: (what, changes) => deps.log?.(what, changes) }, kind, map, { path, text });
  }

  private next<T>(run: () => Promise<T>): Promise<T> {
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => undefined);
    return done;
  }
}
