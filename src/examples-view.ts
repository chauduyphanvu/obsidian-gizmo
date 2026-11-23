/**
 * The window of "New app from lines…": the lines pasted, what Gizmo reads them as, the answer the
 * person knows and the asks that give it, and the two notes it would make, as text to read before
 * Keep. Drawn into any element, so the command's window and the tests share it.
 */
import { appNoteText, askKindOf, exampleNameProblem, findPanels, inferRows, kindNoteText, readAnswer, type Candidate, type Inferred } from "./examples.ts";
import type { Row } from "./data.ts";

/** What Keep makes: the kind note with its rows, and the app note over it. */
export interface ExamplePlan {
  kind: string;
  kindNote: string;
  kindText: string;
  appNote: string;
  appText: string;
  rows: Row[];
}

export interface ExampleActs {
  now(): Date;
  /** Whether a note of this name is already where the new ones would go. */
  taken(note: string): boolean;
  /** Whether a kind, or a name a capture line can start with, is already called this anywhere in the vault: a second one would leave the word reaching neither. */
  used?(name: string): boolean;
  /** Makes the notes and the rows; says why when it can't. */
  make(plan: ExamplePlan): Promise<string | undefined>;
  cancel(): void;
}

const PLACEHOLDER = ["mar 3 groceries 62.10 weekly shop", "mar 4 coffee 4.50", "mar 9 transport 31 train"].join("\n");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const typeWords = (t: string | string[]) => (Array.isArray(t) ? `one of ${t.join(", ")}` : t === "number" ? "a number" : t === "text" ? "text" : `a number in ${t}`);

/** What the lines were read as, in a sentence a person can check against them. */
export function readWords(r: Inferred): string {
  if (!r.rows.length) return "No line could be read yet.";
  const fields = r.fields.map(([f, t]) => `${f} (${typeWords(t)})`).join(", then ");
  return `Read ${r.rows.length} ${r.rows.length === 1 ? "line" : "lines"}${r.dated ? ", each with its day" : ", all for now"}: ${fields}.`;
}

/** The plan as it stands, or why there is none yet. */
export function planOf(lines: string, name: string, answer: string, picked: number, acts: ExampleActs): { plan?: ExamplePlan; inferred: Inferred; candidates: Candidate[]; problem?: string; note?: string } {
  const now = acts.now();
  const inferred = inferRows(lines, now);
  const none = { inferred, candidates: [] };
  if (!inferred.rows.length) return { ...none, problem: lines.trim() ? "None of these lines could be read: put a number or a word on each" : "Paste a few lines, one thing a line" };
  const kind = name.trim();
  const bad = exampleNameProblem(kind);
  if (bad) return { ...none, problem: bad };
  if (inferred.fields.some(([f]) => f === kind)) return { ...none, problem: `“${kind}” is also the name of a field here; give the rows another name` };
  if (acts.used?.(kind)) return { ...none, problem: `“${kind}” already names a kind or a shortcut in this vault, so a capture line couldn't tell them apart; give the rows another name` };
  const kindNote = capital(kind);
  const appNote = `${kindNote} log`;
  for (const note of [kindNote, appNote]) if (acts.taken(note)) return { ...none, problem: `A note called ${note} is already here; give the rows another name` };
  const link = `[[${kindNote}]]`;
  const asked = askKindOf(kind, `${kindNote}.md`, inferred);
  asked.link = link;
  let candidates: Candidate[] = [];
  let note: string | undefined;
  if (answer.trim()) {
    const read = readAnswer(answer);
    if ("error" in read) return { ...none, problem: read.error };
    const found = findPanels(asked, inferred.rows, read, now);
    candidates = found.candidates;
    if (!candidates.length) note = `No question over these rows gives ${read.value}. Check the number, or leave the answer out and add panels later.`;
    else if (found.unused.length) note = `Not used: ${found.unused.join(", ")}.`;
  }
  const chosen = candidates[Math.min(picked, candidates.length - 1)];
  // With no answer to go by: the total of the first number, or how many rows there are.
  const number = inferred.fields.find(([, t]) => t !== "text" && !Array.isArray(t))?.[0];
  const plain = { view: "number", title: number ? `Total ${number}` : `How many`, source: link, ...(number ? { field: number, agg: "sum" } : { agg: "count" }) };
  const panels = [chosen?.panel ?? plain];
  return {
    inferred, candidates, note,
    plan: { kind, kindNote, kindText: kindNoteText(kind, inferred), appNote, appText: appNoteText(`Keep track of ${kind}`, link, panels), rows: inferred.rows },
  };
}

/** Draws the window. */
export function drawExamples(el: HTMLElement, acts: ExampleActs): void {
  el.empty();
  el.addClass("gz-examples");
  el.createDiv({ cls: "gz-label", text: "Paste lines as you would say them, one thing a line. Gizmo works out the fields from how they line up." });
  const lines = el.createEl("textarea", { cls: "gz-examples-lines", attr: { rows: "7", placeholder: PLACEHOLDER, "aria-label": "Lines to read" } });
  const row = el.createDiv({ cls: "gz-examples-row" });
  const nameBox = row.createEl("label", { text: "What is each line? " });
  const name = nameBox.createEl("input", { type: "text", attr: { placeholder: "spend" } });
  const answerBox = row.createEl("label", { text: "One answer you know (optional) " });
  const answer = answerBox.createEl("input", { type: "text", attr: { placeholder: "groceries = 310.40" } });
  const read = el.createDiv({ cls: "gz-examples-read", attr: { role: "status" } });
  const picks = el.createDiv({ cls: "gz-examples-picks" });
  const notes = el.createDiv({ cls: "gz-examples-notes" });
  const said = el.createDiv({ cls: "gz-new-app-problem", attr: { role: "status" } });
  const buttons = el.createDiv({ cls: "modal-button-container" });
  buttons.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => acts.cancel());
  const keep = buttons.createEl("button", { cls: "mod-cta", text: "Keep", attr: { type: "button" } });
  let picked = 0;
  let current: ExamplePlan | undefined;

  const render = () => {
    const state = planOf(lines.value, name.value, answer.value, picked, acts);
    current = state.plan;
    read.empty();
    picks.empty();
    notes.empty();
    read.createDiv({ text: readWords(state.inferred) });
    for (const s of state.inferred.skipped.slice(0, 5)) read.createDiv({ cls: "gz-examples-skipped", text: `Line ${s.line} left out (“${s.text}”): ${s.why}.` });
    if (state.inferred.skipped.length > 5) read.createDiv({ cls: "gz-examples-skipped", text: `… and ${state.inferred.skipped.length - 5} more left out.` });
    // What's wrong is said once there is something typed to be wrong.
    said.setText(lines.value.trim() && (name.value.trim() || !state.inferred.rows.length) ? state.problem ?? "" : "");
    keep.disabled = !state.plan;
    if (state.candidates.length) {
      picks.createDiv({ cls: "gz-explain-title", text: state.candidates.length === 1 ? "The question that gives it" : "Questions that give it" });
      state.candidates.forEach((c, i) => {
        const line = picks.createEl("label", { cls: "gz-examples-pick" });
        const radio = line.createEl("input", { type: "radio", attr: { name: "gz-examples-pick" } });
        radio.checked = i === Math.min(picked, state.candidates.length - 1);
        radio.addEventListener("change", () => {
          picked = i;
          render();
        });
        line.createSpan({ text: ` ? ${name.value.trim()} ${c.ask}`.trimEnd() });
        line.createSpan({ cls: "gz-examples-rows", text: ` · ${c.rows} ${c.rows === 1 ? "row" : "rows"}${c.differs ? ` · ${c.differs}` : ""}` });
      });
    }
    if (state.note) picks.createDiv({ cls: "gz-examples-skipped", text: state.note });
    if (!state.plan) return;
    notes.createDiv({ cls: "gz-explain-title", text: `Keep makes ${state.plan.kindNote}, with ${state.plan.rows.length} ${state.plan.rows.length === 1 ? "row" : "rows"}, and ${state.plan.appNote}` });
    notes.createEl("pre", { text: state.plan.kindText.trim() });
    notes.createEl("pre", { text: state.plan.appText.trim() });
  };
  for (const input of [lines, name, answer]) input.addEventListener("input", () => {
    if (input === answer) picked = 0;
    render();
  });
  keep.addEventListener("click", () => {
    if (!current || keep.disabled) return;
    keep.disabled = true;
    void acts.make(current).then((failed) => {
      if (failed === undefined) return;
      said.setText(failed);
      keep.disabled = false;
    });
  });
  render();
}
