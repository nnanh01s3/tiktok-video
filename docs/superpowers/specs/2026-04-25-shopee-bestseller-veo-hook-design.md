# Shopee Bestseller + Veo Hook Pipeline — Design

**Date:** 2026-04-25
**Author:** Ricky Nguyen
**Status:** Draft for review
**Scope:** `src/shopee/reup.mjs`, `src/shopee/affiliate.mjs`, `src/shopee/config.mjs`, new module `src/shopee/veo_hook.mjs`

---

## 1. Problem Statement

Pipeline post Shopee hiện tại (`reup.mjs --page <key>`) chọn sản phẩm bằng `videoOnly:true` random trong các category của từng page Facebook. Điều này:

1. **Loại nhiều SP top-seller** chỉ vì chúng không có video clip do shop tự upload.
2. **Không khai thác category bestseller logic** — random thay vì sort theo doanh số.
3. **Có thể repost cùng SP trên cùng 1 page** sau ~500 posts vì state file truncate `used_shopee_ids.slice(-500)`.

Yêu cầu mới:
- Mỗi page Facebook post **top-seller tuyệt đối** trong category của page đó (sort by `historical_sold` DESC).
- SP **không có video** vẫn post được — generate "Veo hook" từ ảnh sản phẩm để tạo video 60s+.
- **Bắt buộc CSV short link** (`s.shopee.vn/xxx`); SP thiếu link bị skip và liệt kê cuối log.
- **Hard rule:** SP đã post trên 1 page FB không bao giờ post lại trên page đó.

---

## 2. Goals & Non-Goals

### Goals
- Đổi ranking từ "random có video" sang "strict bestseller per page category".
- Hỗ trợ post SP không video bằng Veo hook + slideshow ảnh + voiceover, output 60–70s.
- Per-page hard dedup (`used_shopee_ids` không bị truncate).
- Reporting cuối run liệt kê: video đã post, SP cần CSV link, Veo quota còn lại.

### Non-Goals
- Auto-export CSV short link từ Shopee Affiliate (anti-bot quá mạnh — giữ manual).
- A/B test caption styles.
- BGM licensing infrastructure (chỉ dùng 1 royalty-free loop cố định trong `assets/` nếu có sẵn; không có thì bỏ BGM).
- Post comment retry/tracking (giữ logic 60-min comment hiện tại).
- Cross-page dedup (SP X có thể post trên Gia Dụng và Bách Hóa nếu thuộc category cả 2 page).

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  reup.mjs --page <key>                                          │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────────────────────┐  │
│  │ loadState()      │ ←─ │ used_shopee_ids: [] (no truncate)│  │
│  └─────┬────────────┘    └──────────────────────────────────┘  │
│        ↓                                                        │
│  ┌──────────────────┐                                           │
│  │ discoverProducts │ ── strategy: "bestseller"                 │
│  │ (cache-driven)   │ ── filter catids → filter usedIds         │
│  └─────┬────────────┘ ── sort sold DESC → slice MAX_PER_RUN     │
│        ↓                                                        │
│  ┌──────────────────┐                                           │
│  │ partition by:    │                                           │
│  │  - hasCsvLink    │ → withoutLink: SKIP + report              │
│  │  - hasVideo      │                                           │
│  └─────┬────────────┘                                           │
│        ↓                                                        │
│  ┌─────────────────┴─────────────────┐                          │
│  │                                   │                          │
│  ↓ (hasVideo)                        ↓ (no video)               │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │ download MP4     │    │ veo_hook.mjs (NEW)               │   │
│  │ FFmpeg 9:16      │    │  1. download images              │   │
│  │ + hook text      │    │  2. Claude → veoPrompt+VO script │   │
│  └─────┬────────────┘    │  3. Veo 8s cinematic from img-1  │   │
│        ↓                 │  4. Gemini TTS 60s voiceover     │   │
│        │                 │  5. FFmpeg compose 60–70s        │   │
│        │                 └──────┬───────────────────────────┘   │
│        ↓                        ↓                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ poster.upload + scheduleFacebook + scheduleTikTok        │   │
│  │ append CSV short link to caption                         │   │
│  │ state.used_shopee_ids.push(itemId) — NEVER truncate      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Design Details

### 4.1 Ranking & Dedup (`affiliate.mjs`)

**Add parameter `strategy` to `discoverProducts()`:**

```js
discoverProducts(usedIds, {
  strategy = "random",          // NEW: "bestseller" | "random"
  videoOnly = true,             // existing default kept for back-compat
  catidFilter = null,
  productsPerCat = 3,
  ...
})
```

When the caller (`reup.mjs` bestseller branch) wants top-seller including no-video SP, it must explicitly pass `videoOnly: false` together with `strategy: "bestseller"`. The function does NOT silently flip `videoOnly` based on `strategy` — keeps callsite intent explicit.

**Bestseller branch logic** (cache-driven, identical structure to current cache path):

```js
const candidates = cache.products
  .filter(matchesCategory)                            // by catidFilter
  .map(item => parseProduct(item, "cache"))
  .filter(p => !usedIds.includes(p.itemId))           // hard dedup
  .filter(p => p.affiliateLink)                       // need affiliate link
  .filter(p => p.commissionRate >= minCommission)
  .filter(p => !videoOnly || p.hasVideo);             // bestseller mode: videoOnly=false

const topN = candidates
  .sort((a, b) =>
    (b.sold || 0) - (a.sold || 0) ||                  // primary: historical_sold DESC
    (b.commissionRate || 0) - (a.commissionRate || 0) // tiebreak: commission DESC
  )
  .slice(0, productsPerCat);
```

**Key changes vs current:**
- Filter `usedIds` happens **before** sort (not after).
- Sort by sold DESC, no `Math.random()` shuffle.
- `videoOnly` defaults to `false` when `strategy="bestseller"`.

**Stale cache fallback:** If fresh cache returns 0 candidates (because all top-seller have been posted), try stale cache same way. If still 0, return `[]` and let `reup.mjs` log "bestseller exhausted".

### 4.2 Per-Page Hard Dedup (`reup.mjs`)

**State file changes:**

```js
// BEFORE
state.used_shopee_ids = [...state.used_shopee_ids, p.itemId].slice(-500);

// AFTER
state.used_shopee_ids = [...new Set([...state.used_shopee_ids, p.itemId])];
```

- Remove `.slice(-500)` — keep all itemIds forever.
- Use `Set` to dedupe in case same itemId is added twice in a single run (e.g., retry path).
- File size estimate: 10k items × ~12 bytes/id = ~120KB. Negligible.

**`processed_ids` field:** Keep `.slice(-500)` for `processed_ids` (used for short-term tracking of failed downloads, not for dedup) — it's distinct from `used_shopee_ids`.

### 4.3 Partition (`reup.mjs`)

Extend current "withLink/withoutLink" partition to also classify video status:

```js
const partitioned = products.map(p => ({
  product: p,
  hasCsvLink: !!getShortLinkFromCsv(p.itemId),
  hasVideo: !!p.videoUrl,
}));

const toPost = partitioned.filter(x => x.hasCsvLink);
const toSkip = partitioned.filter(x => !x.hasCsvLink);
```

**Pre-run log:**
```
📌 Top 3 SP cho [Đồ Gia Dụng]:
   [1] "Khăn giấy Topgia" | sold 2M | ✅ video | CSV ✅
   [2] "Nồi chiên Lock&Lock" | sold 800k | ⚠️ no-video → Veo hook | CSV ✅
   [3] "Máy xay cầm tay" | sold 600k | ⚠️ no-video → Veo hook | CSV ❌ → SKIP
```

### 4.4 Veo Hook Module (`src/shopee/veo_hook.mjs` — NEW)

**Public API:**
```js
export async function generateVeoHookVideo(product, outputPath, opts = {}) {
  // returns { path, duration, veoTier, fallback }
}
```

**Internal flow:**

#### Step 1 — Download images
- Read `b.images[]` (Shopee CDN paths). Take up to **6 images** (first one as Veo source).
- Download to `D:/tiktok/data/shopee/<page>/veo_hook_<itemId>/img_N.jpg` via `IMAGE_CDN + path`.
- Resize each to 1080×1920 (pad with blurred background) using FFmpeg.

#### Step 2 — AI script (Claude Haiku)
Single prompt → JSON response with two fields:
```json
{
  "veoHookPrompt": "Cinematic close-up of [product context], dramatic lighting, slow zoom, 9:16",
  "voiceoverScript": "60-65s VN Vietnamese script: hook line + 3 features + price + CTA"
}
```

Style modifier per page (`PAGES[key].veoHookConfig.style`):
- `urgent` (Tech/Gia Dụng): "fast cuts, neon accents, energetic"
- `elegant` (Mỹ Phẩm/Thời Trang): "soft pastel, slow motion, luxurious"
- `playful` (Mẹ Bé/Bách Hóa): "warm bright tones, family vibe"

#### Step 3 — Veo generation
Call existing `veo.js` `generateVideo(prompt, outputPath, { model: "fast", image: img1Path })`.

**Required veo.js extension:** Current `generateVideo()` only passes `{ model, prompt, config }` to `ai.models.generateVideos()`. To support image-to-video (needed for hook generation from product photo), we need to:
1. Add `options.image` parameter (path to JPG/PNG).
2. Read the file as Buffer, base64-encode, and add `image: { imageBytes, mimeType }` to the API call payload.
3. Both Veo 2.0 (`veo-2.0-generate-001`) and Veo 3.x support image-to-video via this field (Google GenAI SDK).

**Quota gate:** Before calling Veo, check `pickAvailableModel()`:
- `fast` available → use fast (free tier)
- only `standard` available → use standard
- nothing available → return `{ fallback: "kenburns_only" }`, skip Veo step entirely

#### Step 4 — TTS voiceover
Call `gemini-tts.js` with `voiceoverScript`. Output: 60–65s MP3.

#### Step 5 — Compose with FFmpeg
Output target: **1080×1920, 60–70s, H.264 + AAC**.

Three segments concatenated via xfade transitions (1s overlap):

| Segment | Time | Source | Effect |
|---------|------|--------|--------|
| A | 0–8s | Veo clip (or img-1 zoompan if fallback) | Hook text overlay at 1s, fade out at 7s |
| B | 8–28s | 4 images × 5s each | Ken Burns zoompan + feature text overlay |
| C | 28–60s | revisit images with detail crops | Crop-zoom into product regions, transition every 4s |
| Outro | 60–65s | last image static | Price + CTA "Mua ngay 👇" + freeze |

**Voiceover** muxed across full duration. Volume normalized to -16 LUFS.

**Pseudocode for compose:**
```js
const filterGraph = [
  // Segment A: Veo or Ken Burns
  veoClip ? `[0:v]setpts=PTS-STARTPTS[a]` : `[img1]zoompan=z='min(zoom+0.0015,1.5)':d=200:s=1080x1920[a]`,
  // Segment B: Ken Burns slideshow
  buildKenBurnsChain(images.slice(0, 4)),
  // Segment C: detail crops
  buildDetailCropChain(images),
  // Concat with xfade
  xfadeChain(['a', 'b', 'c'], { duration: 1 }),
  // Text overlays (drawtext per beat)
  textOverlays(beats),
];
```

#### Step 6 — Cleanup
Delete intermediate files (raw images, Veo MP4, TTS MP3, segment files) after final output succeeds.

### 4.5 Veo Quota Update (`src/veo.js`)

```js
// BEFORE
const MAX_USES_PER_MODEL_PER_DAY = 2;

// AFTER
const MAX_USES_PER_MODEL = {
  fast: 10,      // bumped from 2 → 10 (Veo 2.0 free tier)
  standard: 3,   // capped (Veo 3.0-fast ~$1.20/clip, max ~$3.60/day)
  premium: 2,    // unchanged (Veo 3.1 ~$3.20/clip, kept for quotes pipeline)
};
```

`pickAvailableModel()` updated to read `MAX_USES_PER_MODEL[key]` instead of `MAX_USES_PER_MODEL_PER_DAY` constant. Daily usage logging in `generateVideo()` (line 147) updated similarly.

**Quota is shared globally** with the existing quotes pipeline (`pipeline-quotes-veo.js`). Quotes uses ~2 fast/day; bumping fast to 10 leaves 8/day for shopee hook — adequate for 9 pages × 1 SP/run if ~30% need Veo hook.

### 4.6 Page Config (`config.mjs`)

Add per-page config fields:

```js
PAGES.gia_dung = {
  ...,
  strategy: "bestseller",        // NEW — controls discoverProducts()
  veoHookConfig: {
    style: "urgent",             // urgent | elegant | playful
    targetDuration: 60,          // seconds
  },
};
```

**Migration:** All 9 existing pages get `strategy: "bestseller"` + appropriate `veoHookConfig.style`. Defaults to `random` + no Veo hook for backward compat.

Style mapping recommendation:
- `tech`, `gia_dung`, `the_thao` → `urgent`
- `sac_dep`, `thoi_trang`, `me_be` → `elegant`
- `bach_hoa`, `xe_co`, `suc_khoe`, `shopee` → `playful`

### 4.7 End-of-run Report (`reup.mjs`)

```
═══════════════════════════════════════════════════════
✅ Page: Đồ Gia Dụng
   Posted 2/3 videos
   - [video gốc]   Khăn giấy Topgia        | fb_post=12345
   - [Veo hook]    Nồi chiên Lock&Lock     | fb_post=12346 | tier=fast

⚠️ 1 SP CẦN CSV short link (export thủ công):
   - 23442992  "Máy xay cầm tay ABC 500W"
   Bước: affiliate.shopee.vn → "Lấy link" → export CSV vào D:/tiktok/

📊 Veo quota hôm nay: fast 1/10  standard 0/3
📊 Tổng đã post: 124 SP (lifetime)
═══════════════════════════════════════════════════════
```

---

## 5. Data Model Changes

### `state.json` per page (already exists — no schema change, only behavior change)
```json
{
  "processed_ids": ["..."],          // .slice(-500) — short-term
  "used_shopee_ids": ["..."],        // NO truncate — lifetime per-page dedup
  "posts_today": [{ ... }],          // resets daily
  "last_reset": "2026-04-25",
  "last_check": "2026-04-25T..."
}
```

### `_dailyUsage` in veo.js (no schema change, only count limits update)

---

## 6. Error Handling & Fallbacks

| Failure point | Fallback |
|---------------|----------|
| Cache empty | Try stale cache (existing behavior) |
| All top-N already posted (page exhausted) | Log warn, exit 0, suggest `fetch_products.mjs` |
| Image download fail | Skip that image, continue with remaining |
| Claude Haiku fail | Use template prompt (product name + generic style words) |
| Veo all tiers exhausted | Fallback Ken Burns-only (no Veo segment) |
| Veo generation timeout | Same — fallback Ken Burns-only |
| Gemini TTS fail | Compose video without voiceover (still has text overlays) |
| FFmpeg fail | Throw — let `reup.mjs` catch and skip this product |
| Missing CSV short link | Skip product (existing behavior) |

---

## 7. File Layout

```
src/
├── shopee/
│   ├── affiliate.mjs        ← MODIFY: add `strategy` param
│   ├── config.mjs           ← MODIFY: add `strategy` + `veoHookConfig` per page
│   ├── reup.mjs             ← MODIFY: bestseller flow + Veo hook branch + report
│   ├── short_link_lookup.mjs ← unchanged
│   ├── fetch_products.mjs   ← unchanged
│   └── veo_hook.mjs         ← NEW: image-to-video pipeline
└── veo.js                   ← MODIFY: per-model quota object

docs/superpowers/specs/
└── 2026-04-25-shopee-bestseller-veo-hook-design.md  ← THIS FILE
```

---

## 8. Testing Strategy

The repo has no formal test framework (no Jest/Vitest); existing pattern is `--dry-run` flags and standalone verification scripts. We follow the same approach.

**Verification scripts (new, in `scripts/`):**
- `scripts/verify-bestseller-discovery.mjs` — load fixture cache + usedIds, call `discoverProducts({ strategy: "bestseller" })`, assert: results sorted by sold DESC, no items in usedIds, length ≤ MAX_PER_RUN.
- `scripts/verify-veo-hook-compose.mjs` — given a fixture product (real Shopee item with images), run `generateVeoHookVideo()` end-to-end with `--mock-veo` flag (skip actual Veo call, use a placeholder 8s clip), assert output exists, duration 60–70s, dimensions 1080×1920.

**Manual integration with `--dry-run`:**
- `reup.mjs --page gia_dung --dry-run` (new flag) — runs discovery + partition + log but skips download/post. Expected output: top-3 SP listed with hasVideo/hasCsvLink flags.
- Run twice in a row with `--dry-run` and a manually-edited state file (add itemId X to `used_shopee_ids`) → expect: second run does NOT include X.

**Smoke checks (real env, single page):**
- Pick `gia_dung` (40 SP in cache, mix of video/no-video) for first real run.
- Verify output MP4: 1080×1920, 60–70s, has voiceover audio, has text overlays.
- Verify FB scheduled post exists with correct CSV short link in caption.
- Verify state.json `used_shopee_ids` contains the new itemIds and is NOT truncated.

---

## 9. Rollout Plan

1. Implement Veo hook module + tests in isolation (no `reup.mjs` change yet).
2. Add `strategy` param to `affiliate.mjs` + tests.
3. Update `reup.mjs` bestseller branch (still videoOnly=true initially) — verify dedup works.
4. Wire Veo hook branch into `reup.mjs` for one pilot page (`gia_dung`) — manual smoke test.
5. Roll out to all 9 pages by setting `strategy: "bestseller"` in config.
6. Monitor 1 week — check Veo cost, posting rate, page dedup behavior.

---

## 10. Open Questions

None at design time. All clarifying questions resolved during brainstorming:
- Ranking: strict bestseller (Q1: A)
- Veo quota: increase fast=10, standard=3 (Q2: A)
- Output format: Veo hook + slideshow → 60s+ (Q3: A modified)
- Hard rule: no repost per page (added late)
