# Douyin Repurpose Pipeline — Design

## Context

Pipeline tự động lấy video viral từ Douyin (TikTok Trung Quốc) → OCR phụ đề tiếng Trung → dịch sang tiếng Việt → burn-in subtitle → repost lên nhiều kênh (TikTok, FB Reels, FB page, YouTube Shorts). Mục đích: tận dụng kho content storytelling/tâm linh chất lượng cao của Douyin để phục vụ audience VN.

**Output mode:** Burn-in **phụ đề tiếng Việt**, giữ nguyên audio gốc tiếng Trung (giữ cảm xúc, đơn giản nhất, tránh phức tạp dub-over).

**Volume:** 1-3 video/ngày, manual CLI trigger (MVP). Có thể tích hợp scheduler sau.

**Thư mục:** `D:/tiktok/src/douyin/`, artifacts ở `D:/tiktok/douyin/{modal_id}/`.

**Reused infrastructure:**
- `yt-dlp` (Douyin support out-of-box)
- Chrome CDP launcher pattern (đã dùng trong `fb_repost.mjs`)
- Gemini API (cho fallback ASR)
- Claude Haiku (cho translate + caption gen)
- `social-poster.js` (cho multi-channel publish via PostForMe)
- Telegram alerts (helper hiện có)

**New components:**
- PaddleOCR Python wrapper (Chinese OCR)
- SRT cue generation từ OCR sampled frames
- CN→VN translation với context spiritual/storytelling

---

## Pipeline Overview

```
repurpose.mjs CLI
  → discover.mjs (Chrome CDP search Douyin)
  → download.mjs (yt-dlp)
  → extract-subs.mjs (PaddleOCR sampled frames → CN SRT)
    └─ fallback-asr.mjs (Gemini multimodal khi OCR fail)
  → translate.mjs (Claude Haiku CN→VN)
  → compose.mjs (FFmpeg crop watermark + libass burn-in)
  → publish.mjs (multi-channel via social-poster.js)
  → update state.json
```

**Cost ước tính/video:** ~$0.02 (PaddleOCR free + Claude Haiku translate ~$0.005 + caption gen ~$0.002 + Gemini fallback ~$0.01 nếu cần).

---

## Directory Layout

```
src/douyin/
├── config.mjs          # keywords, creators, channels, paths, OCR params, subtitle style
├── discover.mjs        # Chrome CDP → list candidate videos
├── download.mjs        # yt-dlp wrapper với cookie session
├── ocr-paddle.mjs      # Python subprocess adapter cho PaddleOCR
├── extract-subs.mjs    # frame sampling + OCR + dedup + SRT generation
├── fallback-asr.mjs    # Gemini multimodal ASR khi OCR fail
├── translate.mjs       # Claude Haiku CN→VN, batch toàn bộ cues
├── compose.mjs         # FFmpeg crop + libass subtitle burn-in
├── publish.mjs         # Per-channel publish + caption generation
└── repurpose.mjs       # Orchestrator CLI

scripts/
└── paddle_ocr_batch.py # Python entry for PaddleOCR

docs/superpowers/specs/
└── 2026-05-25-douyin-repurpose-pipeline-design.md  (this file)

D:/tiktok/douyin/        # artifacts root
├── state.json
├── repurpose.log
└── {modal_id}/
    ├── original.mp4
    ├── original.info.json
    ├── frames/          (cleaned after OCR)
    ├── subs_cn.srt
    ├── subs_vn.srt
    ├── subs_meta.json
    └── composed.mp4
```

---

## Config Schema (`src/douyin/config.mjs`)

```js
export const DOUYIN_CONFIG = {
  // Discovery
  keywords: ["百岁觉醒"],
  creators: [],
  maxPerRun: 3,
  minViewCount: 100_000,

  // Chrome CDP
  chromePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  chromeUserDataDir: "C:/Users/nnanh01/AppData/Local/douyin-cdp-profile",
  chromeRemotePort: 9223,  // khác port với fb_repost (9222) để tránh xung đột

  // OCR
  ocr: {
    sampleIntervalMs: 300,
    minConfidence: 0.6,
    minCues: 5,
    cropBottomRatio: 0.4,    // crop bottom 40% trước khi OCR (giảm noise + faster)
    cropOffsetRatio: 0.55,   // start crop từ y=55%
  },

  // Subtitle style (libass force_style)
  subtitle: {
    fontName: "Be Vietnam Pro",
    fontFallback: "Arial Unicode MS",
    fontSize: 18,
    primaryColour: "&H00FFFFFF",      // white
    outlineColour: "&H00000000",      // black
    backColour: "&H80000000",         // semi-transparent black
    outline: 2,
    shadow: 0,
    marginV: 80,
    alignment: 2,                      // bottom-center
  },

  // Compose
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 23,
    preset: "medium",
    cropTopPct: 0.08,                  // crop 8% top (Douyin watermark)
    cropBottomPct: 0.05,               // crop 5% bottom (Douyin UI)
  },

  // Publish channels
  channels: {
    tiktok:    { enabled: false, postforme_id: null, platform: "tiktok" },
    fb_reels:  { enabled: false, postforme_id: null, platform: "facebook_reels" },
    fb_page:   { enabled: false, postforme_id: null, platform: "facebook" },
    yt_shorts: { enabled: false, postforme_id: null, platform: "youtube_shorts" },
  },

  // Caption
  caption: {
    maxChars: 80,
    requiredHashtags: ["#trendingvideo", "#trend"],
  },

  // Paths
  baseDir: "D:/tiktok/douyin",
  stateFile: "D:/tiktok/douyin/state.json",
  logFile: "D:/tiktok/douyin/repurpose.log",
};
```

---

## Module Contracts

### `discover.mjs`

**Signature:**
```js
async function discover({ keyword, creator, maxResults }) → Promise<Candidate[]>
```

**Candidate:**
```ts
{ modal_id: string, url: string, title: string, view_count: number, posted_at?: string }
```

**Behavior:**
1. Spawn Chrome CDP với `chromeUserDataDir` + `chromeRemotePort`
2. Navigate `https://www.douyin.com/search/{encoded_keyword}?type=general` HOẶC creator URL
3. Auto-scroll 8 lần để load thêm cards
4. Scrape `a[href*="/video/"]` từ DOM, extract `modal_id` từ regex `/\/video\/(\d+)/`
5. Parse view_text (`"2.3w"` → `23000`, `"1.2k"` → `1200`)
6. Filter `view_count >= minViewCount`
7. Sort desc by `view_count`, slice top `maxResults`
8. **Error handling:** Nếu `candidates.length === 0` → save screenshot `discover-debug-{ts}.png` + Telegram alert (DOM drift)

### `download.mjs`

**Signature:**
```js
async function download(modal_id) → Promise<DownloadResult>
```

**DownloadResult:**
```ts
{ mp4_path: string, duration_sec: number, width: number, height: number,
  original_title: string, info_json_path: string }
```

**Behavior:**
1. Mkdir `D:/tiktok/douyin/{modal_id}/`
2. Run `yt-dlp "https://www.douyin.com/video/{modal_id}" --cookies-from-browser chrome -o ".../{modal_id}/original.%(ext)s" --write-info-json`
3. ffprobe verify `duration > 0`, `width > 0`, `height > 0`
4. Parse `original.info.json` → extract title
5. Throw nếu duration NaN hoặc file <100KB (corrupt)

### `ocr-paddle.mjs`

**Signature:**
```js
async function runOCR(frame_paths) → Promise<OCRResult[]>
```

**OCRResult:**
```ts
{ frame_path: string, frame_idx: number, text: string, bbox: number[][], confidence: number }
```

**Behavior:**
1. Spawn Python subprocess: `python scripts/paddle_ocr_batch.py`
2. Write frame paths newline-separated to stdin
3. Read stdout line-by-line, each line là 1 JSON OCRResult
4. Wait subprocess exit, throw nếu non-zero

**Python side (`scripts/paddle_ocr_batch.py`):**
```python
from paddleocr import PaddleOCR
import sys, json
ocr = PaddleOCR(lang='ch', use_angle_cls=False, show_log=False)
for line in sys.stdin:
    path = line.strip()
    result = ocr.ocr(path)
    # Aggregate text + max confidence per frame
    print(json.dumps({...}), flush=True)
```

### `extract-subs.mjs`

**Signature:**
```js
async function extractSubs(mp4_path, output_srt_path) → Promise<ExtractResult>
```

**ExtractResult:**
```ts
{ srt_path: string, source: 'ocr' | 'asr', cue_count: number, avg_confidence: number }
```

**Behavior:**
1. `ffmpeg -i {mp4} -vf "fps=1/{intervalSec},crop=iw:ih*{cropBottomRatio}:0:ih*{cropOffsetRatio}" frames/%05d.jpg`
2. Call `runOCR(frame_paths)` → results
3. **Dedup consecutive identical:** group adjacent frames where Jaccard(text_a, text_b) > 0.85 → 1 cue with start_ts = first_frame_ts, end_ts = last_frame_ts + intervalMs
4. Filter cues with confidence < `minConfidence` OR text < 2 chars
5. Write SRT
6. **Fallback check:** if `cue_count < minCues` OR `avg_confidence < minConfidence` → call `fallback-asr.mjs`, replace SRT
7. Cleanup `frames/` directory
8. Return result với `source` field

### `fallback-asr.mjs`

**Signature:**
```js
async function asrFallback(mp4_path, output_srt_path) → Promise<{ srt_path, cue_count }>
```

**Behavior:**
1. Upload video tới Gemini Files API
2. Call Gemini 2.5 Flash với prompt:
   ```
   Transcribe this Chinese video in SRT format with precise timestamps.
   Each cue under 12 Chinese characters for natural reading rhythm.
   Output ONLY valid SRT, no commentary, no markdown fences.
   ```
3. Parse output, validate SRT format, write file
4. Retry 3× exponential backoff trên 429/5xx
5. Throw nếu cues === 0 sau parse

### `translate.mjs`

**Signature:**
```js
async function translateSRT(cn_srt_path, vn_srt_path) → Promise<{ cue_count, char_ratio }>
```

**Behavior:**
1. Parse CN SRT → cues array
2. Single Claude Haiku call với system prompt:
   ```
   You are translating Douyin storytelling video subtitles from Chinese to Vietnamese.
   Context: spiritual/philosophical/cổ trang narrative.
   Style: natural Vietnamese kể chuyện, giữ nhịp, dùng từ "thiên thần / giác ngộ / tu sĩ / căn nguyên" khi phù hợp.
   Constraint: mỗi line VN không dài quá 1.5× line CN (fit timing burn-in).
   Output: same cue numbering and timestamps, Vietnamese only, valid SRT format.
   ```
3. Parse output, validate timing match input cue-by-cue
4. Compute `char_ratio = avg(len(vn) / len(cn))` — warn nếu >1.8 (sub sẽ tràn frame)
5. Retry 2× nếu SRT invalid với stricter prompt
6. Write VN SRT

### `compose.mjs`

**Signature:**
```js
async function compose({ mp4_path, vn_srt_path, output_path }) → Promise<string>
```

**Behavior:**
Single FFmpeg command:
```
ffmpeg -y -i {mp4} \
  -vf "crop=iw:ih*{1-cropTopPct-cropBottomPct}:0:ih*{cropTopPct}, \
       scale=1080:1920:force_original_aspect_ratio=increase, \
       crop=1080:1920, \
       subtitles={vn_srt}:force_style='Fontname={fontName},FontSize={fontSize},...'" \
  -c:v libx264 -crf {crf} -preset {preset} \
  -c:a copy \
  {output}
```

Verify output file size > 100KB sau encode.

### `publish.mjs`

**Signature:**
```js
async function publish({ composed_mp4, modal_id, original_title, vn_cues_sample }) → Promise<PublishResult[]>
```

**PublishResult:**
```ts
{ channel: string, status: 'ok' | 'fail' | 'skipped', post_id?: string, error?: string }
```

**Behavior:**
1. Generate VN caption via Claude Haiku:
   - Input: original title (CN) + first 3 VN cues
   - Prompt: "Viết caption ngắn (max 80 chars) tiếng Việt, gây tò mò, KHÔNG nhắc Douyin/Trung Quốc, KHÔNG hashtag"
2. Append required hashtags: `caption + "\n" + "#trendingvideo #trend"`
3. Loop `channels`:
   - Nếu `enabled === false` → status `skipped`
   - Nếu `postforme_id === null` → log warning, status `skipped`
   - Else: call `social-poster.js` với platform-specific params
4. Per-channel try/catch — không stop loop khi 1 channel fail
5. Return aggregated results

### `repurpose.mjs` (orchestrator)

**CLI:**
```bash
node src/douyin/repurpose.mjs --keyword "百岁觉醒" --max 2
node src/douyin/repurpose.mjs --creator "https://www.douyin.com/user/MS4..."
node src/douyin/repurpose.mjs --url "https://www.douyin.com/video/7626..."
node src/douyin/repurpose.mjs --dry-run                      # discover only
node src/douyin/repurpose.mjs --resume 7626368910716608741   # rerun từ artifacts
node src/douyin/repurpose.mjs --force-step translate --resume 7626...
node src/douyin/repurpose.mjs --retry-failed                 # rerun *_failed videos
node src/douyin/repurpose.mjs --skip-publish                 # compose only, no post
```

**Behavior:**
1. Parse args
2. Branch source: `--url` (single), `--keyword`, `--creator`, hoặc `--retry-failed`
3. For each modal_id:
   - Read state.json, check existing status
   - Scan artifacts folder, determine which steps to skip
   - Run remaining steps in order, with try/catch per step
   - Update state.json with status after each major checkpoint
4. Final summary log + Telegram alert nếu có failure

---

## State Schema (`D:/tiktok/douyin/state.json`)

```json
{
  "schema_version": 1,
  "videos": {
    "7626368910716608741": {
      "status": "published",
      "processed_at": "2026-05-25T10:23:11+07:00",
      "title_cn": "百岁觉醒天神根源 第一章",
      "title_vn": "Sống trăm tuổi mới giác ngộ...",
      "subs_source": "ocr",
      "cue_count": 24,
      "avg_confidence": 0.92,
      "char_ratio": 1.32,
      "channels_posted": ["fb_reels"],
      "channels_failed": [],
      "last_error": null
    }
  }
}
```

**Status values:** `discovered` | `downloaded` | `subs_extracted` | `translated` | `composed` | `published` | `subs_failed` | `translate_failed` | `compose_failed` | `publish_failed` | `skipped`

---

## Error Handling & Recovery

### Principles
1. **Fail loud, not silent** — log full stack + context, không swallow exception
2. **Preserve artifacts on failure** — không cleanup folder khi fail, để `--resume` redo
3. **State.json status field** track exact failure point
4. **Telegram alert** cho Discover + Publish errors (silent failure ở 2 chỗ này nguy hiểm nhất)
5. **Retry max 3 attempts** với exponential backoff cho API failures, sau đó escalate to human

### Failure matrix

| Step | Failure | Recovery | Alert |
|---|---|---|---|
| Discover | Chrome launch fail | Kill port + retry 1× | Telegram nếu retry fail |
| Discover | 0 candidates after scroll | Save screenshot, abort | Telegram (DOM drift) |
| Discover | Keyword no results | Skip, exit 0 | No alert |
| Download | yt-dlp fail (geo/deleted) | Mark `skipped`, no retry | No alert |
| Download | File corrupt | Delete, retry 1× alt format | Telegram nếu retry fail |
| OCR | PaddleOCR crash | Auto-fallback ASR | Log only |
| OCR | Low confidence/cues | Auto-fallback ASR | Log only |
| ASR | Gemini 429 | Backoff 3×, then `subs_failed` | Telegram |
| ASR | Empty SRT | Mark `subs_failed` | Telegram |
| Translate | API error | Retry 2× | Telegram |
| Translate | Invalid SRT output | Re-prompt 1× stricter | Telegram |
| Translate | VN dài >1.8× CN | Re-prompt "shorter" | Log only |
| Compose | FFmpeg fail | Log stderr, abort | Telegram |
| Compose | Output <100KB | Retry preset=fast | Telegram |
| Publish | 1 channel fail | Continue other channels | Telegram per channel |
| Publish | All channels fail | Mark `publish_failed`, keep composed.mp4 | Telegram |
| State | JSON parse fail | Backup `.bak.{ts}`, recreate | Telegram |

### Recovery flags
- `--resume <modal_id>`: scan artifacts, skip completed steps
- `--force-step <step>`: rerun 1 specific step despite existing artifact
- `--retry-failed`: scan state.json for `*_failed` entries, retry all

---

## Testing Strategy

| Module | Approach |
|---|---|
| `discover.mjs` | Manual smoke test với keyword "百岁觉醒", assert `length > 0` |
| `ocr-paddle.mjs` + `extract-subs.mjs` | Golden file test với 1 fixture video 5s có hard-sub CN rõ, assert SRT match expected |
| `translate.mjs` | Snapshot test: fixture CN SRT → assert VN cue_count match, char_ratio < 1.8 |
| `compose.mjs` | ffprobe verify output: 1080×1920, audio codec preserved, duration ≈ source ±0.5s |
| `publish.mjs` | `--dry-run-publish` mode logs payload, không call PostForMe |
| End-to-end | `--url <single> --skip-publish` trên 1 video real, manual review composed.mp4 |

**Test fixtures location:** `test/fixtures/douyin/`
- `sample_hard_sub.mp4` (5s, có CN hard-sub)
- `sample_no_sub.mp4` (5s, không có sub — test fallback ASR)
- `expected_sample_hard_sub.srt`

---

## External Dependencies (setup checklist)

| Dependency | Status | Install |
|---|---|---|
| `yt-dlp` | Đã có | (đã cài) |
| `ffmpeg` | Đã có | (đã cài) |
| Chrome browser | Đã có | (đã cài) |
| `paddleocr` (Python) | **Cần cài** | `pip install paddleocr paddlepaddle` |
| Be Vietnam Pro font | **Cần cài** | Download Google Fonts, install Windows system font |
| Douyin login | **Cần làm** | Manual: launch Chrome with `chromeUserDataDir`, login Douyin once |
| Gemini API key | Đã có | `GEMINI_API_KEY` env var |
| Anthropic API key | Đã có | `ANTHROPIC_API_KEY` env var |
| PostForMe channels | **Cần cấu hình sau** | User tạo page → paste ID vào config |

---

## Out of Scope (KHÔNG làm ở v1)

- Dubbing (lồng tiếng VN TTS) — đã chốt subtitle-only
- Soft subtitle (separate file) — burn-in only
- Auto-scheduling integration vào `src/index.js` — manual CLI MVP
- Adaptive scanning / engagement-based filter — pick by view_count đủ
- SQLite migration cho state.json — JSON đủ cho 1-3 video/ngày
- Watermark removal AI (inpainting) — chỉ crop đơn giản
- Quality scoring sau publish (likes, views feedback loop)

---

## Decisions Log

| Decision | Rationale |
|---|---|
| Output mode: subtitles only | Đơn giản, an toàn cho narrative content, giữ cảm xúc giọng gốc |
| Source: auto-scan keyword/creator | Volume scale, không phụ thuộc manual paste URL |
| ASR: OCR-first (PaddleOCR) + Gemini fallback | Douyin content tâm linh thường có hard-sub CN, OCR timing chính xác hơn ASR. Gemini fallback cover edge cases |
| Translate: Claude Haiku, batch 1 prompt | Context xuyên suốt, dịch nhất quán nhân xưng. Haiku rẻ + đủ chất lượng |
| Architecture: modular (~10 files) | Easier test, easier add dub mode sau, smaller files = LLM edit chính xác hơn |
| State: object với status field (không flat array) | Track failure point, enable `--retry-failed` |
| Publish: config-driven channel flags | Bật/tắt từng kênh không sửa code, paste page ID là chạy |
| Chrome CDP port 9223 (khác 9222) | Tránh xung đột với fb_repost.mjs đang chạy parallel |
| Caption không nhắc Douyin/CN | Positioning channel là VN content gốc |
