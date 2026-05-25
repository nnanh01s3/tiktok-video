import { test } from "node:test";
import assert from "node:assert/strict";
import { parseViewCount } from "../../src/douyin/utils/parseViewCount.mjs";

test("parseViewCount: plain integer", () => {
  assert.equal(parseViewCount("856"), 856);
  assert.equal(parseViewCount("1234"), 1234);
});

test("parseViewCount: k suffix (thousand)", () => {
  assert.equal(parseViewCount("1.2k"), 1200);
  assert.equal(parseViewCount("12K"), 12000);
});

test("parseViewCount: w suffix (Chinese 万 = 10000)", () => {
  assert.equal(parseViewCount("2.3w"), 23000);
  assert.equal(parseViewCount("10w"), 100000);
  assert.equal(parseViewCount("1.5W"), 15000);
});

test("parseViewCount: 万 character directly", () => {
  assert.equal(parseViewCount("3.5万"), 35000);
});

test("parseViewCount: invalid input returns 0", () => {
  assert.equal(parseViewCount(""), 0);
  assert.equal(parseViewCount("abc"), 0);
  assert.equal(parseViewCount(null), 0);
  assert.equal(parseViewCount(undefined), 0);
});
