import { Notice, normalizePath, type TFile } from "obsidian";
import { vaultNotes } from "./host.ts";
import { readFields } from "./keys.ts";
import { lineOf } from "./kind.ts";
import type GizmoPlugin from "./main.ts";
import { extractPage } from "./seal-extract.ts";
import { checkNow, checkWords, extractOf, sealNow, sealedKind } from "./seal-run.ts";
import type { KindSpec } from "./spec.ts";
import { defaultDataPath } from "./store.ts";
import { stampParts, toTime } from "./time.ts";

/** The open note as a sealed kind, or why not. */
function openKind(plugin: GizmoPlugin, file: TFile | null): { file: TFile; kind: KindSpec; wanted: string[] } | { why: string } | undefined {
  const fm = file ? plugin.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
  const k = file ? sealedKind(file.path, fm, vaultNotes(plugin.app)) : undefined;
  return k && !("why" in k) ? { file: file!, ...k } : k;
}

async function seal(plugin: GizmoPlugin, file: TFile, kind: KindSpec, wanted: string[]): Promise<string> {
  const authority = kind.seal!.authority !== undefined;
  const host = plugin.runtime.sealHost(file.path, wanted, authority);
  const done = await sealNow(host, defaultDataPath(file.path), kind.seal!, plugin.runtime.device.id, Date.now());
  return authority && !host.postBytes ? `${done.said}. Allow ${file.basename} to ask its authority for a time stamp.` : done.said;
}

/** Writes the kind's logged rows, its logs and its seals as one HTML file beside the kind note; gives the file's path. */
async function extract(plugin: GizmoPlugin, file: TFile, kind: KindSpec): Promise<string> {
  const { app } = plugin;
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const dataPath = defaultDataPath(file.path);
  const ledger = plugin.runtime.dataLayer.ledger;
  const rows = ledger ? (await ledger.state(dataPath, fm)).lists.get(kind.name)?.rows ?? [] : [];
  const logged = rows.filter((r) => lineOf(r) === "logged").sort((a, b) => (toTime(a.at) ?? 0) - (toTime(b.at) ?? 0));
  const info = readFields(fm.fields as Record<string, unknown>).info;
  const fields = Object.keys(kind.fields).map((name) => ({ name, label: info[name]?.label ?? name }));
  const x = await extractOf(plugin.runtime.sealHost(file.path, [], false), dataPath, { name: file.basename, list: kind.name, fields }, logged, Date.now());
  const folder = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
  // The day here, as the person reads the calendar, not the day in UTC.
  const day = stampParts(new Date()).date;
  let path = normalizePath(`${folder}${file.basename} sealed ${day}.html`);
  for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = path.replace(/( \d+)?\.html$/, ` ${n}.html`);
  await app.vault.create(path, extractPage(x));
  return path;
}

/**
 * Sealed records (see seal.ts): commands to seal a kind's logs now, to check its seals, and to make
 * an extract that checks itself. The daily seal on the device that runs background work is the
 * runtime's (see GizmoRuntime.sealDue).
 */
export function registerSeal(plugin: GizmoPlugin): void {
  const open = () => openKind(plugin, plugin.app.workspace.getActiveFile());
  const command = (id: string, name: string, run: (k: { file: TFile; kind: KindSpec; wanted: string[] }) => Promise<string>) => {
    plugin.addCommand({
      id, name,
      checkCallback: (checking) => {
        const k = open();
        if (!k) return false;
        if (checking) return true;
        if ("why" in k) return void new Notice(k.why, 10_000);
        void run(k).then((said) => new Notice(said, 10_000), (e: Error) => new Notice(`Couldn't: ${e.message}`, 10_000));
        return true;
      },
    });
  };
  command("seal-now", "Seal this kind's rows now", (k) => seal(plugin, k.file, k.kind, k.wanted));
  command("seal-check", "Check this kind's seals", async (k) => checkWords((await checkNow(plugin.runtime.sealHost(k.file.path, [], false), defaultDataPath(k.file.path))).checks, k.file.basename));
  command("seal-extract", "Make a sealed extract", async (k) => {
    // What isn't under a seal yet is sealed first, so the extract shows every row as sealed.
    await seal(plugin, k.file, k.kind, k.wanted);
    return `Made ${await extract(plugin, k.file, k.kind)}: one file that checks itself in any browser`;
  });
}
