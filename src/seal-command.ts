import { Notice } from "obsidian";
import type GizmoPlugin from "./main.ts";
import { checkSaid, extractSaid, sealExtract, sealSaid, sealedKindAt, type SealedKind } from "./seal-actions.ts";

/**
 * Sealed records (see seal.ts): commands to seal a kind's logs now, to check its seals, and to make
 * an extract that checks itself (see seal-actions.ts). The daily seal on the device that runs
 * background work is the runtime's (see GizmoRuntime.sealDue).
 */
export function registerSeal(plugin: GizmoPlugin): void {
  const open = () => {
    const file = plugin.app.workspace.getActiveFile();
    return file ? sealedKindAt(plugin.runtime, file.path) : undefined;
  };
  const command = (id: string, name: string, run: (k: SealedKind) => Promise<string>) => {
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
  command("seal-now", "Seal this kind's rows now", (k) => sealSaid(plugin.runtime, k));
  command("seal-check", "Check this kind's seals", (k) => checkSaid(plugin.runtime, k));
  command("seal-extract", "Make a sealed extract", async (k) => extractSaid(await sealExtract(plugin.runtime, k)));
}
