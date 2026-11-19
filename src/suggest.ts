import {
  EditorSuggest, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type Plugin,
} from "obsidian";
import { completion, suggestionsAt, type Suggestion } from "./hints.ts";

/** A note's frontmatter is read at most this far, so a missing closing fence doesn't mean reading a whole book per keystroke. */
const MAX_LINES = 500;

/** The note's lines up to its closing `---`; just the first line when the note has no frontmatter. */
function headLines(editor: Editor): string[] {
  const lines: string[] = [];
  const count = Math.min(editor.lineCount(), MAX_LINES);
  for (let i = 0; i < count; i++) {
    lines.push(editor.getLine(i));
    const fence = lines[i].trimEnd() === "---";
    // Not frontmatter at all, or the closing fence.
    if (i === 0 ? !fence : fence) break;
  }
  return lines;
}

/**
 * Offers the keys and values the language allows while typing the frontmatter of an app or a
 * component. Everything comes from the plugin's own registries (see hints.ts); nothing is fetched.
 */
class KeySuggest extends EditorSuggest<Suggestion> {
  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const found = suggestionsAt(headLines(editor), cursor.line, cursor.ch);
    return found ? { start: found.from, end: cursor, query: found.prefix } : null;
  }

  getSuggestions(context: EditorSuggestContext): Suggestion[] {
    return suggestionsAt(headLines(context.editor), context.end.line, context.end.ch)?.suggestions ?? [];
  }

  renderSuggestion(suggestion: Suggestion, el: HTMLElement): void {
    el.createDiv({ cls: "na-suggest-key", text: suggestion.text });
    if (suggestion.hint) el.createDiv({ cls: "na-suggest-hint", text: suggestion.hint });
  }

  selectSuggestion(suggestion: Suggestion): void {
    const ctx = this.context;
    if (!ctx) return;
    const after = ctx.editor.getLine(ctx.end.line).slice(ctx.end.ch);
    const text = completion(suggestion, after);
    ctx.editor.replaceRange(text, ctx.start, ctx.end);
    ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + text.length });
  }
}

/** Turns on the help for typing an app's keys by hand. */
export function registerAuthoring(plugin: Plugin): void {
  plugin.registerEditorSuggest(new KeySuggest(plugin.app));
}
