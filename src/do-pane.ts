/**
 * "Do…": one line that runs any app's shortcut with its values (`spend 14.5 food lunch`), shown with
 * what it would do (see LineBox); asks a question of the vault's kinds after `?` (see AskPane); and,
 * for a line no shortcut reads, opens the app or the window it names. Enter runs it. On any host:
 * the host's window holds it and closes when it's done.
 */
import { AskPane, type AskHost } from "./ask-pane.ts";
import { doChoices } from "./do-choices.ts";
import { LineBox, type LineHost } from "./line-box.ts";

/** What only the host of Do… can do. */
export interface DoHost extends LineHost {
  ask: AskHost;
  /** The vault's apps, as "Open an app…" orders them. */
  apps(): { name: string; path: string }[];
  /** The host's own windows, opened by name. */
  actions(): { name: string; run(): void }[];
  /** Opens an app. */
  open(path: string): void;
  /** Closes the window Do… is in. */
  close(): void;
}

export class DoPane {
  readonly box: LineBox;
  private host: DoHost;

  /** `start`: a line to start from, typing going in at `cursor` (an ask's line that still needs a value). */
  constructor(el: HTMLElement, host: DoHost, start?: { line: string; cursor: number }) {
    this.host = host;
    this.box = new LineBox(host, el, "spend 14.5 food lunch, an app, or ? spend this month", () => void this.submit(), (at) => new AskPane(host.ask, at, () => host.close()), {
      choices: (line) => doChoices(line, host.apps(), host.actions(), (path) => host.open(path)),
      done: () => host.close(),
    });
    el.createDiv({ cls: "gz-muted", text: "Enter runs it · ? asks your kinds · Tab completes · Esc closes" });
    if (start) this.box.input.value = start.line;
    void this.box.show();
    this.box.input.focus();
    if (start) this.box.input.setSelectionRange(start.cursor, start.cursor);
  }

  stop(): void {
    this.box.stop();
  }

  private async submit(): Promise<void> {
    // A line no shortcut reads opens what it names, an app or a window, rather than failing.
    const offered = this.box.choices()[0];
    if (offered) {
      offered.run();
      this.host.close();
      return;
    }
    if (await this.box.submit()) this.host.close();
    else this.box.input.focus();
  }
}
