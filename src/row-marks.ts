/**
 * Each row of a saved list carries its place in the list under this key, through where, sort,
 * limit and compute (rows are copied with their symbol keys), so an edit can find it again.
 */
export const ROW_INDEX = Symbol("row index");

/** Marks a row a what-if branch added (see Ledger's `branch`), not enumerable, as ROW_ID is. */
export const WHAT_IF = Symbol("what-if row");

export function isWhatIf(row: unknown): boolean {
  return !!row && typeof row === "object" && (row as Record<symbol, unknown>)[WHAT_IF] === true;
}

/** Marks a kind's row set aside from the planned line (its own ask dismissed), not enumerable. */
export const ASIDE_PLAN = Symbol("planned row set aside");

/** Whether a kind's row is a planned row set aside through its own ask, not a row from a file or another vault set aside. */
export function isSetAsidePlan(row: unknown): boolean {
  return !!row && typeof row === "object" && (row as Record<symbol, unknown>)[ASIDE_PLAN] === true;
}
