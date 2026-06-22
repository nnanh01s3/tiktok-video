import { test } from "node:test";
import assert from "node:assert/strict";
import { jaccardSimilarity, isSameText } from "../../src/douyin/utils/jaccard.mjs";

test("jaccardSimilarity: identical strings = 1", () => {
  assert.equal(jaccardSimilarity("你好世界", "你好世界"), 1);
});

test("jaccardSimilarity: disjoint strings = 0", () => {
  assert.equal(jaccardSimilarity("abc", "xyz"), 0);
});

test("jaccardSimilarity: overlapping returns ratio", () => {
  const sim = jaccardSimilarity("你好", "你好。");
  assert.ok(sim >= 0.6 && sim < 1, `got ${sim}`);
});

test("jaccardSimilarity: empty inputs return 0", () => {
  assert.equal(jaccardSimilarity("", ""), 0);
  assert.equal(jaccardSimilarity("abc", ""), 0);
});

test("isSameText: high similarity = true", () => {
  assert.equal(isSameText("他活了一百岁", "他活了一百岁。", 0.85), true);
});

test("isSameText: different cues = false", () => {
  assert.equal(isSameText("他活了一百岁", "突然觉醒了", 0.85), false);
});
