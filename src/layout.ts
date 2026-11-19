/**
 * Grid arithmetic, kept in step with styles.css: the app is at most 960 px wide with 16 px padding
 * each side; columns are at least 200 px with 12 px gaps; a panel has 16 px padding and a 1 px
 * border. Widths are worked out here rather than measured, so a chart in a hidden tab is still
 * drawn at its real size.
 */
const MAX_WIDTH = 960, APP_PAD = 32, MIN_COLUMN = 200, GAP = 12, PANEL_INSET = 34;
export const MAX_COLUMNS = 4;

/** The app's content width; an element not laid out yet (0) counts as the widest. */
function content(appWidth: number): number {
  return Math.min(appWidth || MAX_WIDTH, MAX_WIDTH) - APP_PAD;
}

export function columnsFor(appWidth: number): number {
  const fit = Math.floor((content(appWidth) + GAP) / (MIN_COLUMN + GAP));
  return Math.max(1, Math.min(MAX_COLUMNS, fit));
}

/** A panel's span on this grid: what it asks for, but never more than there are columns. */
export function spanOn(span: number, columns: number): number {
  return Math.max(1, Math.min(span, columns));
}

/** The drawing width inside a panel spanning `span` of `columns` columns. */
export function widthFor(span: number, columns: number, appWidth: number): number {
  const column = (content(appWidth) - GAP * (columns - 1)) / columns;
  const k = spanOn(span, columns);
  return column * k + GAP * (k - 1) - PANEL_INSET;
}
