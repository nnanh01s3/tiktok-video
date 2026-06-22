# Douyin Repurpose Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modular CLI pipeline at `src/douyin/` that auto-discovers Douyin videos by keyword/creator, OCRs Chinese hard-subs (PaddleOCR with Gemini ASR fallback), translates to Vietnamese (Claude Haiku), burns in subtitles via FFmpeg/libass, and publishes to multiple channels (TikTok/FB Reels/FB page/YouTube Shorts) through `social-poster.js`.

**Architecture:** Modular Node ESM (`.mjs`) with disk-artifact pipeline — each module reads inputs from `D:/tiktok/douyin/{modal_id}/` and writes outputs there. Chrome CDP for Douyin discovery (logged-in profile). Python subprocess for PaddleOCR. Single FFmpeg command for compose. Config-driven channel publish.

**Tech Stack:** Node 20+ ESM, `yt-dlp`, FFmpeg + libass, PaddleOCR (Python), Chrome CDP, Anthropic SDK (Claude Haiku), Google GenAI SDK (Gemini Flash multimodal), existing `social-poster.js`.

**Spec reference:** `docs/superpowers/specs/2026-05-25-douyin-repurpose-pipeline-design.md`

**Test approach:** Node built-in `node:test` for pure functions (SRT parsing, view-count parsing, dedup logic). Integration smoke tests with `--dry-run` flags for CDP/API-dependent modules. No mocking framework — keep simple.

---

## Pre-Implementation: Worktree Setup

Before starting tasks, verify worktree isolation (per `superpowers:using-git-worktrees`).

- [ ] **Step 0.1: Create isolated worktree**

```bash
cd /d/tiktok
git worktree add ../tiktok-douyin -b feat/douyin-repurpose
cd ../tiktok-douyin
```

Expected: New worktree at `D:/tiktok-douyin` on branch `feat/douyin-repurpose`.

- [ ] **Step 0.2: Verify clean state**

```bash
git status
```

Expected: clean working tree on `feat/douyin-repurpose`.

---

## File Structure

**Creates:**
- `src/douyin/config.mjs` — central config (keywords, channels, OCR params, subtitle style)
- `src/douyin/state.mjs` — read/write `state.json` with status enum
- `src/douyin/utils/parseViewCount.mjs` — parse "2.3w" → 23000
- `src/douyin/utils/srt.mjs` — SRT parse/serialize/validate
- `src/douyin/utils/jaccard.mjs` — text similarity for OCR dedup
- `src/douyin/utils/log.mjs` — shared logger (file + console)
- `src/douyin/utils/cdp.mjs` — withChrome helper for Douyin (variant of fb_repost)
- `src/douyin/discover.mjs` — Chrome CDP scrape Douyin search/creator pages
- `src/douyin/download.mjs` — yt-dlp wrapper
- `src/douyin/ocr-paddle.mjs` — Node adapter to Python PaddleOCR script
- `src/douyin/extract-subs.mjs` — frame sampling + OCR + dedup + SRT
- `src/douyin/fallback-asr.mjs` — Gemini multimodal ASR
- `src/douyin/translate.mjs` — Claude Haiku CN→VN
- `src/douyin/compose.mjs` — FFmpeg burn-in subtitle
- `src/douyin/publish.mjs` — multi-channel publish + caption gen
- `src/douyin/repurpose.mjs` — orchestrator CLI
- `scripts/paddle_ocr_batch.py` — PaddleOCR Python entry
- `test/douyin/parseViewCount.test.mjs` — unit
- `test/douyin/srt.test.mjs` — unit
- `test/douyin/jaccard.test.mjs` — unit
- `test/douyin/state.test.mjs` — unit
- `test/douyin/extract-subs-dedup.test.mjs` — unit
- `test/fixtures/douyin/sample_subs.srt` — test fixture
- `test/fixtures/douyin/README.md` — fixture documentation

**Modifies:**
- `package.json` — add `"test:douyin": "node --test test/douyin/"` script

---

## Task 1: Foundation — config + state + logger

**Files:**
- Create: `src/douyin/config.mjs`
- Create: `src/douyin/state.mjs`
- Create: `src/douyin/utils/log.mjs`
- Create: `test/douyin/state.test.mjs`

- [ ] **Step 1.1: Write the failing state test**

`test/douyin/state.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../../src/douyin/state.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "douyin-state-"));
}

test("state: empty when file does not exist", () => {
  const dir = makeTempDir();
  const state = createState(join(dir, "state.json"));
  assert.deepEqual(state.list(), []);
  rmSync(dir, { recursive: true, force: true });
});

test("state: upsert sets status and persists", () => {
  const dir = makeTempDir();
  const path = join(dir, "state.json");
  const s1 = createState(path);
  s1.upsert("7626", { status: "downloaded", title_cn: "测试" });
  const s2 = createState(path);
  assert.equal(s2.get("7626").status, "downloaded");
  assert.equal(s2.get("7626").title_cn, "测试");
  rmSync(dir, { recursive: true, force: true });
});

test("state: list filters by status", () => {
  const dir = makeTempDir();
  const path = join(dir, "state.json");
  const s = createState(path);
  s.upsert("a", { status: "published" });
  s.upsert("b", { status: "publish_failed" });
  s.upsert("c", { status: "published" });
  const failed = s.list({ status: /_failed$/ });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].modal_id, "b");
  rmSync(dir, { recursive: true, force: true });
});

test("state: corrupted JSON falls back to empty + backup", () => {
  const dir = makeTempDir();
  const path = join(dir, "state.json");
  const fs = require ?? null; // node:test runs ESM
  const { writeFileSync, existsSync, readdirSync } = await import("node:fs");
  writeFileSync(path, "{not valid json");
  const s = createState(path);
  assert.deepEqual(s.list(), []);
  const backups = readdirSync(dir).filter(f => f.startsWith("state.json.bak."));
  assert.ok(backups.length === 1, "expected 1 backup file");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 1.2: Run test to confirm fail**

```bash
node --test test/douyin/state.test.mjs
```

Expected: FAIL — `createState` not defined.

- [ ] **Step 1.3: Implement state.mjs**

`src/douyin/state.mjs`:
```js
/**
 * State store for Douyin pipeline.
 * Schema:
 *   { schema_version: 1, videos: { [modal_id]: { status, ...meta } } }
 *
 * Status values:
 *   discovered | downloaded | subs_extracted | translated | composed |
 *   published | subs_failed | translate_failed | compose_failed |
 *   publish_failed | skipped
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const SCHEMA_VERSION = 1;

function loadOrInit(path) {
  if (!existsSync(path)) return { schema_version: SCHEMA_VERSION, videos: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed.videos) parsed.videos = {};
    return parsed;
  } catch (err) {
    const backup = `${path}.bak.${Date.now()}`;
    try { renameSync(path, backup); } catch {}
    return { schema_version: SCHEMA_VERSION, videos: {} };
  }
}

export function createState(path) {
  const data = loadOrInit(path);

  const save = () => writeFileSync(path, JSON.stringify(data, null, 2));

  return {
    get(modal_id) {
      return data.videos[modal_id] || null;
    },
    upsert(modal_id, patch) {
      const existing = data.videos[modal_id] || {};
      data.videos[modal_id] = {
        ...existing,
        ...patch,
        modal_id,
        updated_at: new Date().toISOString(),
      };
      save();
    },
    list({ status } = {}) {
      const out = Object.values(data.videos);
      if (!status) return out;
      const re = status instanceof RegExp ? status : new RegExp(`^${status}$`);
      return out.filter(v => re.test(v.status));
    },
  };
}
```

- [ ] **Step 1.4: Run test to confirm pass**

```bash
node --test test/douyin/state.test.mjs
```

Expected: PASS (4 tests).

- [ ] **Step 1.5: Implement logger**

`src/douyin/utils/log.mjs`:
```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 50_000;

export function createLogger(logFilePath) {
  if (logFilePath) mkdirSync(dirname(logFilePath), { recursive: true });

  function write(level, scope, msg) {
    const ts = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    const line = `[${ts}] [${level}] [${scope}] ${msg}`;
    console.log(line);
    if (!logFilePath) return;
    try {
      const prev = existsSync(logFilePath) ? readFileSync(logFilePath, "utf8") : "";
      writeFileSync(logFilePath, (prev + line + "\n").slice(-MAX_LOG_BYTES));
    } catch {}
  }

  return {
    info: (scope, msg) => write("INFO", scope, msg),
    warn: (scope, msg) => write("WARN", scope, msg),
    error: (scope, msg) => write("ERROR", scope, msg),
  };
}
```

- [ ] **Step 1.6: Implement config**

`src/douyin/config.mjs`:
```js
import { join } from "node:path";

const BASE_DIR = "D:/tiktok/douyin";

export const DOUYIN_CONFIG = {
  // Discovery
  keywords: ["百岁觉醒"],
  creators: [],
  maxPerRun: 3,
  minViewCount: 100_000,

  // Chrome CDP
  chromePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  chromeUserDataDir: process.env.DOUYIN_CHROME_PROFILE || "C:/Users/nnanh01/AppData/Local/douyin-cdp-profile",
  chromeRemotePortBase: 9223,  // randomized in cdp.mjs to avoid conflicts

  // OCR
  ocr: {
    sampleIntervalMs: 300,
    minConfidence: 0.6,
    minCues: 5,
    cropBottomRatio: 0.4,
    cropOffsetRatio: 0.55,
  },

  // Subtitle style (libass force_style)
  subtitle: {
    fontName: "Be Vietnam Pro",
    fontFallback: "Arial Unicode MS",
    fontSize: 18,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    backColour: "&H80000000",
    outline: 2,
    shadow: 0,
    marginV: 80,
    alignment: 2,
  },

  // Compose
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 23,
    preset: "medium",
    cropTopPct: 0.08,
    cropBottomPct: 0.05,
  },

  // Publish channels
  channels: {
    tiktok:    { enabled: false, pfmTtId: null,  provider: "postforme" },
    fb_reels:  { enabled: false, pfmId: null,    provider: "postforme" },
    fb_page:   { enabled: false, pfmId: null,    provider: "postforme" },
    yt_shorts: { enabled: false, pfmYtId: null,  provider: "postforme" },
  },

  // Caption
  caption: {
    maxChars: 80,
    requiredHashtags: ["#trendingvideo", "#trend"],
  },

  // Paths
  baseDir: BASE_DIR,
  stateFile: join(BASE_DIR, "state.json"),
  logFile: join(BASE_DIR, "repurpose.log"),
  pythonScript: "scripts/paddle_ocr_batch.py",
};
```

- [ ] **Step 1.7: Commit**

```bash
git add src/douyin/config.mjs src/douyin/state.mjs src/douyin/utils/log.mjs test/douyin/state.test.mjs
git commit -m "feat(douyin): foundation — config, state store, logger

Adds:
- src/douyin/config.mjs: central config with keywords, channels, OCR params, subtitle style
- src/douyin/state.mjs: state.json read/write with status enum + backup-on-corrupt
- src/douyin/utils/log.mjs: shared logger (timestamp + console + file rotation to 50KB)
- test/douyin/state.test.mjs: 4 unit tests (empty / upsert+persist / filter / corrupt-recovery)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure utilities — parseViewCount, srt, jaccard

**Files:**
- Create: `src/douyin/utils/parseViewCount.mjs`
- Create: `src/douyin/utils/srt.mjs`
- Create: `src/douyin/utils/jaccard.mjs`
- Create: `test/douyin/parseViewCount.test.mjs`
- Create: `test/douyin/srt.test.mjs`
- Create: `test/douyin/jaccard.test.mjs`
- Modify: `package.json`

- [ ] **Step 2.1: Write parseViewCount tests**

`test/douyin/parseViewCount.test.mjs`:
```js
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
```

- [ ] **Step 2.2: Run, confirm fail**

```bash
node --test test/douyin/parseViewCount.test.mjs
```

Expected: FAIL.

- [ ] **Step 2.3: Implement parseViewCount.mjs**

`src/douyin/utils/parseViewCount.mjs`:
```js
/**
 * Parse Douyin view count strings into integers.
 * Handles: "856", "1.2k", "2.3w" (Chinese 万=10000), "3.5万", ""
 */
export function parseViewCount(input) {
  if (input == null) return 0;
  const s = String(input).trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([kw万]?)/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return 0;
  const unit = m[2];
  if (unit === "k") return Math.round(num * 1000);
  if (unit === "w" || unit === "万") return Math.round(num * 10000);
  return Math.round(num);
}
```

- [ ] **Step 2.4: Run, confirm pass**

```bash
node --test test/douyin/parseViewCount.test.mjs
```

Expected: PASS (5 tests).

- [ ] **Step 2.5: Write SRT tests**

`test/douyin/srt.test.mjs`:
```js
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
```

- [ ] **Step 2.6: Run, confirm fail**

```bash
node --test test/douyin/srt.test.mjs
```

Expected: FAIL.

- [ ] **Step 2.7: Implement srt.mjs**

`src/douyin/utils/srt.mjs`:
```js
/**
 * SRT parser/serializer.
 * Cue shape: { index: number, start_ms: number, end_ms: number, text: string }
 */

const TS_RE = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;

function tsToMs(ts) {
  const m = ts.trim().match(TS_RE);
  if (!m) throw new Error(`Invalid SRT timestamp: ${ts}`);
  const [, h, mn, s, ms] = m;
  return (+h) * 3600_000 + (+mn) * 60_000 + (+s) * 1000 + (+ms);
}

function msToTs(ms) {
  const h = Math.floor(ms / 3600_000);
  const mn = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(r).padStart(3,"0")}`;
}

export function parseSRT(src) {
  const cues = [];
  // Normalize line endings, split on blank lines
  const blocks = src.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(l => l.length > 0 || l === "");
    if (lines.length < 2) continue;
    // Optional first line: numeric index
    let i = 0;
    let index;
    if (/^\d+$/.test(lines[0])) {
      index = parseInt(lines[0], 10);
      i = 1;
    }
    const timeLine = lines[i];
    const m = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!m) continue;
    const start_ms = tsToMs(m[1]);
    const end_ms = tsToMs(m[2]);
    const text = lines.slice(i + 1).join("\n").trim();
    cues.push({ index: index ?? cues.length + 1, start_ms, end_ms, text });
  }
  return cues;
}

export function serializeSRT(cues) {
  return cues.map((c, i) =>
    `${c.index ?? i + 1}\n${msToTs(c.start_ms)} --> ${msToTs(c.end_ms)}\n${c.text}\n`
  ).join("\n") + "\n";
}

/**
 * Validate two cue arrays have matching timing (used to verify translation
 * output preserves source SRT structure).
 *
 * @param {Array} src
 * @param {Array} translated
 * @param {number} toleranceMs  max drift per cue
 */
export function validateSRTMatch(src, translated, toleranceMs = 50) {
  const errors = [];
  if (src.length !== translated.length) {
    errors.push(`cue count mismatch: src=${src.length} vs translated=${translated.length}`);
    return { ok: false, errors };
  }
  for (let i = 0; i < src.length; i++) {
    const a = src[i], b = translated[i];
    if (Math.abs(a.start_ms - b.start_ms) > toleranceMs ||
        Math.abs(a.end_ms - b.end_ms) > toleranceMs) {
      errors.push(`cue ${i + 1} timing drift exceeds ${toleranceMs}ms`);
    }
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 2.8: Run, confirm pass**

```bash
node --test test/douyin/srt.test.mjs
```

Expected: PASS (7 tests).

- [ ] **Step 2.9: Write Jaccard tests**

`test/douyin/jaccard.test.mjs`:
```js
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
```

- [ ] **Step 2.10: Run, confirm fail**

```bash
node --test test/douyin/jaccard.test.mjs
```

Expected: FAIL.

- [ ] **Step 2.11: Implement jaccard.mjs**

`src/douyin/utils/jaccard.mjs`:
```js
/**
 * Character-level Jaccard similarity for CJK OCR dedup.
 * Returns 0..1.
 */
export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const sa = new Set([...a]);
  const sb = new Set([...b]);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  const union = sa.size + sb.size - inter;
  return inter / union;
}

export function isSameText(a, b, threshold = 0.85) {
  return jaccardSimilarity(a, b) >= threshold;
}
```

- [ ] **Step 2.12: Run, confirm pass**

```bash
node --test test/douyin/jaccard.test.mjs
```

Expected: PASS (6 tests).

- [ ] **Step 2.13: Add test script to package.json**

Modify `package.json` scripts section — add:
```json
"test:douyin": "node --test test/douyin/"
```

- [ ] **Step 2.14: Run all douyin tests**

```bash
npm run test:douyin
```

Expected: All tests across 4 files pass.

- [ ] **Step 2.15: Commit**

```bash
git add src/douyin/utils/ test/douyin/parseViewCount.test.mjs test/douyin/srt.test.mjs test/douyin/jaccard.test.mjs package.json
git commit -m "feat(douyin): pure utils — parseViewCount, srt, jaccard

Adds:
- src/douyin/utils/parseViewCount.mjs: parse '2.3w' / '1.2k' / '856' / '3.5万' → int
- src/douyin/utils/srt.mjs: parseSRT / serializeSRT / validateSRTMatch
- src/douyin/utils/jaccard.mjs: char-level similarity for OCR dedup
- 18 unit tests using node:test (no new deps)
- package.json: test:douyin script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Chrome CDP helper

**Files:**
- Create: `src/douyin/utils/cdp.mjs`

- [ ] **Step 3.1: Implement cdp.mjs (variant of fb_repost withChrome)**

`src/douyin/utils/cdp.mjs`:
```js
/**
 * Chrome CDP helper for Douyin scraping.
 * Variant of fb_repost.mjs withChrome — but uses a PERSISTENT user-data-dir
 * (so Douyin login session survives across runs) instead of throwaway profile.
 *
 * Usage:
 *   await withDouyinChrome(url, async (cdp) => {
 *     await cdp("Runtime.evaluate", { expression: "..." });
 *   });
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { DOUYIN_CONFIG } from "../config.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pickPort() {
  return DOUYIN_CONFIG.chromeRemotePortBase + Math.floor(Math.random() * 100);
}

export async function withDouyinChrome(url, fn, { headless = true, waitMs = 6000 } = {}) {
  const port = pickPort();
  mkdirSync(DOUYIN_CONFIG.chromeUserDataDir, { recursive: true });

  const args = [
    headless ? "--headless=new" : "--start-maximized",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${DOUYIN_CONFIG.chromeUserDataDir}`,
    "--window-size=1280,1800",
    "--no-first-run",
    "--disable-blink-features=AutomationControlled",
    url,
  ];

  const proc = spawn(`"${DOUYIN_CONFIG.chromePath}"`, args, {
    shell: true, detached: true, stdio: "ignore",
  });
  proc.unref();

  await sleep(5000);

  try {
    const tabsRes = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(10000),
    });
    const tabs = await tabsRes.json();
    const tab = tabs.find(t => t.type === "page") || tabs[0];
    if (!tab?.webSocketDebuggerUrl) throw new Error("No CDP tab found");

    const { default: WS } = await import("ws");
    const ws = new WS(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });

    const cdp = (method, params = {}) => new Promise((res, rej) => {
      const id = Math.floor(Math.random() * 1e8);
      const handler = d => {
        const m = JSON.parse(d.toString());
        if (m.id === id) { ws.off("message", handler); res(m.result); }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { ws.off("message", handler); rej(new Error("CDP timeout: " + method)); }, 20000);
    });

    await cdp("Page.enable");
    await cdp("Network.enable");
    await sleep(waitMs);

    const result = await fn(cdp, ws);
    ws.close();
    return result;
  } finally {
    try { proc.kill(); } catch {}
    spawnSync(`taskkill /F /PID ${proc.pid} 2>nul`, { shell: true, timeout: 5000 });
  }
}
```

- [ ] **Step 3.2: Add `ws` dependency**

```bash
npm install ws
```

Expected: `ws` added to `package.json` dependencies.

- [ ] **Step 3.3: Commit**

```bash
git add src/douyin/utils/cdp.mjs package.json package-lock.json
git commit -m "feat(douyin): Chrome CDP helper with persistent user-data-dir

Adds src/douyin/utils/cdp.mjs — withDouyinChrome wrapper around Chrome CDP
that reuses a persistent profile (DOUYIN_CHROME_PROFILE env or hardcoded path)
so Douyin login session survives across runs. Variant of fb_repost.mjs
withChrome which uses throwaway profiles.

Adds 'ws' dependency for WebSocket CDP transport.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Discover module

**Files:**
- Create: `src/douyin/discover.mjs`

- [ ] **Step 4.1: Implement discover.mjs**

`src/douyin/discover.mjs`:
```js
/**
 * Discover Douyin candidate videos by keyword or creator URL.
 *
 * Returns array of:
 *   { modal_id, url, title, view_count, view_text }
 *
 * Errors:
 *   - Empty results → save screenshot for DOM-drift debugging, throw
 *   - Login required → throw with hint to run --login first
 */
import "../env.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withDouyinChrome } from "./utils/cdp.mjs";
import { parseViewCount } from "./utils/parseViewCount.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildSearchUrl(keyword) {
  return `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`;
}

export async function discover({ keyword, creator, maxResults = DOUYIN_CONFIG.maxPerRun }) {
  if (!keyword && !creator) throw new Error("discover requires keyword or creator");
  const url = creator || buildSearchUrl(keyword);
  log.info("discover", `→ ${url}`);

  const candidates = await withDouyinChrome(url, async (cdp) => {
    // Scroll to load more
    for (let i = 0; i < 8; i++) {
      await cdp("Runtime.evaluate", {
        expression: "window.scrollTo(0, document.body.scrollHeight)",
      });
      await sleep(1500);
    }

    const evalRes = await cdp("Runtime.evaluate", {
      returnByValue: true,
      expression: `
        (() => {
          const links = [...document.querySelectorAll('a[href*="/video/"]')];
          const seen = new Set();
          const out = [];
          for (const a of links) {
            const m = a.href.match(/\\/video\\/(\\d+)/);
            if (!m) continue;
            const id = m[1];
            if (seen.has(id)) continue;
            seen.add(id);
            // title: search-card text or aria-label
            const titleEl = a.querySelector('[data-e2e="search-card-title"], img[alt]');
            const title = titleEl?.innerText || titleEl?.getAttribute('alt') || '';
            // view text: any descendant with 万/w/k
            let viewText = '';
            const txt = a.innerText || '';
            const vm = txt.match(/([\\d.]+\\s*[万wk万])/i);
            if (vm) viewText = vm[1];
            out.push({ modal_id: id, url: a.href, title, view_text: viewText });
          }
          return out;
        })()
      `,
    });

    return evalRes?.result?.value || [];
  });

  if (!candidates.length) {
    // Save debug screenshot via separate non-headless call would be ideal;
    // here we just write a sentinel file + error
    mkdirSync(DOUYIN_CONFIG.baseDir, { recursive: true });
    const debugPath = join(DOUYIN_CONFIG.baseDir, `discover-empty-${Date.now()}.json`);
    writeFileSync(debugPath, JSON.stringify({ url, ts: new Date().toISOString() }, null, 2));
    throw new Error(`discover: no candidates for ${url}. DOM may have drifted. Debug: ${debugPath}`);
  }

  // Enrich + filter
  const enriched = candidates
    .map(c => ({ ...c, view_count: parseViewCount(c.view_text) }))
    .filter(c => c.view_count >= DOUYIN_CONFIG.minViewCount || c.view_count === 0); // keep zero if view parsing failed

  enriched.sort((a, b) => b.view_count - a.view_count);
  const top = enriched.slice(0, maxResults);
  log.info("discover", `found ${candidates.length} → kept ${top.length} (top by view_count)`);
  return top;
}

// CLI smoke test
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const keyword = process.argv[2] || DOUYIN_CONFIG.keywords[0];
  discover({ keyword, maxResults: 5 })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4.2: Manual smoke test (requires Chrome profile setup + Douyin login)**

```bash
# First-time setup (one-time, manual):
# 1. Launch Chrome non-headless once with the profile dir to login Douyin
"C:/Program Files/Google/Chrome/Application/chrome.exe" --user-data-dir="C:/Users/nnanh01/AppData/Local/douyin-cdp-profile" https://www.douyin.com
# 2. Login Douyin in that window, then close it
# 3. Then run smoke:
node src/douyin/discover.mjs "百岁觉醒"
```

Expected: JSON array of candidates printed (`length > 0`).

If FAIL with empty candidates: check `D:/tiktok/douyin/discover-empty-*.json`, may need to login again or Douyin updated DOM.

- [ ] **Step 4.3: Commit**

```bash
git add src/douyin/discover.mjs
git commit -m "feat(douyin): discover module — Chrome CDP search/creator scrape

Adds src/douyin/discover.mjs that:
- accepts { keyword } or { creator } URL
- spawns headless Chrome with logged-in Douyin profile
- scrolls 8× to load lazy cards
- scrapes a[href*='/video/'] anchors, extracts modal_id + title + view_text
- enriches with parseViewCount, filters minViewCount, sorts desc, takes top N
- on empty result: writes debug JSON + throws (DOM drift sentinel)

CLI smoke: node src/douyin/discover.mjs '百岁觉醒'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Download module

**Files:**
- Create: `src/douyin/download.mjs`

- [ ] **Step 5.1: Implement download.mjs**

`src/douyin/download.mjs`:
```js
/**
 * Download Douyin video via yt-dlp with browser-cookie session.
 *
 * Returns: { mp4_path, info_json_path, duration_sec, width, height, original_title }
 * Throws: download fail, file corrupt, ffprobe fail.
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

function ffprobeJson(mp4_path) {
  const r = spawnSync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    mp4_path,
  ], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export async function download(modal_id) {
  const outDir = join(DOUYIN_CONFIG.baseDir, modal_id);
  mkdirSync(outDir, { recursive: true });
  const mp4_path = join(outDir, "original.mp4");
  const info_json_path = join(outDir, "original.info.json");

  if (existsSync(mp4_path) && statSync(mp4_path).size > 100_000) {
    log.info("download", `skip — already exists for ${modal_id}`);
  } else {
    const videoUrl = `https://www.douyin.com/video/${modal_id}`;
    log.info("download", `yt-dlp ← ${videoUrl}`);
    const r = spawnSync("yt-dlp", [
      videoUrl,
      "--cookies-from-browser", "chrome",
      "-o", join(outDir, "original.%(ext)s"),
      "--write-info-json",
      "--merge-output-format", "mp4",
      "--no-warnings",
    ], { encoding: "utf8", timeout: 300_000, shell: true });
    if (r.status !== 0) throw new Error(`yt-dlp failed (code ${r.status}): ${r.stderr || r.stdout}`);
    if (!existsSync(mp4_path)) throw new Error(`yt-dlp ran but no mp4 produced at ${mp4_path}`);
    if (statSync(mp4_path).size < 100_000) throw new Error(`download appears corrupt (<100KB)`);
  }

  // Probe
  const probe = ffprobeJson(mp4_path);
  const vStream = probe.streams.find(s => s.codec_type === "video");
  if (!vStream) throw new Error("no video stream in download");
  const duration_sec = parseFloat(probe.format.duration);
  if (Number.isNaN(duration_sec) || duration_sec <= 0) {
    throw new Error(`invalid duration: ${probe.format.duration}`);
  }

  let original_title = modal_id;
  if (existsSync(info_json_path)) {
    try {
      const info = JSON.parse(readFileSync(info_json_path, "utf8"));
      original_title = info.title || info.description || modal_id;
    } catch {}
  }

  return {
    mp4_path,
    info_json_path,
    duration_sec,
    width: vStream.width,
    height: vStream.height,
    original_title,
  };
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const id = process.argv[2];
  if (!id) { console.error("usage: download.mjs <modal_id>"); process.exit(1); }
  download(id).then(r => console.log(JSON.stringify(r, null, 2)));
}
```

- [ ] **Step 5.2: Manual smoke test**

```bash
node src/douyin/download.mjs 7626368910716608741
```

Expected: prints `{ mp4_path, duration_sec, width, height, original_title }`. File at `D:/tiktok/douyin/7626368910716608741/original.mp4` exists, >100KB.

- [ ] **Step 5.3: Commit**

```bash
git add src/douyin/download.mjs
git commit -m "feat(douyin): download module — yt-dlp + ffprobe verify

Adds src/douyin/download.mjs:
- yt-dlp with --cookies-from-browser chrome (Douyin geo/account-gated)
- writes original.mp4 + original.info.json to D:/tiktok/douyin/{modal_id}/
- skips download if mp4 already exists >100KB (idempotent for --resume)
- ffprobe verifies duration + dimensions, throws on corrupt
- returns { mp4_path, duration_sec, width, height, original_title }

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: PaddleOCR Python script

**Files:**
- Create: `scripts/paddle_ocr_batch.py`

- [ ] **Step 6.1: Verify Python + paddleocr installable**

```bash
python --version
pip install paddleocr paddlepaddle --quiet
python -c "from paddleocr import PaddleOCR; print('ok')"
```

Expected: Python 3.8+, install completes, prints "ok".

If install fails on Windows: use `pip install paddlepaddle==2.5.2 paddleocr==2.7.0.3` (known-stable pin).

- [ ] **Step 6.2: Implement paddle_ocr_batch.py**

`scripts/paddle_ocr_batch.py`:
```python
"""
Stdin/stdout PaddleOCR batch runner.

Usage:
  echo "path/to/frame1.jpg\npath/to/frame2.jpg" | python scripts/paddle_ocr_batch.py

For each input line (frame path), prints ONE JSON line to stdout:
  {"frame_path": str, "text": str, "confidence": float, "boxes": int}

If a frame has no text, prints:
  {"frame_path": str, "text": "", "confidence": 0.0, "boxes": 0}
"""
import sys
import json

def main():
    # Lazy import to surface clearer error
    try:
        from paddleocr import PaddleOCR
    except ImportError as e:
        print(json.dumps({"error": f"paddleocr not installed: {e}"}), flush=True)
        sys.exit(2)

    # Initialize once for the batch (warmup ~3s)
    ocr = PaddleOCR(lang='ch', use_angle_cls=False, show_log=False)

    for raw in sys.stdin:
        path = raw.strip()
        if not path:
            continue
        try:
            result = ocr.ocr(path)
        except Exception as e:
            print(json.dumps({"frame_path": path, "text": "", "confidence": 0.0, "boxes": 0, "error": str(e)}), flush=True)
            continue

        # PaddleOCR may return [None] for empty frames or nested list
        texts = []
        confs = []
        if result and result[0]:
            for line in result[0]:
                if not line or len(line) < 2:
                    continue
                bbox, (txt, conf) = line[0], line[1]
                texts.append(txt)
                confs.append(float(conf))

        merged = " ".join(texts).strip()
        avg_conf = (sum(confs) / len(confs)) if confs else 0.0
        print(json.dumps({
            "frame_path": path,
            "text": merged,
            "confidence": round(avg_conf, 3),
            "boxes": len(texts),
        }, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
```

- [ ] **Step 6.3: Smoke test on a single image**

Create test image quickly with ffmpeg from a downloaded video (or any Chinese-text image):
```bash
mkdir -p test/fixtures/douyin
ffmpeg -ss 5 -i D:/tiktok/douyin/7626368910716608741/original.mp4 -vframes 1 test/fixtures/douyin/sample_frame.jpg
echo "test/fixtures/douyin/sample_frame.jpg" | python scripts/paddle_ocr_batch.py
```

Expected: ONE JSON line with `text` field (Chinese chars if hard-sub present, else empty).

- [ ] **Step 6.4: Commit**

```bash
git add scripts/paddle_ocr_batch.py
git commit -m "feat(douyin): PaddleOCR batch Python entry

Adds scripts/paddle_ocr_batch.py — stdin/stdout JSON streaming OCR for
Chinese hard-subs. Initializes PaddleOCR once per batch (~3s warmup),
emits one JSON line per frame with merged text + avg confidence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: OCR Node adapter

**Files:**
- Create: `src/douyin/ocr-paddle.mjs`

- [ ] **Step 7.1: Implement ocr-paddle.mjs**

`src/douyin/ocr-paddle.mjs`:
```js
/**
 * Node adapter for scripts/paddle_ocr_batch.py.
 * Spawns python subprocess, pipes frame paths to stdin, parses JSON lines from stdout.
 *
 * Returns: Array<{ frame_path, frame_idx, text, confidence, boxes }>
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

export async function runOCR(frame_paths) {
  if (!frame_paths.length) return [];
  log.info("ocr", `running PaddleOCR on ${frame_paths.length} frames`);

  return new Promise((resolve, reject) => {
    const proc = spawn("python", [DOUYIN_CONFIG.pythonScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const results = [];
    let stderrBuf = "";
    let buf = "";

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.error && !obj.frame_path) {
            log.error("ocr", `python error: ${obj.error}`);
            continue;
          }
          // Derive frame_idx from filename (e.g., "00042.jpg" → 42)
          const m = basename(obj.frame_path).match(/(\d+)/);
          obj.frame_idx = m ? parseInt(m[1], 10) : results.length;
          results.push(obj);
        } catch (e) {
          log.warn("ocr", `bad JSON line: ${line.slice(0, 200)}`);
        }
      }
    });

    proc.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`paddle_ocr_batch.py exit ${code}: ${stderrBuf.slice(-500)}`));
      }
      resolve(results);
    });

    // Pipe frame paths
    proc.stdin.write(frame_paths.join("\n") + "\n");
    proc.stdin.end();
  });
}
```

- [ ] **Step 7.2: Smoke test with sample frame**

```bash
node -e "import('./src/douyin/ocr-paddle.mjs').then(m => m.runOCR(['test/fixtures/douyin/sample_frame.jpg']).then(r => console.log(JSON.stringify(r, null, 2))))"
```

Expected: array with 1 element containing `text`, `confidence`, `frame_idx`.

- [ ] **Step 7.3: Commit**

```bash
git add src/douyin/ocr-paddle.mjs
git commit -m "feat(douyin): Node ↔ PaddleOCR subprocess adapter

Adds src/douyin/ocr-paddle.mjs:
- spawns python scripts/paddle_ocr_batch.py
- pipes frame paths to stdin, parses JSON lines from stdout
- derives frame_idx from filename (e.g., '00042.jpg' → 42)
- handles partial lines + python stderr buffering
- throws on non-zero exit with last 500 chars of stderr

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: extract-subs — frame sampling + dedup + SRT building

**Files:**
- Create: `src/douyin/extract-subs.mjs`
- Create: `test/douyin/extract-subs-dedup.test.mjs`

- [ ] **Step 8.1: Write dedup logic test**

`test/douyin/extract-subs-dedup.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupOCRResults } from "../../src/douyin/extract-subs.mjs";

test("dedupOCRResults: merges consecutive identical frames", () => {
  const ocr = [
    { frame_idx: 10, text: "他活了一百岁", confidence: 0.94 },
    { frame_idx: 11, text: "他活了一百岁", confidence: 0.96 },
    { frame_idx: 12, text: "他活了一百岁。", confidence: 0.95 }, // near-identical
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
    // frames 3-5 had no text (filtered out earlier or low conf)
    { frame_idx: 10, text: "second", confidence: 0.9 },
  ];
  const cues = dedupOCRResults(ocr, { intervalMs: 300, jaccardThreshold: 0.85, minConfidence: 0.6 });
  assert.equal(cues.length, 2);
});
```

- [ ] **Step 8.2: Run, confirm fail**

```bash
node --test test/douyin/extract-subs-dedup.test.mjs
```

Expected: FAIL — `dedupOCRResults` not exported.

- [ ] **Step 8.3: Implement extract-subs.mjs**

`src/douyin/extract-subs.mjs`:
```js
/**
 * Extract Chinese subtitles from Douyin video via:
 *   1. ffmpeg sample frames (bottom-cropped) at sampleIntervalMs
 *   2. PaddleOCR via ocr-paddle.mjs
 *   3. Dedup consecutive identical frames into SRT cues
 *   4. If cue count or avg confidence below threshold → fall back to Gemini ASR
 *
 * Returns: { srt_path, source: 'ocr'|'asr', cue_count, avg_confidence }
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOCR } from "./ocr-paddle.mjs";
import { isSameText } from "./utils/jaccard.mjs";
import { serializeSRT } from "./utils/srt.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

/**
 * Pure function (exported for testing).
 * Merges consecutive OCR results with similar text into SRT cues.
 */
export function dedupOCRResults(ocrResults, { intervalMs, jaccardThreshold, minConfidence }) {
  const cues = [];
  let current = null;

  // Sort by frame_idx ascending (defensive)
  const sorted = [...ocrResults].sort((a, b) => a.frame_idx - b.frame_idx);

  for (const r of sorted) {
    const text = (r.text || "").trim();
    if (text.length < 2) { current = null; continue; }
    if (r.confidence < minConfidence) { current = null; continue; }

    if (current && isSameText(current.text, text, jaccardThreshold)) {
      // extend current
      current.end_frame = r.frame_idx;
      current.confidences.push(r.confidence);
    } else {
      // flush previous
      if (current) cues.push(current);
      current = {
        text,
        start_frame: r.frame_idx,
        end_frame: r.frame_idx,
        confidences: [r.confidence],
      };
    }
  }
  if (current) cues.push(current);

  // Convert frame indices → ms timestamps
  return cues.map((c, i) => ({
    index: i + 1,
    start_ms: c.start_frame * intervalMs,
    end_ms: (c.end_frame + 1) * intervalMs,
    text: c.text,
    confidence: c.confidences.reduce((a, b) => a + b, 0) / c.confidences.length,
  }));
}

async function sampleFrames(mp4_path, frames_dir) {
  mkdirSync(frames_dir, { recursive: true });
  const { ocr } = DOUYIN_CONFIG;
  const fps = 1 / (ocr.sampleIntervalMs / 1000);
  const cropFilter =
    `crop=iw:ih*${ocr.cropBottomRatio}:0:ih*${ocr.cropOffsetRatio}`;
  const r = spawnSync("ffmpeg", [
    "-y",
    "-i", mp4_path,
    "-vf", `fps=${fps},${cropFilter}`,
    "-q:v", "3",
    join(frames_dir, "%05d.jpg"),
  ], { encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`ffmpeg sample frames failed: ${r.stderr}`);
  return readdirSync(frames_dir)
    .filter(f => f.endsWith(".jpg"))
    .sort()
    .map(f => join(frames_dir, f));
}

export async function extractSubs(mp4_path, outDir) {
  const srt_path = join(outDir, "subs_cn.srt");
  const meta_path = join(outDir, "subs_meta.json");
  const frames_dir = join(outDir, "frames");

  // 1) Sample frames
  const frames = await sampleFrames(mp4_path, frames_dir);
  log.info("extract-subs", `sampled ${frames.length} frames`);

  // 2) OCR
  const ocrResults = await runOCR(frames);

  // 3) Dedup
  const cues = dedupOCRResults(ocrResults, {
    intervalMs: DOUYIN_CONFIG.ocr.sampleIntervalMs,
    jaccardThreshold: 0.85,
    minConfidence: DOUYIN_CONFIG.ocr.minConfidence,
  });
  const avgConf = cues.length
    ? cues.reduce((a, c) => a + c.confidence, 0) / cues.length
    : 0;

  log.info("extract-subs", `OCR → ${cues.length} cues, avg_conf=${avgConf.toFixed(2)}`);

  let source = "ocr";
  let finalCues = cues;

  // 4) Fallback ASR if below threshold
  if (cues.length < DOUYIN_CONFIG.ocr.minCues || avgConf < DOUYIN_CONFIG.ocr.minConfidence) {
    log.warn("extract-subs", `below threshold → falling back to Gemini ASR`);
    const { asrFallback } = await import("./fallback-asr.mjs");
    const asrCues = await asrFallback(mp4_path);
    finalCues = asrCues;
    source = "asr";
  }

  writeFileSync(srt_path, serializeSRT(finalCues));
  writeFileSync(meta_path, JSON.stringify({
    source,
    cue_count: finalCues.length,
    avg_confidence: avgConf,
    generated_at: new Date().toISOString(),
  }, null, 2));

  // Cleanup frames
  try { rmSync(frames_dir, { recursive: true, force: true }); } catch {}

  return { srt_path, source, cue_count: finalCues.length, avg_confidence: avgConf };
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const id = process.argv[2];
  if (!id) { console.error("usage: extract-subs.mjs <modal_id>"); process.exit(1); }
  const dir = join(DOUYIN_CONFIG.baseDir, id);
  const mp4 = join(dir, "original.mp4");
  if (!existsSync(mp4)) { console.error("no original.mp4 — run download.mjs first"); process.exit(1); }
  extractSubs(mp4, dir).then(r => console.log(JSON.stringify(r, null, 2)));
}
```

- [ ] **Step 8.4: Run dedup tests**

```bash
node --test test/douyin/extract-subs-dedup.test.mjs
```

Expected: PASS (4 tests).

- [ ] **Step 8.5: Manual smoke test (requires Task 5 download done)**

```bash
node src/douyin/extract-subs.mjs 7626368910716608741
```

Expected: writes `subs_cn.srt` + `subs_meta.json`. Prints `{ srt_path, source, cue_count, avg_confidence }`.

- [ ] **Step 8.6: Commit**

```bash
git add src/douyin/extract-subs.mjs test/douyin/extract-subs-dedup.test.mjs
git commit -m "feat(douyin): extract-subs — frame sampling + OCR dedup → SRT

Adds src/douyin/extract-subs.mjs:
- sampleFrames(): ffmpeg fps=1/0.3 + crop bottom 40% → JPG frames
- dedupOCRResults() [pure, tested]: merges consecutive frames with Jaccard
  similarity ≥0.85, drops <minConfidence + <2-char text
- Falls back to fallback-asr.mjs when cues<minCues or conf<minConfidence
- Writes subs_cn.srt + subs_meta.json {source, cue_count, avg_confidence}
- Cleans up frames/ dir after
- 4 unit tests for dedup logic

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Fallback ASR (Gemini multimodal)

**Files:**
- Create: `src/douyin/fallback-asr.mjs`

- [ ] **Step 9.1: Verify Gemini SDK is available**

```bash
node -e "import('@google/genai').then(g => console.log(typeof g.GoogleGenAI))"
```

Expected: prints `function`.

- [ ] **Step 9.2: Implement fallback-asr.mjs**

`src/douyin/fallback-asr.mjs`:
```js
/**
 * Gemini multimodal ASR fallback for Chinese videos.
 * Uploads video file → Gemini 2.5 Flash → SRT-formatted Chinese transcription.
 *
 * Returns: Array of cues (index, start_ms, end_ms, text, confidence=null).
 * Throws after 3 retries on 429/5xx, or if parsed cues === 0.
 */
import "../env.js";
import { GoogleGenAI } from "@google/genai";
import { readFileSync } from "node:fs";
import { parseSRT } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ASR_PROMPT = `Transcribe this Chinese video into SRT subtitle format with precise timestamps.

Requirements:
- Use standard SRT format: cue number, timestamp range (HH:MM:SS,mmm --> HH:MM:SS,mmm), text, blank line.
- Each cue must be under 12 Chinese characters for natural reading rhythm. Break longer sentences across multiple cues.
- Timestamps must align with when each segment is spoken (do not bunch all at start).
- Output ONLY the raw SRT content. No markdown code fences. No commentary. No explanation.
- If the video has no speech, output an empty response.`;

function stripCodeFence(s) {
  return s.replace(/^```(?:srt)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim();
}

async function callGemini(mp4_path) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenAI({ apiKey });

  // Upload file
  const uploaded = await ai.files.upload({
    file: mp4_path,
    config: { mimeType: "video/mp4" },
  });

  // Poll until ACTIVE
  let info = uploaded;
  for (let i = 0; i < 30; i++) {
    info = await ai.files.get({ name: uploaded.name });
    if (info.state === "ACTIVE") break;
    if (info.state === "FAILED") throw new Error(`Gemini upload failed: ${info.error?.message}`);
    await sleep(2000);
  }
  if (info.state !== "ACTIVE") throw new Error("Gemini upload timeout");

  // Generate
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      { fileData: { fileUri: info.uri, mimeType: "video/mp4" } },
      { text: ASR_PROMPT },
    ],
  });
  const text = res.text || res.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // Cleanup uploaded file (best effort)
  try { await ai.files.delete({ name: info.name }); } catch {}

  return stripCodeFence(text);
}

export async function asrFallback(mp4_path) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info("fallback-asr", `Gemini attempt ${attempt}/3`);
      const srtText = await callGemini(mp4_path);
      const cues = parseSRT(srtText);
      if (!cues.length) throw new Error("Gemini returned 0 cues");
      log.info("fallback-asr", `ASR → ${cues.length} cues`);
      return cues;
    } catch (e) {
      lastErr = e;
      log.warn("fallback-asr", `attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await sleep(2000 * Math.pow(2, attempt - 1));
    }
  }
  throw new Error(`asrFallback failed after 3 attempts: ${lastErr.message}`);
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const mp4 = process.argv[2];
  if (!mp4) { console.error("usage: fallback-asr.mjs <mp4_path>"); process.exit(1); }
  asrFallback(mp4).then(r => console.log(JSON.stringify(r.slice(0, 5), null, 2)));
}
```

- [ ] **Step 9.3: Smoke test (only if needed — will consume Gemini quota)**

```bash
node src/douyin/fallback-asr.mjs D:/tiktok/douyin/7626368910716608741/original.mp4
```

Expected: prints first 5 cues. Skip if OCR already worked on the test video.

- [ ] **Step 9.4: Commit**

```bash
git add src/douyin/fallback-asr.mjs
git commit -m "feat(douyin): Gemini multimodal ASR fallback

Adds src/douyin/fallback-asr.mjs:
- Uploads mp4 via Gemini Files API, polls until ACTIVE
- Single generateContent call to gemini-2.5-flash with strict SRT prompt
  (≤12 chars per cue, no code fences, no commentary)
- Parses output with parseSRT, validates cues > 0
- Retries 3× with exponential backoff (1s, 2s, 4s)
- Cleans up uploaded file after
- Used by extract-subs.mjs when OCR confidence/cue count below threshold

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Translate (Claude Haiku CN→VN)

**Files:**
- Create: `src/douyin/translate.mjs`

- [ ] **Step 10.1: Implement translate.mjs**

`src/douyin/translate.mjs`:
```js
/**
 * Translate Chinese SRT cues to Vietnamese using Claude Haiku.
 * Single batched call (preserves narrative consistency across cues).
 *
 * Returns: { vn_srt_path, cue_count, char_ratio }
 * Throws: API failure after 2 retries, or output SRT does not match input timing.
 */
import "../env.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { parseSRT, serializeSRT, validateSRTMatch } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SYSTEM_PROMPT = `You are translating Douyin storytelling video subtitles from Chinese to Vietnamese.

Context: spiritual/philosophical/cổ trang narrative (e.g., immortals, awakening, meditation, ancient stories).

Style requirements:
- Natural Vietnamese kể chuyện, giữ nhịp narrative.
- When relevant, use traditional vocabulary: "thiên thần", "giác ngộ", "tu sĩ", "căn nguyên", "linh hồn", "kiếp", "đạo".
- Use "ngài / vị ấy / hắn" depending on tone (avoid bland "anh ta" / "ông ta" for spiritual contexts).
- Each Vietnamese line must NOT exceed 1.5× the Chinese line character count (for subtitle timing fit).

Output requirements:
- Same cue numbering as input.
- Same timestamps EXACTLY as input (do not adjust timing).
- Vietnamese text only — no Chinese, no commentary, no markdown.
- Valid SRT format with blank line between cues.`;

function buildPrompt(cnSrtText, context) {
  return `Translate the following Chinese SRT to Vietnamese.

${context ? `Additional context: ${context}\n\n` : ""}Input SRT:
${cnSrtText}

Output the complete translated SRT now:`;
}

async function callClaude(cnSrtText, context, stricter = false) {
  const sys = stricter
    ? SYSTEM_PROMPT + "\n\nCRITICAL: previous attempt had invalid output. You MUST preserve cue numbering and timestamps EXACTLY as input. Output VALID SRT format with blank line between cues."
    : SYSTEM_PROMPT;
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: sys,
    messages: [{ role: "user", content: buildPrompt(cnSrtText, context) }],
  });
  return res.content?.[0]?.text || "";
}

export async function translateSRT(cn_srt_path, vn_srt_path, { context = "" } = {}) {
  const cnText = readFileSync(cn_srt_path, "utf8");
  const cnCues = parseSRT(cnText);
  if (!cnCues.length) throw new Error("translate: no cues in source SRT");

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log.info("translate", `Claude attempt ${attempt}/2 (${cnCues.length} cues)`);
      const vnText = await callClaude(cnText, context, attempt > 1);
      const vnCues = parseSRT(vnText);
      const { ok, errors } = validateSRTMatch(cnCues, vnCues, 50);
      if (!ok) {
        throw new Error(`SRT mismatch: ${errors.join("; ")}`);
      }
      // char_ratio
      const ratios = vnCues.map((v, i) => v.text.length / Math.max(1, cnCues[i].text.length));
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      if (avg > 1.8) {
        log.warn("translate", `VN/CN char_ratio=${avg.toFixed(2)} > 1.8 — sub may overflow`);
      }
      writeFileSync(vn_srt_path, serializeSRT(vnCues));
      return { vn_srt_path, cue_count: vnCues.length, char_ratio: avg };
    } catch (e) {
      lastErr = e;
      log.warn("translate", `attempt ${attempt} failed: ${e.message}`);
      if (attempt < 2) await sleep(2000);
    }
  }
  throw new Error(`translate failed after 2 attempts: ${lastErr.message}`);
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const cn = process.argv[2];
  const vn = process.argv[3] || cn.replace("_cn.srt", "_vn.srt");
  if (!cn) { console.error("usage: translate.mjs <cn_srt> [vn_srt]"); process.exit(1); }
  translateSRT(cn, vn).then(r => console.log(JSON.stringify(r, null, 2)));
}
```

- [ ] **Step 10.2: Smoke test (uses Claude quota)**

```bash
node src/douyin/translate.mjs D:/tiktok/douyin/7626368910716608741/subs_cn.srt
```

Expected: `subs_vn.srt` created, printed `{ vn_srt_path, cue_count, char_ratio }`. Open VN SRT to spot-check.

- [ ] **Step 10.3: Commit**

```bash
git add src/douyin/translate.mjs
git commit -m "feat(douyin): translate — Claude Haiku CN→VN batch

Adds src/douyin/translate.mjs:
- Single Claude Haiku call with full SRT (preserves narrative consistency)
- System prompt tuned for spiritual/cổ trang vocabulary (thiên thần, giác ngộ, tu sĩ)
- Constraint: VN line ≤1.5× CN char count (sub timing fit)
- Validates output SRT timing matches source via validateSRTMatch (50ms tolerance)
- Retries 1× with stricter prompt if validation fails
- Logs warning if avg char_ratio >1.8 (sub may overflow frame)
- Returns { vn_srt_path, cue_count, char_ratio }

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Compose (FFmpeg burn-in)

**Files:**
- Create: `src/douyin/compose.mjs`

- [ ] **Step 11.1: Implement compose.mjs**

`src/douyin/compose.mjs`:
```js
/**
 * Compose final video: crop Douyin watermarks → scale 1080×1920 → libass burn-in VN subtitle.
 * Keeps original Chinese audio (-c:a copy).
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

function buildForceStyle() {
  const s = DOUYIN_CONFIG.subtitle;
  // libass force_style is comma-separated key=value
  return [
    `Fontname=${s.fontName}`,
    `FontSize=${s.fontSize}`,
    `PrimaryColour=${s.primaryColour}`,
    `OutlineColour=${s.outlineColour}`,
    `BackColour=${s.backColour}`,
    `Outline=${s.outline}`,
    `Shadow=${s.shadow}`,
    `MarginV=${s.marginV}`,
    `Alignment=${s.alignment}`,
  ].join(",");
}

function escapeSubtitlePath(p) {
  // libass subtitle filter on Windows requires forward slashes + drive-letter escape
  // e.g. 'D:/path/x.srt' → 'D\\:/path/x.srt'
  return resolve(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\\\:");
}

export async function compose({ mp4_path, vn_srt_path, output_path }) {
  if (!existsSync(mp4_path)) throw new Error(`mp4 not found: ${mp4_path}`);
  if (!existsSync(vn_srt_path)) throw new Error(`SRT not found: ${vn_srt_path}`);

  const { output, subtitle } = DOUYIN_CONFIG;
  const cropKeepRatio = 1 - output.cropTopPct - output.cropBottomPct;

  const vf = [
    // 1. crop watermark zones
    `crop=iw:ih*${cropKeepRatio}:0:ih*${output.cropTopPct}`,
    // 2. scale-and-crop to exactly 1080×1920 (preserve aspect, then crop overflow)
    `scale=${output.width}:${output.height}:force_original_aspect_ratio=increase`,
    `crop=${output.width}:${output.height}`,
    // 3. burn-in subtitle
    `subtitles='${escapeSubtitlePath(vn_srt_path)}':force_style='${buildForceStyle()}'`,
  ].join(",");

  log.info("compose", `ffmpeg → ${output_path}`);
  const r = spawnSync("ffmpeg", [
    "-y",
    "-i", mp4_path,
    "-vf", vf,
    "-c:v", "libx264",
    "-crf", String(output.crf),
    "-preset", output.preset,
    "-r", String(output.fps),
    "-c:a", "copy",
    "-pix_fmt", "yuv420p",
    output_path,
  ], { encoding: "utf8", timeout: 600_000 });
  if (r.status !== 0) {
    throw new Error(`ffmpeg compose failed: ${r.stderr.slice(-1500)}`);
  }
  if (!existsSync(output_path) || statSync(output_path).size < 100_000) {
    throw new Error(`compose produced file <100KB: ${output_path}`);
  }
  return output_path;
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const id = process.argv[2];
  if (!id) { console.error("usage: compose.mjs <modal_id>"); process.exit(1); }
  const dir = join(DOUYIN_CONFIG.baseDir, id);
  compose({
    mp4_path: join(dir, "original.mp4"),
    vn_srt_path: join(dir, "subs_vn.srt"),
    output_path: join(dir, "composed.mp4"),
  }).then(p => console.log(p));
}
```

- [ ] **Step 11.2: Verify Be Vietnam Pro font installed**

```bash
# Windows: check registry or via dir
dir "C:\Windows\Fonts\BeVietnamPro*"
```

If missing: download from https://fonts.google.com/specimen/Be+Vietnam+Pro and install (right-click → Install). Verify after install.

- [ ] **Step 11.3: Smoke test**

```bash
node src/douyin/compose.mjs 7626368910716608741
```

Expected: writes `composed.mp4`. ffprobe:
```bash
ffprobe D:/tiktok/douyin/7626368910716608741/composed.mp4 2>&1 | head -30
```
Should show: 1080×1920, audio stream preserved, duration matches source.

Visual check: open `composed.mp4` in a player. VN subtitles burn-in at bottom, no Douyin watermark visible.

- [ ] **Step 11.4: Commit**

```bash
git add src/douyin/compose.mjs
git commit -m "feat(douyin): compose — FFmpeg crop + libass burn-in

Adds src/douyin/compose.mjs:
- crop=iw:ih*0.87:0:ih*0.08 (drop top 8% + bottom 5% — Douyin watermark zones)
- scale + crop to exact 1080×1920 9:16
- subtitles filter with libass force_style (Be Vietnam Pro, 18pt, white+black outline)
- -c:a copy (preserves original Chinese audio, no re-encode)
- yuv420p pixel format (TikTok/FB/YT compatibility)
- Verifies output >100KB after encode

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Publish (multi-channel + caption gen)

**Files:**
- Create: `src/douyin/publish.mjs`

- [ ] **Step 12.1: Implement publish.mjs**

`src/douyin/publish.mjs`:
```js
/**
 * Publish composed mp4 to enabled channels via social-poster.js.
 *
 * Generates VN caption via Claude Haiku (input: original CN title + first 3 VN cues).
 * Loops over DOUYIN_CONFIG.channels, skips disabled or null-id channels.
 * Per-channel try/catch: one failure does not stop others.
 *
 * Returns: Array<{ channel, status, post_id?, error? }>
 */
import "../env.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { createPoster } from "../social-poster.js";
import { parseSRT } from "./utils/srt.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateCaption({ original_title_cn, vn_cues_sample }) {
  const sampleText = vn_cues_sample.slice(0, 3).map(c => c.text).join(" / ");
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    system: `Bạn viết caption ngắn cho video TikTok/Reels/YouTube Shorts tiếng Việt.
Yêu cầu:
- Tối đa ${DOUYIN_CONFIG.caption.maxChars} ký tự (chưa tính hashtag — sẽ thêm sau)
- Gây tò mò, mời gọi xem
- KHÔNG nhắc Douyin / Trung Quốc / nguồn gốc
- KHÔNG thêm hashtag (sẽ append tự động)
- Output 1 dòng, không quote, không markdown`,
    messages: [{
      role: "user",
      content: `Tiêu đề gốc (tiếng Trung — chỉ để tham khảo): ${original_title_cn}\nNội dung 3 câu đầu (tiếng Việt): ${sampleText}\n\nViết caption:`,
    }],
  });
  const raw = (res.content?.[0]?.text || "").trim();
  // Strip surrounding quotes if Claude returns them
  return raw.replace(/^["']|["']$/g, "").slice(0, DOUYIN_CONFIG.caption.maxChars);
}

function appendHashtags(caption) {
  const tags = DOUYIN_CONFIG.caption.requiredHashtags.join(" ");
  return `${caption}\n${tags}`;
}

function nextSlotISO(offsetMin = 5) {
  return DateTime.now().setZone("Asia/Ho_Chi_Minh").plus({ minutes: offsetMin }).toISO();
}

async function publishToChannel(name, cfg, { composed_mp4, caption }) {
  if (!cfg.enabled) return { channel: name, status: "skipped", reason: "disabled" };
  // Determine which ID field is required
  const idField = name === "tiktok" ? "pfmTtId"
                : name === "yt_shorts" ? "pfmYtId"
                : "pfmId";
  if (!cfg[idField]) {
    return { channel: name, status: "skipped", reason: `${idField} not configured` };
  }

  // Build poster config compatible with social-poster.js
  const posterConfig = {
    provider: cfg.provider || "postforme",
    [idField]: cfg[idField],
  };
  const poster = createPoster(posterConfig);

  try {
    const mediaRef = await poster.upload(composed_mp4);
    const scheduledAt = nextSlotISO(5);

    let result;
    if (name === "tiktok") {
      result = await poster.scheduleTikTok({ mediaRef, caption, scheduledAt });
    } else if (name === "yt_shorts") {
      result = await poster.scheduleYouTube?.({ mediaRef, caption, scheduledAt })
            || { postId: null, note: "YouTube method not available on poster" };
    } else {
      // fb_reels / fb_page
      result = await poster.scheduleFacebook({ mediaRef, caption, scheduledAt });
    }
    return { channel: name, status: "ok", post_id: result.postId, scheduledAt };
  } catch (e) {
    return { channel: name, status: "fail", error: e.message };
  }
}

export async function publish({ composed_mp4, modal_id, original_title_cn, vn_srt_path, dryRun = false }) {
  const vnCues = parseSRT(readFileSync(vn_srt_path, "utf8"));
  const caption = await generateCaption({ original_title_cn, vn_cues_sample: vnCues });
  const fullCaption = appendHashtags(caption);

  log.info("publish", `caption: ${fullCaption.replace(/\n/g, " | ")}`);

  if (dryRun) {
    log.info("publish", "dry-run — not posting");
    return [{ channel: "ALL", status: "dry-run", caption: fullCaption }];
  }

  const results = [];
  for (const [name, cfg] of Object.entries(DOUYIN_CONFIG.channels)) {
    const r = await publishToChannel(name, cfg, { composed_mp4, caption: fullCaption });
    log.info("publish", `${name}: ${r.status}${r.post_id ? ` post_id=${r.post_id}` : ""}${r.error ? ` err=${r.error}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
    results.push(r);
  }
  return results;
}
```

- [ ] **Step 12.2: Smoke test (dry-run)**

```bash
node -e "import('./src/douyin/publish.mjs').then(m => m.publish({
  composed_mp4: 'D:/tiktok/douyin/7626368910716608741/composed.mp4',
  modal_id: '7626368910716608741',
  original_title_cn: '百岁觉醒天神根源 第一章',
  vn_srt_path: 'D:/tiktok/douyin/7626368910716608741/subs_vn.srt',
  dryRun: true,
}).then(r => console.log(JSON.stringify(r, null, 2))))"
```

Expected: prints `[{ channel: "ALL", status: "dry-run", caption: "...\n#trendingvideo #trend" }]`. Caption is in VN, max 80 chars + hashtags, no Chinese/Douyin mention.

- [ ] **Step 12.3: Commit**

```bash
git add src/douyin/publish.mjs
git commit -m "feat(douyin): publish — multi-channel via social-poster.js + caption gen

Adds src/douyin/publish.mjs:
- generateCaption(): Claude Haiku, max 80 chars VN, no Douyin/CN mention
- appendHashtags(): #trendingvideo #trend (per user memory)
- publishToChannel(): per-channel try/catch with social-poster.createPoster()
  routing to pfmId (FB) / pfmTtId (TikTok) / pfmYtId (YouTube)
- Skips channels with enabled=false or null ID
- Schedules 5 min ahead in Asia/Ho_Chi_Minh
- dryRun mode returns caption preview without posting

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Orchestrator CLI

**Files:**
- Create: `src/douyin/repurpose.mjs`

- [ ] **Step 13.1: Implement repurpose.mjs**

`src/douyin/repurpose.mjs`:
```js
#!/usr/bin/env node
/**
 * Douyin Repurpose Pipeline Orchestrator
 *
 * Usage:
 *   node src/douyin/repurpose.mjs --keyword "百岁觉醒" --max 2
 *   node src/douyin/repurpose.mjs --creator "https://www.douyin.com/user/MS4..."
 *   node src/douyin/repurpose.mjs --url "https://www.douyin.com/video/7626..."
 *   node src/douyin/repurpose.mjs --dry-run                       # discover only
 *   node src/douyin/repurpose.mjs --resume <modal_id>             # rerun from artifacts
 *   node src/douyin/repurpose.mjs --force-step translate --resume <modal_id>
 *   node src/douyin/repurpose.mjs --retry-failed
 *   node src/douyin/repurpose.mjs --skip-publish
 *   node src/douyin/repurpose.mjs --dry-run-publish               # full pipeline, log caption only
 */
import "../env.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createState } from "./state.mjs";
import { createLogger } from "./utils/log.mjs";
import { discover } from "./discover.mjs";
import { download } from "./download.mjs";
import { extractSubs } from "./extract-subs.mjs";
import { translateSRT } from "./translate.mjs";
import { compose } from "./compose.mjs";
import { publish } from "./publish.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const state = createState(DOUYIN_CONFIG.stateFile);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    keyword: null,
    creator: null,
    url: null,
    max: DOUYIN_CONFIG.maxPerRun,
    dryRun: false,
    dryRunPublish: false,
    skipPublish: false,
    resume: null,
    forceStep: null,
    retryFailed: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--keyword") out.keyword = args[++i];
    else if (a === "--creator") out.creator = args[++i];
    else if (a === "--url") out.url = args[++i];
    else if (a === "--max") out.max = parseInt(args[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--dry-run-publish") out.dryRunPublish = true;
    else if (a === "--skip-publish") out.skipPublish = true;
    else if (a === "--resume") out.resume = args[++i];
    else if (a === "--force-step") out.forceStep = args[++i];
    else if (a === "--retry-failed") out.retryFailed = true;
    else if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
    else console.warn(`unknown arg: ${a}`);
  }
  return out;
}

const HELP = `Douyin Repurpose Pipeline

Source (one of):
  --keyword <text>         scan Douyin search results
  --creator <url>          scan creator profile
  --url <video_url>        single video (extract modal_id)
  --resume <modal_id>      rerun pipeline for existing modal_id
  --retry-failed           rerun all videos in state.json with *_failed status

Options:
  --max <n>                max videos per run (default ${DOUYIN_CONFIG.maxPerRun})
  --dry-run                discover only, no download
  --dry-run-publish        full pipeline, log caption, no post
  --skip-publish           full pipeline, no publish call
  --force-step <name>      rerun specific step despite existing artifact
                           (download|extract-subs|translate|compose|publish)
`;

function extractModalIdFromUrl(url) {
  const m = url.match(/[/?&]modal_id=(\d+)/) || url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function artifactPaths(modal_id) {
  const dir = join(DOUYIN_CONFIG.baseDir, modal_id);
  return {
    dir,
    original_mp4: join(dir, "original.mp4"),
    info_json:    join(dir, "original.info.json"),
    subs_cn:      join(dir, "subs_cn.srt"),
    subs_vn:      join(dir, "subs_vn.srt"),
    composed:     join(dir, "composed.mp4"),
  };
}

async function runPipelineFor(modal_id, { skipPublish, dryRunPublish, forceStep }, meta = {}) {
  const a = artifactPaths(modal_id);
  log.info("orchestrator", `pipeline ▶ ${modal_id} (${meta.title_cn || ""})`);

  try {
    // STEP: download
    const needDownload = forceStep === "download" ||
      !existsSync(a.original_mp4) ||
      statSync(a.original_mp4).size < 100_000;
    if (needDownload) {
      const dl = await download(modal_id);
      state.upsert(modal_id, {
        status: "downloaded",
        title_cn: meta.title_cn || dl.original_title,
        duration_sec: dl.duration_sec,
      });
    }

    // STEP: extract-subs
    if (forceStep === "extract-subs" || !existsSync(a.subs_cn)) {
      const r = await extractSubs(a.original_mp4, a.dir);
      state.upsert(modal_id, {
        status: "subs_extracted",
        subs_source: r.source,
        cue_count: r.cue_count,
        avg_confidence: r.avg_confidence,
      });
    }

    // STEP: translate
    if (forceStep === "translate" || !existsSync(a.subs_vn)) {
      const r = await translateSRT(a.subs_cn, a.subs_vn);
      state.upsert(modal_id, {
        status: "translated",
        char_ratio: r.char_ratio,
      });
    }

    // STEP: compose
    if (forceStep === "compose" || !existsSync(a.composed)) {
      await compose({ mp4_path: a.original_mp4, vn_srt_path: a.subs_vn, output_path: a.composed });
      state.upsert(modal_id, { status: "composed" });
    }

    // STEP: publish
    if (!skipPublish) {
      const cur = state.get(modal_id);
      const results = await publish({
        composed_mp4: a.composed,
        modal_id,
        original_title_cn: cur?.title_cn || modal_id,
        vn_srt_path: a.subs_vn,
        dryRun: dryRunPublish,
      });
      const posted = results.filter(r => r.status === "ok").map(r => r.channel);
      const failed = results.filter(r => r.status === "fail").map(r => r.channel);
      state.upsert(modal_id, {
        status: failed.length === 0 ? "published" : "publish_failed",
        channels_posted: posted,
        channels_failed: failed,
      });
    } else {
      log.info("orchestrator", `skip-publish — stop at composed`);
    }

    log.info("orchestrator", `✅ ${modal_id} done`);
  } catch (e) {
    const cur = state.get(modal_id) || {};
    const failureStep =
      !existsSync(a.original_mp4) ? "download_failed" :
      !existsSync(a.subs_cn) ? "subs_failed" :
      !existsSync(a.subs_vn) ? "translate_failed" :
      !existsSync(a.composed) ? "compose_failed" :
      "publish_failed";
    state.upsert(modal_id, { status: failureStep, last_error: e.message });
    log.error("orchestrator", `❌ ${modal_id} ${failureStep}: ${e.message}`);
  }
}

async function main() {
  const opts = parseArgs();

  // Branch: retry-failed
  if (opts.retryFailed) {
    const failed = state.list({ status: /_failed$/ });
    log.info("orchestrator", `retry-failed — ${failed.length} videos`);
    for (const v of failed) {
      await runPipelineFor(v.modal_id, opts, { title_cn: v.title_cn });
    }
    return;
  }

  // Branch: resume single
  if (opts.resume) {
    await runPipelineFor(opts.resume, opts);
    return;
  }

  // Branch: explicit URL
  if (opts.url) {
    const id = extractModalIdFromUrl(opts.url);
    if (!id) { console.error("could not extract modal_id from url"); process.exit(1); }
    await runPipelineFor(id, opts);
    return;
  }

  // Branch: discover by keyword/creator
  const keyword = opts.keyword;
  const creator = opts.creator;
  if (!keyword && !creator) {
    // default to first configured keyword
    if (!DOUYIN_CONFIG.keywords.length) {
      console.error("no keyword/creator provided and config has none");
      process.exit(1);
    }
    opts.keyword = DOUYIN_CONFIG.keywords[0];
  }

  const candidates = await discover({
    keyword: opts.keyword,
    creator: opts.creator,
    maxResults: opts.max,
  });

  if (opts.dryRun) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }

  for (const c of candidates) {
    // skip if already processed (non-failed)
    const existing = state.get(c.modal_id);
    if (existing && !/_failed$/.test(existing.status) && existing.status !== "discovered") {
      log.info("orchestrator", `skip ${c.modal_id} (status=${existing.status})`);
      continue;
    }
    state.upsert(c.modal_id, { status: "discovered", title_cn: c.title, view_count: c.view_count });
    await runPipelineFor(c.modal_id, opts, { title_cn: c.title });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 13.2: Smoke test — dry-run discover**

```bash
node src/douyin/repurpose.mjs --keyword "百岁觉醒" --max 2 --dry-run
```

Expected: prints JSON array of candidates, exits 0.

- [ ] **Step 13.3: Smoke test — resume on already-downloaded video, dry-run-publish**

```bash
node src/douyin/repurpose.mjs --resume 7626368910716608741 --dry-run-publish
```

Expected: pipeline runs through compose if any step missing, then logs caption preview but does not post. state.json updated.

- [ ] **Step 13.4: Commit**

```bash
git add src/douyin/repurpose.mjs
git commit -m "feat(douyin): repurpose orchestrator CLI

Adds src/douyin/repurpose.mjs:
- CLI flags: --keyword/--creator/--url, --resume, --retry-failed,
  --dry-run, --dry-run-publish, --skip-publish, --force-step, --max
- Idempotent step detection via artifact existence (--resume safe to rerun)
- Per-step state.json updates so failures recoverable from exact point
- Status enum: discovered → downloaded → subs_extracted → translated →
  composed → published, or *_failed at each step
- Per-video try/catch — one failure does not stop other discovered videos

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: End-to-end real-run + manual verification

This task validates the full pipeline against the user's example URL.

- [ ] **Step 14.1: Verify Chrome profile + Douyin login**

```bash
# If not yet done — manual one-time setup:
"C:/Program Files/Google/Chrome/Application/chrome.exe" --user-data-dir="C:/Users/nnanh01/AppData/Local/douyin-cdp-profile" https://www.douyin.com
```

Login Douyin in opened Chrome, close window.

- [ ] **Step 14.2: Run pipeline end-to-end on example URL with skip-publish**

```bash
node src/douyin/repurpose.mjs --url "https://www.douyin.com/video/7626368910716608741" --skip-publish
```

Expected output sequence in logs:
1. `[download] yt-dlp ←` → `original.mp4` created
2. `[extract-subs] sampled N frames` → `subs_cn.srt` created
3. `[extract-subs] OCR → K cues, avg_conf=...` (or `fallback ASR`)
4. `[translate] Claude attempt 1/2` → `subs_vn.srt` created
5. `[compose] ffmpeg → composed.mp4` → `composed.mp4` created
6. `[orchestrator] skip-publish — stop at composed`
7. `[orchestrator] ✅ 7626368910716608741 done`

Verify on disk:
```bash
ls -la D:/tiktok/douyin/7626368910716608741/
```
Expected files: `original.mp4`, `original.info.json`, `subs_cn.srt`, `subs_vn.srt`, `subs_meta.json`, `composed.mp4`.

- [ ] **Step 14.3: Manual visual review of composed.mp4**

Open `D:/tiktok/douyin/7626368910716608741/composed.mp4` in any video player.

**Checklist:**
- [ ] Aspect ratio is 9:16 vertical
- [ ] No Douyin watermark visible (top + bottom crop worked)
- [ ] Vietnamese subtitle visible at bottom, white with black outline
- [ ] Subtitle timing matches what's spoken
- [ ] Vietnamese diacritics render correctly (no boxes/missing glyphs)
- [ ] Original Chinese audio is audible

If subtitle has missing diacritics → font fallback to "Arial Unicode MS" in `config.mjs` (already configured) but verify font registered in Windows.

If timing drift visible → check `subs_meta.json` `source` field. If `asr` and drift bad → may need to tune Gemini prompt.

- [ ] **Step 14.4: Inspect state.json**

```bash
cat D:/tiktok/douyin/state.json
```

Should contain entry for `7626368910716608741` with `status: "composed"`, populated `cue_count`, `avg_confidence`, `char_ratio`, `title_cn`.

- [ ] **Step 14.5: Verify --resume idempotence**

```bash
node src/douyin/repurpose.mjs --resume 7626368910716608741 --skip-publish
```

Expected: all step "needX" checks return false (artifacts exist), pipeline ends in seconds with `✅ done`.

- [ ] **Step 14.6: Verify --dry-run-publish caption**

```bash
node src/douyin/repurpose.mjs --resume 7626368910716608741 --dry-run-publish
```

Expected: caption logged. Caption is:
- Vietnamese only
- < 80 chars before hashtags
- Ends with `\n#trendingvideo #trend`
- No mention of Douyin / Trung Quốc

- [ ] **Step 14.7: Write end-to-end completion note**

Create `D:/tiktok/douyin/SETUP.md`:
```markdown
# Douyin Pipeline — Setup notes (post-implementation)

## First-time Chrome profile setup
1. Run: `chrome.exe --user-data-dir="C:/Users/nnanh01/AppData/Local/douyin-cdp-profile" https://www.douyin.com`
2. Login Douyin in that window, then close.

## Channel activation (when ready to post)
Edit `src/douyin/config.mjs` → `channels`:
```js
tiktok:    { enabled: true, pfmTtId: "<PostForMe TT account id>", provider: "postforme" },
fb_reels:  { enabled: true, pfmId: "<PostForMe FB account id>",   provider: "postforme" },
```

## Routine usage
- New batch: `node src/douyin/repurpose.mjs --keyword "<cn keyword>" --max 2`
- Single video: `node src/douyin/repurpose.mjs --url "<douyin url>"`
- Retry failures: `node src/douyin/repurpose.mjs --retry-failed`
- See state: `cat D:/tiktok/douyin/state.json`

## Troubleshooting
- OCR empty / wrong language → check `subs_meta.json` source field; manually call `fallback-asr.mjs` with mp4 path
- Subtitle missing diacritics → verify "Be Vietnam Pro" installed in Windows Fonts
- yt-dlp 403 / geo block → re-run Chrome login step (cookie may have expired)
- DOM drift on discover (empty results) → check `D:/tiktok/douyin/discover-empty-*.json`; selector in discover.mjs may need update
```

- [ ] **Step 14.8: Commit final**

```bash
git add D:/tiktok/douyin/SETUP.md
# (state.json + downloaded artifacts are gitignored — verify with `git status`)
git commit -m "docs(douyin): end-to-end setup + troubleshooting notes

Adds D:/tiktok/douyin/SETUP.md covering:
- First-time Chrome profile + Douyin login
- Channel activation steps (enable + paste PostForMe IDs)
- Routine commands (--keyword, --url, --retry-failed)
- Troubleshooting (OCR, font, yt-dlp cookies, DOM drift)

End-to-end smoke test completed on modal_id 7626368910716608741:
download → OCR/ASR → translate → compose verified.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (Plan Author Check)

### Spec coverage check
| Spec section | Task(s) |
|---|---|
| Pipeline overview / directory layout | Task 1, 13 |
| Config schema | Task 1 |
| `discover.mjs` contract | Task 4 |
| `download.mjs` contract | Task 5 |
| `ocr-paddle.mjs` + Python | Task 6, 7 |
| `extract-subs.mjs` contract | Task 8 |
| `fallback-asr.mjs` contract | Task 9 |
| `translate.mjs` contract | Task 10 |
| `compose.mjs` contract | Task 11 |
| `publish.mjs` contract | Task 12 |
| `repurpose.mjs` CLI flags | Task 13 |
| State schema with status enum | Task 1, 13 |
| Error handling / `--resume` / `--retry-failed` | Task 13 |
| Testing strategy (unit + smoke) | Tasks 1, 2, 8 (unit); 14 (e2e) |
| Setup checklist (Python, font, Chrome profile, PostForMe) | Task 14 |

All spec requirements have at least one task covering them. ✓

### Placeholder scan
- Searched for "TODO", "TBD", "fill in", "implement later", "similar to" — none present in steps. ✓
- All code blocks contain complete code. ✓
- All commands have expected output described. ✓

### Type consistency
- `extractSubs(mp4, outDir)` (Task 8) — consistent with caller in `repurpose.mjs` (Task 13) ✓
- `translateSRT(cn, vn)` (Task 10) — consistent with caller ✓
- `compose({ mp4_path, vn_srt_path, output_path })` (Task 11) — consistent ✓
- `publish({ composed_mp4, modal_id, original_title_cn, vn_srt_path, dryRun })` (Task 12) — consistent with caller ✓
- `createState(path)` interface (`.get / .upsert / .list`) — consistent ✓
- Status enum used in Task 1 test, Task 13 orchestrator — consistent ✓

No mismatches. ✓
