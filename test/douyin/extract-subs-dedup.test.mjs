import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupOCRResults } from "../../src/douyin/extract-subs.mjs";

test("dedupOCRResults: merges consecutive identical frames", () => {
  const ocr = [
    { frame_idx: 10, text: "他活了一百岁", confidence: 0.94 },
    { frame_idx: 11, text: "他活了一百岁", confidence: 0.96 },
    { frame_idx: 12, text: "他活了一百岁。", confidence: 0.95 },
    { frame_idx: 13, text: "突然觉醒了", confidence: 0.91 },
    { frame_idx: 14, text: "突然觉醒了", confidence: 0.92 },
  ];
  const cues = dedupOCRResults(ocr, { intervalMs: 300, jaccardThreshold: 0.85, minConfidence: 0.6 });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "他活了一百岁");
  assert.equal(cues[0].start_ms, 10 * 300);
  assert.equal(cues[0].end_ms, 12 * 300 + 300);
  assert.equal(cues[1].text, "突然觉醒了");
});

test("dedupOCRResults: drops low-confidence frames", () => {
  const ocr = [
    { frame_idx: 5, text: "hi", confidence: 0.3 },
    { frame_idx: 6, text: "hello", confidence: 0.9 },
  ];
  const cues = dedupOCRResults(ocr, { intervalMs: 300, jaccardThreshold: 0.85, minConfidence: 0.6 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "hello");
});

test("dedupOCRResults: drops empty / too-short text", () => {
  const ocr = [
    { frame_idx: 1, text: "", confidence: 0.9 },
    { frame_idx: 2, text: "a", confidence: 0.9 },
    { frame_idx: 3, text: "你好世界", confidence: 0.95 },
  ];
  const cues = dedupOCRResults(ocr, { intervalMs: 300, jaccardThreshold: 0.85, minConfidence: 0.6 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "你好世界");
});

test("dedupOCRResults: handles gaps between cues", () => {
  const ocr = [
    { frame_idx: 1, text: "first", confidence: 0.9 },
    { frame_idx: 2, text: "first", confidence: 0.9 },
    { frame_idx: 10, text: "second", confidence: 0.9 },
  ];
  const cues = dedupOCRResults(ocr, { intervalMs: 300, jaccardThreshold: 0.85, minConfidence: 0.6 });
  assert.equal(cues.length, 2);
});
