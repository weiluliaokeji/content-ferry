import assert from "node:assert/strict";
import test from "node:test";
import { isFirstJuejinTagClick, toggleJuejinTagId } from "./juejin-tags.mjs";

test("double-click removes only 人工智能 after the remaining tags reflow", () => {
  let ids = ["Agent", "人工智能", "架构"];
  for (const [detail, id] of [[1, "人工智能"], [2, "Agent"]]) {
    if (isFirstJuejinTagClick(detail)) ids = toggleJuejinTagId(ids, id);
  }
  assert.deepEqual(ids, ["Agent", "架构"]);
});

test("single clicks and programmatic clicks are accepted; subsequent clicks are ignored", () => {
  assert.equal(isFirstJuejinTagClick(0), true);
  assert.equal(isFirstJuejinTagClick(1), true);
  assert.equal(isFirstJuejinTagClick(2), false);
  assert.equal(isFirstJuejinTagClick(3), false);
});
