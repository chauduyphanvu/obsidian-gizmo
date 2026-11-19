import { FuzzySuggestModal, Notice, type App, type Editor, type Plugin } from "obsidian";
import { VIEW_HINTS } from "./hints.ts";
import { insertPanel, refusalFor, skeleton } from "./insert.ts";
import { VIEW_DEFS, type ViewDef } from "./views/registry.ts";
import { noteKind } from "./yamlpos.ts";

/** The views, each with the line saying what it is for. */
class ViewPicker extends FuzzySuggestModal<ViewDef> {
  private editor: Editor;

  constructor(app: App, editor: Editor) {
    super(app);
    this.editor = editor;
    this.setPlaceholder("Add a panel: choose a view");
  }

  getItems(): ViewDef[] {
    return [...VIEW_DEFS];
  }

  getItemText(def: ViewDef): string {
    return `${def.id} ${VIEW_HINTS[def.id] ?? ""}`;
  }

  renderSuggestion(match: { item: ViewDef }, el: HTMLElement): void {
    el.createDiv({ cls: "na-suggest-key", text: match.item.id });
    el.createDiv({ cls: "na-suggest-hint", text: VIEW_HINTS[match.item.id] ?? "" });
  }

  onChooseItem(def: ViewDef): void {
    // As the note stands now, not as it did when the list opened.
    const found = insertPanel(this.editor.getValue(), skeleton(def));
    if ("refusal" in found) return void new Notice(found.refusal);
    const { edit, cursor } = found;
    this.editor.replaceRange(edit.text, edit.from, edit.to);
    this.editor.setCursor(cursor);
    this.editor.focus();
  }
}

/** "Insert panel": adds a starter panel for a chosen view to the open app or component note. */
export function registerInsertPanel(plugin: Plugin): void {
  plugin.addCommand({
    id: "insert-panel",
    name: "Insert panel",
    editorCheckCallback: (checking, editor) => {
      const text = editor.getValue();
      if (!noteKind(text.split(/\r?\n/))) return false;
      if (!checking) {
        const refusal = refusalFor(text);
        if (refusal) new Notice(refusal);
        else new ViewPicker(plugin.app, editor).open();
      }
      return true;
    },
  });
}
