import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_MAX, APP_PAD, HOSTED_MAX, HOSTED_PAD, columnsFor, rowTracks, spanOn, widthFor } from "../src/layout.ts";

test("column count follows the app width, from 4 on a wide pane to 1 on a phone", () => {
  assert.deepEqual([960, 1400, 700, 450, 390, 0].map((width) => columnsFor(width)), [4, 4, 3, 2, 1, 4]);
});

test("spans never exceed the columns there are", () => {
  assert.deepEqual([spanOn(4, 2), spanOn(2, 4), spanOn(3, 1)], [2, 2, 1]);
});

test("drawing widths fill the panel, which has no padding of its own, and shrink with its tracks", () => {
  assert.equal(widthFor(12, 960), 960 - 48);
  // A column of four is 3 tracks: the content less three 24 px gaps, in four.
  assert.equal(widthFor(3, 960), (912 - 72) / 4);
  assert.equal(widthFor(6, 960), ((912 - 72) / 4) * 2 + 24);
  assert.equal(widthFor(12, 390), 390 - 48);
});

test("an app in an embed or a lens has no padding of its own, so its panels are that much wider", () => {
  assert.deepEqual([APP_PAD, HOSTED_PAD], [48, 0]);
  assert.equal(widthFor(12, 390, HOSTED_PAD), 390);
  assert.equal(widthFor(12, 390, HOSTED_PAD) - widthFor(12, 390, APP_PAD), 48);
  assert.equal(widthFor(3, 960, HOSTED_PAD), (960 - 72) / 4);
  assert.equal(widthFor(6, 960, HOSTED_PAD), ((960 - 72) / 4) * 2 + 24);
  // The padding decides how many columns fit: 424 px holds two of 180 with no padding, one with 48.
  assert.deepEqual([columnsFor(424), columnsFor(424, APP_PAD), columnsFor(424, HOSTED_PAD)], [1, 1, 2]);
  assert.equal(columnsFor(0, HOSTED_PAD), 4);
});

test("an app in an embed or a lens isn't capped at 960 px: it lays out at its real width", () => {
  assert.deepEqual([APP_MAX, HOSTED_MAX], [960, Infinity]);
  assert.equal(widthFor(12, 1400, HOSTED_PAD, HOSTED_MAX), 1400);
  assert.equal(widthFor(3, 1400, HOSTED_PAD, HOSTED_MAX), (1400 - 72) / 4);
  // In its own tab the shell is at most 960 px, as before.
  assert.equal(widthFor(12, 1400, APP_PAD, APP_MAX), 960 - 48);
  assert.equal(widthFor(12, 1400), 960 - 48);
  // Not laid out yet, either counts as the widest app tab, never as endless.
  assert.equal(widthFor(12, 0, HOSTED_PAD, HOSTED_MAX), 960);
  assert.equal(columnsFor(0, HOSTED_PAD, HOSTED_MAX), 4);
  assert.equal(columnsFor(1400, HOSTED_PAD, HOSTED_MAX), 4);
});

const small = { span: 1, grows: true };
const wide = { span: 4, grows: true };

test("a row of panels that may grow shares the room it has left, in proportion to their spans", () => {
  assert.deepEqual(rowTracks([small, small], 4), [6, 6]);
  assert.deepEqual(rowTracks([small, { span: 2, grows: true }], 4), [4, 8]);
  assert.deepEqual(rowTracks([small, small, small], 4), [4, 4, 4]);
  // A full row is left as it is, and a lone small panel takes its whole row.
  assert.deepEqual(rowTracks([small, small, small, small], 4), [3, 3, 3, 3]);
  assert.deepEqual(rowTracks([small, wide], 4), [12, 12]);
});

test("a panel that asked for its span keeps its row as it is", () => {
  assert.deepEqual(rowTracks([small, { span: 2, grows: false }], 4), [3, 6]);
  assert.deepEqual(rowTracks([{ span: 1, grows: false }], 4), [3]);
});

test("rows break where the grid breaks them: a panel that doesn't fit, and the tab bar", () => {
  assert.deepEqual(rowTracks([small, small, small, wide, small], 4), [4, 4, 4, 12, 12]);
  assert.deepEqual(rowTracks([small, null, small, small], 4), [12, null, 6, 6]);
  // Three columns: two of span 2 don't fit one row, so each fills its own.
  assert.deepEqual(rowTracks([{ span: 2, grows: true }, { span: 2, grows: true }], 3), [12, 12]);
  assert.deepEqual(rowTracks([small, small], 3), [6, 6]);
  assert.deepEqual(rowTracks([small, { span: 2, grows: true }], 1), [12, 12]);
});
