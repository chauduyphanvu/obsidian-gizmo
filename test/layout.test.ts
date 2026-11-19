import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_MAX, APP_PAD, HOSTED_MAX, HOSTED_PAD, columnsFor, spanOn, widthFor } from "../src/layout.ts";

test("column count follows the app width, from 4 on a wide pane to 1 on a phone", () => {
  assert.deepEqual([960, 1400, 700, 450, 390, 0].map((width) => columnsFor(width)), [4, 4, 3, 2, 1, 4]);
});

test("spans never exceed the columns there are", () => {
  assert.deepEqual([spanOn(4, 2), spanOn(2, 4), spanOn(3, 1)], [2, 2, 1]);
});

test("drawing widths match the old full-width chart and shrink with the span", () => {
  assert.equal(widthFor(4, 4, 960), 960 - 32 - 34);
  assert.equal(widthFor(1, 4, 960), (928 - 36) / 4 - 34);
  assert.equal(widthFor(2, 4, 960), ((928 - 36) / 4) * 2 + 12 - 34);
  assert.equal(widthFor(4, 1, 390), 390 - 32 - 34);
});

test("an app in an embed or a lens has no padding of its own, so its panels are that much wider", () => {
  assert.deepEqual([APP_PAD, HOSTED_PAD], [32, 0]);
  assert.equal(widthFor(4, 1, 390, HOSTED_PAD), 390 - 34);
  assert.equal(widthFor(4, 1, 390, HOSTED_PAD) - widthFor(4, 1, 390, APP_PAD), 32);
  assert.equal(widthFor(1, 4, 960, HOSTED_PAD), (960 - 36) / 4 - 34);
  assert.equal(widthFor(2, 4, 960, HOSTED_PAD), ((960 - 36) / 4) * 2 + 12 - 34);
  // The padding decides how many columns fit: 424 px holds two of 200 with no padding, one with 32.
  assert.deepEqual([columnsFor(424), columnsFor(424, APP_PAD), columnsFor(424, HOSTED_PAD)], [1, 1, 2]);
  assert.equal(columnsFor(0, HOSTED_PAD), 4);
});

test("an app in an embed or a lens isn't capped at 960 px: it lays out at its real width", () => {
  assert.deepEqual([APP_MAX, HOSTED_MAX], [960, Infinity]);
  assert.equal(widthFor(4, 4, 1400, HOSTED_PAD, HOSTED_MAX), 1400 - 34);
  assert.equal(widthFor(1, 4, 1400, HOSTED_PAD, HOSTED_MAX), (1400 - 36) / 4 - 34);
  // In its own tab the shell is at most 960 px, as before.
  assert.equal(widthFor(4, 4, 1400, APP_PAD, APP_MAX), 960 - 32 - 34);
  assert.equal(widthFor(4, 4, 1400), 960 - 32 - 34);
  // Not laid out yet, either counts as the widest app tab, never as endless.
  assert.equal(widthFor(4, 4, 0, HOSTED_PAD, HOSTED_MAX), 960 - 34);
  assert.equal(columnsFor(0, HOSTED_PAD, HOSTED_MAX), 4);
  assert.equal(columnsFor(1400, HOSTED_PAD, HOSTED_MAX), 4);
});
