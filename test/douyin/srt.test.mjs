import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSRT, serializeSRT, validateSRTMatch } from "../../src/douyin/utils/srt.mjs";

const SAMPLE = `1
00:00:03,600 --> 00:00:04,800
他活了一百岁

2
00:00:04,800 --> 00:00:06,300
突然觉醒了

`;

test("parseSRT: extracts cues with timestamps", () => {
  const cues = parseSRT(SAMPLE);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].index, 1);
  assert.equal(cues[0].start_ms, 3600);
  assert.equal(cues[0].end_ms, 4800);
  assert.equal(cues[0].text, "他活了一百岁");
});

test("parseSRT: handles multi-line cue text", () => {
  const src = `1\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two\n\n`;
  const cues = parseSRT(src);
  assert.equal(cues[0].text, "Line one\nLine two");
});

test("parseSRT: tolerates trailing whitespace + missing final newline", () => {
  const src = `1\n00:00:01,000 --> 00:00:02,000\nhi`;
  const cues = parseSRT(src);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "hi");
});

test("serializeSRT: round-trip preserves content", () => {
  const cues = parseSRT(SAMPLE);
  const out = serializeSRT(cues);
  const reparsed = parseSRT(out);
  assert.equal(reparsed.length, cues.length);
  assert.equal(reparsed[0].text, cues[0].text);
  assert.equal(reparsed[0].start_ms, cues[0].start_ms);
});

test("validateSRTMatch: returns ok when timings match", () => {
  const a = parseSRT(SAMPLE);
  const b = parseSRT(SAMPLE);
  const { ok, errors } = validateSRTMatch(a, b);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("validateSRTMatch: detects cue count mismatch", () => {
  const a = parseSRT(SAMPLE);
  const b = a.slice(0, 1);
  const { ok, errors } = validateSRTMatch(a, b);
  assert.equal(ok, false);
  assert.ok(errors[0].includes("count mismatch"));
});

test("validateSRTMatch: detects timing drift", () => {
  const a = parseSRT(SAMPLE);
  const b = parseSRT(SAMPLE);
  b[0].start_ms = 9999;
  const { ok, errors } = validateSRTMatch(a, b);
  assert.equal(ok, false);
  assert.ok(errors[0].includes("timing"));
});
