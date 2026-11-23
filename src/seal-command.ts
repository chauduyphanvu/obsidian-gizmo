import { Notice, normalizePath, type TFile } from "obsidian";
import { vaultNotes } from "./host.ts";
import { readFields } from "./keys.ts";
import { lineOf } from "./kind.ts";
import type GizmoPlugin from "./main.ts";
import { permissionsOf } from "./permissions.ts";
import { extractPage } from "./seal-extract.ts";
import { checkNow, checkWords, extractOf, lastSealed, sealNow, type SealHost } from "./seal-run.ts";
import { readSpec, type KindSpec } from "./spec.ts";
import { defaultDataPath, isKind } from "./store.ts";
import { stampParts, toTime } from "./time.ts";

/** How old this device's last seal of a kind may get before the next one is made on its own. */
const SEAL_EVERY_MS = 24 * 3_600_000;
/** How often the kinds are looked at for a seal that is due. */
const LOOK_EVERY_MS = 30 * 60_000;

/** The open note as a sealed kind, or why not. */
function sealedKind(plugin: GizmoPlugin, file: TFile | null): { file: TFile; kind: KindSpec; wanted: string[] } | { why: string } | undefined {
  const fm = file ? plugin.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
  if (!file || !fm || !isKind(fm)) return undefined;
  const spec = readSpec(fm, { notes: vaultNotes(plugin.app), path: file.path })?.spec;
  if (!spec?.kind) return { why: `${file.basename} has a problem to fix first` };
  if (!spec.kind.seal) return { why: `${file.basename} isn't sealed: add seal: true to its properties, or seal: {authority: https://…} for a signed time stamp` };
  return { file, kind: spec.kind, wanted: permissionsOf(spec, file.path) };
}

/** Sealing with an authority sends a hash out, which the kind must be allowed to; sealing alone sends nothing. */
function sealHost(plugin: GizmoPlugin, path: string, wanted: string[], authority: boolean): SealHost {
  const host = plugin.dataLayer.host;
  const may = !authority || plugin.isGranted(path, wanted, false);
  const post = host.postBytes?.bind(host);
  return {
    filesIn: (folder) => host.filesIn?.(folder) ?? [],
    readFile: (path) => host.readFile(path),
    ...(host.append && { append: (path: string, text: string) => host.append!(path, text) }),
    ...(may && post && { postBytes: post }),
  };
}

async function seal(plugin: GizmoPlugin, file: TFile, kind: KindSpec, wanted: string[]): Promise<string> {
  const authority = kind.seal!.authority !== undefined;
  const host = sealHost(plugin, file.path, wanted, authority);
  const done = await sealNow(host, defaultDataPath(file.path), kind.seal!, plugin.device.id, Date.now());
  return authority && !host.postBytes ? `${done.said}. Allow ${file.basename} to ask its authority for a time stamp.` : done.said;
}

/** Writes the kind's logged rows, its logs and its seals as one HTML file beside the kind note; gives the file's path. */
async function extract(plugin: GizmoPlugin, file: TFile, kind: KindSpec): Promise<string> {
  const { app } = plugin;
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const dataPath = defaultDataPath(file.path);
  const ledger = plugin.dataLayer.ledger;
  const rows = ledger ? (await ledger.state(dataPath, fm)).lists.get(kind.name)?.rows ?? [] : [];
  const logged = rows.filter((r) => lineOf(r) === "logged").sort((a, b) => (toTime(a.at) ?? 0) - (toTime(b.at) ?? 0));
  const info = readFields(fm.fields as Record<string, unknown>).info;
  const fields = Object.keys(kind.fields).map((name) => ({ name, label: info[name]?.label ?? name }));
  const x = await extractOf(sealHost(plugin, file.path, [], false), dataPath, { name: file.basename, list: kind.name, fields }, logged, Date.now());
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
 * an extract that checks itself; and, on the device that runs background work, a seal of each
 * sealed kind once a day when it has new lines.
 */
export function registerSeal(plugin: GizmoPlugin): void {
  const open = () => sealedKind(plugin, plugin.app.workspace.getActiveFile());
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
  command("seal-check", "Check this kind's seals", async (k) => checkWords((await checkNow(sealHost(plugin, k.file.path, [], false), defaultDataPath(k.file.path))).checks, k.file.basename));
  command("seal-extract", "Make a sealed extract", async (k) => {
    // What isn't under a seal yet is sealed first, so the extract shows every row as sealed.
    await seal(plugin, k.file, k.kind, k.wanted);
    return `Made ${await extract(plugin, k.file, k.kind)}: one file that checks itself in any browser`;
  });

  const due = async () => {
    if (!plugin.beat?.isRunner()) return;
    for (const file of plugin.app.vault.getMarkdownFiles()) {
      const k = sealedKind(plugin, file);
      if (!k || "why" in k) continue;
      // A kind runs nothing of its own until it is allowed.
      if (plugin.granted(file.path) === undefined || !plugin.isGranted(file.path, k.wanted, false)) continue;
      const host = sealHost(plugin, file.path, k.wanted, k.kind.seal!.authority !== undefined);
      if (Date.now() - (await lastSealed(host, defaultDataPath(file.path), plugin.device.id)) < SEAL_EVERY_MS) continue;
      await sealNow(host, defaultDataPath(file.path), k.kind.seal!, plugin.device.id, Date.now()).catch(() => undefined);
    }
  };
  plugin.registerInterval(window.setInterval(() => void due().catch(() => {}), LOOK_EVERY_MS));
}
