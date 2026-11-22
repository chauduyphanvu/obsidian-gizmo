import {
  EditorSuggest, parseYaml, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type Plugin,
  type TFile,
} from "obsidian";
import { frontmatterOf } from "./bundle.ts";
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
 * component, and the app's own names (its data blocks, the lists it saves, their fields) where a
 * value names one. Everything comes from the plugin's own registries and the note (see hints.ts);
 * nothing is fetched.
 */
class KeySuggest extends EditorSuggest<Suggestion> {
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const found = this.at(headLines(editor), cursor, file);
    return found ? { start: found.from, end: cursor, query: found.prefix } : null;
  }

  getSuggestions(context: EditorSuggestContext): Suggestion[] {
    return this.at(headLines(context.editor), context.end, context.file)?.suggestions ?? [];
  }

  /** What to offer at the cursor; the keys as typed are read as YAML, or as Obsidian last read them while they aren't YAML yet. */
  private at(lines: string[], cursor: EditorPosition, file: TFile | null) {
    const keys = () => frontmatterOf(lines.join("\n"), parseYaml) ?? (file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined);
    return suggestionsAt(lines, cursor.line, cursor.ch, keys);
  }

  renderSuggestion(suggestion: Suggestion, el: HTMLElement): void {
    el.createDiv({ cls: "gz-suggest-key", text: suggestion.text });
    if (suggestion.hint) el.createDiv({ cls: "gz-suggest-hint", text: suggestion.hint });
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
