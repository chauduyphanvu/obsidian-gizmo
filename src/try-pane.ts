import { AppController } from "./app.ts";
import { handler } from "./handler.ts";
import type { GizmoRuntime } from "./runtime.ts";
import { makeSandbox, plainHosts, type SandboxNote } from "./sandbox.ts";
import { leftOut } from "./try.ts";

export interface TryHost {
  name: string;
  appPath: string;
  notes: Map<string, SandboxNote>;
  wanted: string[];
  /** What the try leads to, beside Close: Allow, or Install. */
  done?: { label: string; run: () => void | Promise<void> };
  copy(text: string): void;
  close(): void;
}

export const tryTitle = (name: string): string => `Try ${name}`;

/**
 * The real app on copies of its own notes, before anything is allowed (see makeSandbox): it can
 * be used, what it does is listed as it happens, and closing the window drops all of it. Gives how
 * to stop it, which the window calls as it closes.
 */
export function drawTry(parent: HTMLElement, rt: GizmoRuntime, host: TryHost): () => void {
  const el = parent.createDiv({ cls: "gizmo gz-share gz-try" });
  el.createEl("p", { cls: "gz-muted", text: "A try reads none of your notes, keeps nothing, and sends nothing anywhere. Use it as you would; closing this window drops everything it did." });
  const layer = rt.dataLayer.host;
  const box = makeSandbox({
    appPath: host.appPath,
    notes: host.notes,
    parseYaml: (text) => layer.parseYaml(text),
    now: () => new Date(),
    schedule: (cb) => layer.schedule(cb),
    fetch: (url, headers, init) => layer.fetch(url, headers, init),
    copy: (text) => host.copy(text),
  });
  let controller: AppController | undefined;
  const out = leftOut(host.wanted);
  if (out.length) {
    el.createEl("h4", { text: "Not in this try" });
    const ul = el.createEl("ul");
    for (const line of out) ul.createEl("li", { text: line });
  }
  const hosts = plainHosts(host.wanted);
  if (hosts.length) {
    const fetch = el.createEl("button", { text: `Fetch from ${hosts.join(", ")} for this try` });
    fetch.addEventListener("click", () => {
      box.allow(hosts);
      fetch.disabled = true;
      fetch.setText(`Fetching from ${hosts.join(", ")} for this try only`);
      controller?.reload();
    });
  }
  const body = el.createDiv({ cls: "gz-try-app" });
  el.createEl("h4", { text: "What it did here" });
  const did = el.createEl("ul", { cls: "gz-effects" });
  const show = () => {
    did.empty();
    if (!box.events.length) did.createEl("li", { cls: "gz-muted", text: "Nothing yet." });
    for (const e of box.events) did.createEl("li", { text: e.text });
  };
  show();
  box.onEvent(show);
  const row = el.createDiv({ cls: "modal-button-container" });
  row.createEl("button", { text: "Close" }).addEventListener("click", () => host.close());
  if (host.done) {
    const { label, run } = host.done;
    row.createEl("button", { cls: "mod-cta", text: label }).addEventListener("click", handler(async () => {
      host.close();
      await run();
    }));
  }
  controller = new AppController(body, host.appPath, box.env);
  controller.load();
  const timer = window.setTimeout(() => controller?.resize(), 50);
  return () => {
    window.clearTimeout(timer);
    controller?.dispose();
    controller = undefined;
  };
}
