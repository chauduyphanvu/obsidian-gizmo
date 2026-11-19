import assert from "node:assert/strict";
import { test } from "node:test";
import { columnsFor, spanOn, widthFor } from "../src/layout.ts";

test("column count follows the app width, from 4 on a wide pane to 1 on a phone", () => {
  assert.deepEqual([960, 1400, 700, 450, 390, 0].map(columnsFor), [4, 4, 3, 2, 1, 4]);
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
