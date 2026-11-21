/** A line break, tab or other control character (U+0000 to U+001F, and DEL). */
const isControl = (c: string) => {
  const n = c.charCodeAt(0);
  return n < 0x20 || n === 0x7f;
};

/** Whether text holds a control character. */
export function hasControl(text: string): boolean {
  return [...text].some(isControl);
}

/** The text with each control character shown as `mark`. */
export function maskControl(text: string, mark: string): string {
  return [...text].map((c) => (isControl(c) ? mark : c)).join("");
}
