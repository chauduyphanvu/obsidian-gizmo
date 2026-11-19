/**
 * Grid arithmetic, kept in step with styles.css: in its own tab the app is at most 960 px wide
 * with 16 px padding each side; in an embed or a lens (`.na-embed .note-app`, `.na-lens .note-app`)
 * it has neither cap nor padding. Columns are at least 200 px with 12 px gaps; a panel has 16 px
 * padding and a 1 px border. Widths are worked out here rather than measured, so a chart in a
 * hidden tab is still drawn at its real size.
 */
const MIN_COLUMN = 200, GAP = 12, PANEL_INSET = 34;
/** The padding of an app's shell, both sides together, in its own tab and when hosted by another note. */
export const APP_PAD = 32, HOSTED_PAD = 0;
/** The widest an app's shell gets, in its own tab and when hosted by another note. */
export const APP_MAX = 960, HOSTED_MAX = Infinity;
export const MAX_COLUMNS = 4;

/** The app's content width; an element not laid out yet (0) counts as the widest app tab. */
function content(appWidth: number, pad: number, max: number): number {
  return Math.min(appWidth || APP_MAX, max) - pad;
}

export function columnsFor(appWidth: number, pad = APP_PAD, max = APP_MAX): number {
  const fit = Math.floor((content(appWidth, pad, max) + GAP) / (MIN_COLUMN + GAP));
  return Math.max(1, Math.min(MAX_COLUMNS, fit));
}

/** A panel's span on this grid: what it asks for, but never more than there are columns. */
export function spanOn(span: number, columns: number): number {
  return Math.max(1, Math.min(span, columns));
}

/** The drawing width inside a panel spanning `span` of `columns` columns. */
export function widthFor(span: number, columns: number, appWidth: number, pad = APP_PAD, max = APP_MAX): number {
  const column = (content(appWidth, pad, max) - GAP * (columns - 1)) / columns;
  const k = spanOn(span, columns);
  return column * k + GAP * (k - 1) - PANEL_INSET;
}
