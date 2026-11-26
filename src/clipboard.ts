import { Notice } from "obsidian";

/** Puts text on the clipboard, then runs `done`; says so when it can't. */
export function copyText(text: string, done?: () => void): void {
  void navigator.clipboard.writeText(text).then(done, () => { new Notice("Couldn't copy to the clipboard"); });
}
