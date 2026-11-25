/** A code fence; a run of backticks followed by another backtick on its line is inline code instead. */
const FENCE = /^[ \t]*(`{3,}(?!.*`)|~{3,})/;

/**
 * One line of a note read for code blocks: whether it is code (inside a block, or a fence line), and
 * the fence still open after it. A block closes only on a bare fence of its own character, at least
 * as long as the one that opened it, as Obsidian reads them.
 */
export function fenceStep(open: string | undefined, line: string): { code: boolean; open: string | undefined } {
  const f = FENCE.exec(line);
  if (open) return { code: true, open: f && f[1][0] === open[0] && f[1].length >= open.length && line.trim() === f[1] ? undefined : open };
  return f ? { code: true, open: f[1] } : { code: false, open: undefined };
}
