/**
 * Grid arithmetic, kept in step with styles.css: in its own tab the app is at most 960 px wide
 * with 24 px padding each side; in an embed or a lens (`.gz-embed .gizmo`, `.gz-lens .gizmo`)
 * it has neither cap nor padding. Columns are at least 180 px with 24 px gaps, laid on a grid of
 * 12 tracks (a column is 12 / columns of them). Panels have no padding or border of their own, so
 * a chart is drawn at its panel's full width. Widths are worked out here rather than measured, so
 * a chart in a hidden tab is still drawn at its real size.
 */
const MIN_COLUMN = 180, GAP = 24;
export const TRACKS = 12;
/** The padding of an app's shell, both sides together, in its own tab and when hosted by another note. */
export const APP_PAD = 48, HOSTED_PAD = 0;
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

/** One panel in grid order: the columns it asks for, and whether it may grow to fill its row. */
export interface Slot {
  span: number;
  grows: boolean;
}

/**
 * The tracks each slot takes, placed in order as the grid places them: a slot that doesn't fit
 * what is left of its row starts the next one, and `null` (the tab bar) fills a row of its own.
 * A row with room left whose slots may all grow is shared between them in proportion to their
 * spans, so no panel sits beside an empty part of the row.
 */
export function rowTracks(slots: (Slot | null)[], columns: number): (number | null)[] {
  const per = TRACKS / columns;
  const out = slots.map((s) => (s ? spanOn(s.span, columns) * per : null));
  let row: number[] = [];
  let used = 0;
  const close = () => {
    if (row.length && used < columns && row.every((i) => slots[i]!.grows)) {
      for (const i of row) out[i] = (spanOn(slots[i]!.span, columns) * TRACKS) / used;
    }
    row = [];
    used = 0;
  };
  slots.forEach((s, i) => {
    if (!s) return close();
    const k = spanOn(s.span, columns);
    if (used + k > columns) close();
    row.push(i);
    used += k;
  });
  close();
  return out;
}

/** The drawing width of a panel `tracks` twelfths of the row wide. */
export function widthFor(tracks: number, appWidth: number, pad = APP_PAD, max = APP_MAX): number {
  const track = (content(appWidth, pad, max) - GAP * (TRACKS - 1)) / TRACKS;
  return track * tracks + GAP * (tracks - 1);
}

/**
 * The composed layout is one column, kept in step with styles.css (`.gizmo.gz-composed`): in its own
 * tab at most 760 px of content, with 44 px padding each side, or 16 px once the app is narrower
 * than 600 px; hosted, the host's width with no padding. Every panel is drawn at the column's width.
 */
export const COLUMN_MAX = 848, COLUMN_PAD = 88, NARROW_PAD = 32, NARROW = 600;

/** Whether an app this wide is narrow: one column of facts and less padding. Not laid out yet (0) isn't. */
export function isNarrow(appWidth: number): boolean {
  return appWidth > 0 && appWidth < NARROW;
}

/** The drawing width of a panel in the composed column; not laid out yet (0) counts as the widest app tab. */
export function composedWidth(appWidth: number, pad = isNarrow(appWidth) ? NARROW_PAD : COLUMN_PAD, max = COLUMN_MAX): number {
  return Math.min(appWidth || COLUMN_MAX, max) - pad;
}
