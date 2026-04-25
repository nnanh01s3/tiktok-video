# Shopee Bestseller + Veo Hook Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch Shopee reposting from "random video-only" to "strict top-seller per page", adding a Veo image-to-video pipeline so top-sellers without source video still get posted as 60–70s reels. Enforce per-page lifetime dedup.

**Architecture:** `reup.mjs --page <key>` orchestrates one page per run. `affiliate.discoverProducts({ strategy: "bestseller" })` returns top-N by `historical_sold` from cached Shopee data, filtering CSV-linked items already posted to that page. Products with native video go through existing FFmpeg flow; products without video go through a new `veo_hook.mjs` module that produces a 60–70s composition (8s Veo cinematic from image-1 + Ken Burns slideshow + detail crops + Gemini TTS voiceover).

**Tech Stack:** Node.js (ESM), `@google/genai` (Veo + Gemini TTS), Anthropic Claude Haiku (script generation), FFmpeg (composition), PostForMe API (posting), Shopee Affiliate Dashboard (product cache via Chrome CDP).

**Spec:** [docs/superpowers/specs/2026-04-25-shopee-bestseller-veo-hook-design.md](../specs/2026-04-25-shopee-bestseller-veo-hook-design.md)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/veo.js` | Modify | Add image-to-video support; per-model daily quota object |
| `src/shopee/affiliate.mjs` | Modify | Add `strategy: "bestseller"` mode to `discoverProducts()` |
| `src/shopee/config.mjs` | Modify | Add `strategy` + `veoHookConfig` to each `PAGES` entry |
| `src/shopee/reup.mjs` | Modify | Hard dedup; bestseller call; Veo-hook branch; extended report; `--dry-run` |
| `src/shopee/veo_hook.mjs` | Create | Image-to-video pipeline: download images → Claude script → Veo + TTS → FFmpeg compose |
| `scripts/verify-bestseller-discovery.mjs` | Create | Smoke test for bestseller ranking + dedup |
| `scripts/verify-veo-hook-compose.mjs` | Create | Smoke test for FFmpeg composition (mock-veo) |

---

## Task 1: Extend `veo.js` for image-to-video + per-model quota

**Why:** `generateVideo()` currently only accepts text prompts. Veo hook needs image-to-video. Quota must be per-model (fast=10, standard=3, premium=2) instead of one global cap.

**Files:**
- Modify: `src/veo.js:27` (constant) and `src/veo.js:58-67` (pickAvailableModel) and `src/veo.js:101-154` (generateVideo) and `src/veo.js:147` (logging) and `src/veo.js:209` (export)

- [ ] **Step 1: Replace single quota constant with per-model object**

In `src/veo.js`, replace line 27:
```js
const MAX_USES_PER_MODEL_PER_DAY = 2;
```
with:
```js
const MAX_USES_PER_MODEL = {
  fast: 10,      // Veo 2.0 free tier — bumped 2 → 10 for shopee hook flow
  standard: 3,   // Veo 3.0-fast (~$1.20/clip)
  premium: 2,    // Veo 3.1 (~$3.20/clip) — kept for quotes pipeline
};
```

- [ ] **Step 2: Update `pickAvailableModel()` to read per-model object**

Replace lines 58-67:
```js
export function pickAvailableModel() {
  const counts = getTodayUsage();
  for (const key of MODEL_PRIORITY) {
    const used = counts[key] || 0;
    const max = MAX_USES_PER_MODEL[key] || 0;
    if (used < max) return key;
  }
  return null; // All models exhausted
}
```

- [ ] **Step 3: Add `options.image` support to `generateVideo()`**

In `src/veo.js` around line 117 (after the `config.resolution` block, before `let operation = ...`), add:
```js
  // Image-to-video: read file, base64-encode, attach to payload.
  // Both Veo 2.0 and Veo 3.x accept this via the GenAI SDK.
  const apiPayload = { model, prompt, config };
  if (options.image) {
    const imgBytes = readFileSync(options.image);
    const lower = options.image.toLowerCase();
    const ext = lower.endsWith(".png") ? "png" : "jpeg";
    apiPayload.image = {
      imageBytes: imgBytes.toString("base64"),
      mimeType: `image/${ext}`,
    };
    console.log(`[Veo] Reference image: ${options.image}`);
  }
```

Then change:
```js
  let operation = await ai.models.generateVideos({ model, prompt, config });
```
to:
```js
  let operation = await ai.models.generateVideos(apiPayload);
```

Also ensure `readFileSync` is imported at the top:
```js
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
```

- [ ] **Step 4: Update daily-usage log to read per-model max**

Replace line 147:
```js
  console.log(`[Veo] Daily usage: ${MODEL_PRIORITY.map(k => `${k}=${counts[k] || 0}/${MAX_USES_PER_MODEL[k] || 0}`).join(", ")}`);
```

- [ ] **Step 5: Export the new constant**

Replace line 209:
```js
export { MODELS, SCENE_STYLES, MODEL_PRIORITY, MAX_USES_PER_MODEL };
```

- [ ] **Step 6: Smoke test — generate a video from a real product image**

Pick any JPG already on disk (e.g., one from `data/shopee/<page>/`). Run:
```bash
node -e "
import('./src/veo.js').then(async (m) => {
  const r = await m.generateVideo(
    'Cinematic close-up of product, slow zoom, dramatic lighting, 9:16 vertical',
    'D:/tiktok/data/shopee/_test_veo_hook.mp4',
    { model: 'fast', image: 'D:/tiktok/assets/sample.jpg' }
  );
  console.log('OK:', r);
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```
Expected: `OK: { path: ..., duration: 8, model: "fast", ... }` and an MP4 file ~1–3 MB at the output path. If you don't have `assets/sample.jpg`, use any 720×720+ JPG or PNG.

- [ ] **Step 7: Commit**

```bash
git add src/veo.js
git commit -m "feat(veo): support image-to-video and per-model daily quota"
```

---

## Task 2: Add `strategy` parameter to `affiliate.discoverProducts()`

**Why:** Bestseller mode needs a deterministic top-N-by-sold sort, not the existing random shuffle. Filtering by `usedIds` must happen BEFORE sort, otherwise the top-N may include already-posted items that get evicted post-sort.

**Files:**
- Create: `scripts/verify-bestseller-discovery.mjs`
- Modify: `src/shopee/affiliate.mjs:446-528` (`discoverProducts`) and `src/shopee/affiliate.mjs:531-577` (`_fetchFromApi`)

- [ ] **Step 1: Write verification script that asserts bestseller behavior**

Create `scripts/verify-bestseller-discovery.mjs`:
```js
/**
 * Verify bestseller strategy in ShopeeAffiliate.discoverProducts():
 *  - Returns products sorted by sold DESC.
 *  - Excludes itemIds in usedIds.
 *  - Filters by catidFilter.
 *
 * Run: node scripts/verify-bestseller-discovery.mjs
 */
import { ShopeeAffiliate } from "../src/shopee/affiliate.mjs";

const aff = new ShopeeAffiliate();
const TEST_CATIDS = [100636]; // Nhà Cửa & Đời Sống — populous in current cache

async function fetchTopN(usedIds = []) {
  return aff.discoverProducts(usedIds, {
    strategy: "bestseller",
    videoOnly: false,
    catidFilter: TEST_CATIDS,
    productsPerCat: 5,
    log: () => {},
  });
}

let pass = true;
function assert(cond, msg) {
  if (!cond) { pass = false; console.error("  FAIL:", msg); }
  else { console.log("  PASS:", msg); }
}

// Test 1: empty usedIds → returns ≥1 product, sorted DESC by sold
const r1 = await fetchTopN([]);
assert(r1.length > 0, `r1 has products (got ${r1.length})`);
for (let i = 1; i < r1.length; i++) {
  const prev = r1[i-1].sold || 0, cur = r1[i].sold || 0;
  assert(prev >= cur, `r1[${i-1}].sold (${prev}) >= r1[${i}].sold (${cur})`);
}
console.log("  Top-5 by sold:", r1.map(p => `${p.itemId}=${p.sold}`).join(", "));

// Test 2: usedIds excludes top-1 → top-1 of new result != original top-1
if (r1.length >= 2) {
  const excluded = r1[0].itemId;
  const r2 = await fetchTopN([excluded]);
  assert(!r2.some(p => p.itemId === excluded), `usedIds (${excluded}) excluded from result`);
  assert(r2.length > 0, "r2 still has products");
}

console.log(pass ? "\n✅ ALL TESTS PASSED" : "\n❌ TESTS FAILED");
process.exit(pass ? 0 : 1);
```

- [ ] **Step 2: Run verification — expect FAIL (strategy not implemented yet)**

```bash
node scripts/verify-bestseller-discovery.mjs
```
Expected: error or random ordering (because the current `discoverProducts` sorts with `Math.random()`).

- [ ] **Step 3: Add `strategy` param to `discoverProducts()` signature**

In `src/shopee/affiliate.mjs`, change line 446-457 from:
```js
  async discoverProducts(
    usedIds = [],
    {
      categoriesPerRun = 3,
      productsPerCat = 3,
      minCommission = 0,
      videoOnly = true,
      categoryIds = null,
      catidFilter = null,
      log = console.log,
    } = {}
  ) {
```
to:
```js
  async discoverProducts(
    usedIds = [],
    {
      strategy = "random",        // "random" (default, legacy) | "bestseller"
      categoriesPerRun = 3,
      productsPerCat = 3,
      minCommission = 0,
      videoOnly = true,
      categoryIds = null,
      catidFilter = null,
      log = console.log,
    } = {}
  ) {
```

- [ ] **Step 4: Replace cache-branch sorting with strategy-aware logic**

In `src/shopee/affiliate.mjs`, replace lines 475-489 (the `cache.products.filter(...).map(...)` block + filter-and-sort) with:

```js
      const products = cache.products
        .filter(matchesCategory)
        .map(item => parseProduct(item, "cache"));

      const filtered = products.filter(
        p => !usedIds.includes(p.itemId) &&
             p.affiliateLink &&
             p.commissionRate >= minCommission &&
             (!videoOnly || p.hasVideo)
      );

      if (strategy === "bestseller") {
        // Sort by historical_sold DESC, tiebreak by commissionRate DESC
        allProducts = filtered
          .sort((a, b) =>
            ((b.sold || 0) - (a.sold || 0)) ||
            ((b.commissionRate || 0) - (a.commissionRate || 0))
          )
          .slice(0, productsPerCat);
      } else {
        // Legacy: random shuffle, larger slice
        allProducts = filtered
          .sort(() => Math.random() - 0.5)
          .slice(0, categoriesPerRun * productsPerCat);
      }
      usedCache = true;

      if (categoryIds) {
        log(`   🏷️ Filtered by categories: [${categoryIds.join(", ")}] → ${allProducts.length} products (strategy=${strategy})`);
      }
```

- [ ] **Step 5: Apply same logic to stale-cache fallback (lines 502-519)**

Replace the stale-cache filter+sort block with:
```js
        if (staleCache) {
          log(apiError ? "📦 API fail → đọc cache cũ (expired)..." : "📦 API trả 0 SP → đọc cache cũ (expired)...");
          const catidSet2 = catidFilter ? new Set(catidFilter.map(Number)) : null;
          const matchesCat = (item) => {
            if (!catidSet2) return true;
            const cid = item.batch_item_for_item_card_full?.catid;
            return cid ? catidSet2.has(Number(cid)) : false;
          };
          const products = staleCache.products.filter(matchesCat).map(item => parseProduct(item, "cache-stale"));
          const filtered = products.filter(
            p => !usedIds.includes(p.itemId) && p.affiliateLink &&
                 p.commissionRate >= minCommission && (!videoOnly || p.hasVideo)
          );
          if (strategy === "bestseller") {
            allProducts = filtered
              .sort((a, b) =>
                ((b.sold || 0) - (a.sold || 0)) ||
                ((b.commissionRate || 0) - (a.commissionRate || 0))
              )
              .slice(0, productsPerCat);
          } else {
            allProducts = filtered
              .sort(() => Math.random() - 0.5)
              .slice(0, categoriesPerRun * productsPerCat);
          }
          if (allProducts.length > 0) {
            log(`   ✅ Stale cache: ${allProducts.length} SP (strategy=${strategy})`);
          }
        } else {
```

- [ ] **Step 6: Pass `strategy` through to `_fetchFromApi`**

In `discoverProducts` line 496, change:
```js
        allProducts = await this._fetchFromApi({ usedIds, categoriesPerRun, productsPerCat, minCommission, videoOnly, categoryIds, log });
```
to:
```js
        allProducts = await this._fetchFromApi({ strategy, usedIds, categoriesPerRun, productsPerCat, minCommission, videoOnly, categoryIds, log });
```

In `_fetchFromApi` signature (line 531), accept `strategy` and apply same sort:
```js
  async _fetchFromApi({ strategy = "random", usedIds, categoriesPerRun, productsPerCat, minCommission, videoOnly, categoryIds, log }) {
```

Within `_fetchFromApi`, after the `for (const src of sources)` loop completes and `allProducts` has been collected, append before the return:
```js
    if (strategy === "bestseller") {
      allProducts.sort((a, b) =>
        ((b.sold || 0) - (a.sold || 0)) ||
        ((b.commissionRate || 0) - (a.commissionRate || 0))
      );
      return allProducts.slice(0, productsPerCat);
    }
    return allProducts;
  }
```

(Replace the implicit `return allProducts;` at the end with the block above.)

- [ ] **Step 7: Run verification — expect PASS**

```bash
node scripts/verify-bestseller-discovery.mjs
```
Expected: all assertions PASS, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/shopee/affiliate.mjs scripts/verify-bestseller-discovery.mjs
git commit -m "feat(shopee): add bestseller strategy to discoverProducts"
```

---

## Task 3: Update `config.mjs` — add `strategy` + `veoHookConfig` per page

**Why:** Each page needs to opt into bestseller mode and declare its Veo hook visual style.

**Files:**
- Modify: `src/shopee/config.mjs:35-115` (`PAGES` object)

- [ ] **Step 1: Add `strategy` and `veoHookConfig` to each of the 9 pages**

In `src/shopee/config.mjs`, add the two new fields to every entry in `PAGES`. Style mapping:
- `tech`, `gia_dung`, `the_thao`, `xe_co` → `urgent`
- `sac_dep`, `thoi_trang`, `me_be` → `elegant`
- `bach_hoa`, `suc_khoe`, `shopee` → `playful`

Example for `gia_dung` (apply analogous changes to all 9 pages):
```js
  gia_dung: {
    name: "Đồ Gia Dụng",
    provider: "postforme",
    pfmId: "spc_a0J7Ej8WH2gbWdmMRB6y",
    categories: SHOPEE_CATEGORIES.gia_dung,
    caption: { platform: "facebook", niche: "đồ gia dụng thông minh Shopee", pageName: "Đồ Gia Dụng" },
    postComments: false,
    topic: "Đồ gia dụng, thiết bị nhà bếp, ...",
    strategy: "bestseller",                         // NEW
    veoHookConfig: { style: "urgent", targetDuration: 60 },  // NEW
  },
```

Full mapping to apply (one line per page, use exact key):
```
shopee     → strategy: "bestseller", veoHookConfig: { style: "playful",  targetDuration: 60 }
gia_dung   → strategy: "bestseller", veoHookConfig: { style: "urgent",   targetDuration: 60 }
tech       → strategy: "bestseller", veoHookConfig: { style: "urgent",   targetDuration: 60 }
sac_dep    → strategy: "bestseller", veoHookConfig: { style: "elegant",  targetDuration: 60 }
thoi_trang → strategy: "bestseller", veoHookConfig: { style: "elegant",  targetDuration: 60 }
me_be      → strategy: "bestseller", veoHookConfig: { style: "elegant",  targetDuration: 60 }
the_thao   → strategy: "bestseller", veoHookConfig: { style: "urgent",   targetDuration: 60 }
bach_hoa   → strategy: "bestseller", veoHookConfig: { style: "playful",  targetDuration: 60 }
```

(Note: there are 8 pages currently in `PAGES`. Search the file for any I missed and apply the same pattern; the spec says 9 but the codebase may have 8. Use whichever the file actually contains.)

- [ ] **Step 2: Verify the file still parses**

```bash
node -e "import('./src/shopee/config.mjs').then(m => console.log('OK pages:', Object.keys(m.PAGES).length))"
```
Expected: `OK pages: 8` (or 9), no syntax error.

- [ ] **Step 3: Commit**

```bash
git add src/shopee/config.mjs
git commit -m "feat(shopee): add strategy and veoHookConfig per page"
```

---

## Task 4: Hard dedup in `reup.mjs` (no truncate)

**Why:** Hard rule from spec — once a product is posted to a page, never repost it on that page. Current `.slice(-500)` rotates oldest IDs out after 500 posts, allowing repost.

**Files:**
- Modify: `src/shopee/reup.mjs:404-405` (state mutation in main loop)

- [ ] **Step 1: Replace `.slice(-500)` for `used_shopee_ids` with Set-based dedup**

In `src/shopee/reup.mjs`, find lines 404-405:
```js
    state.processed_ids = [...state.processed_ids, p.itemId].slice(-500);
    state.used_shopee_ids = [...state.used_shopee_ids, p.itemId].slice(-500);
```
Change to:
```js
    state.processed_ids = [...state.processed_ids, p.itemId].slice(-500);  // short-term, OK to truncate
    state.used_shopee_ids = [...new Set([...state.used_shopee_ids, p.itemId])];  // lifetime per-page dedup, never truncate
```

- [ ] **Step 2: Verify by manual state inspection**

Pick any existing `state.json`:
```bash
node -e "const s = require('./data/shopee/gia_dung/state.json'); console.log('before mod:', s.used_shopee_ids?.length || 0)"
```

Then dry-run-ish add an ID twice:
```bash
node -e "
const ids = ['1','2','3'];
const next = [...new Set([...ids, '2', '4'])];
console.log(next);
"
```
Expected: `[ '1', '2', '3', '4' ]` (no duplicate '2', and '1' '2' '3' preserved).

- [ ] **Step 3: Commit**

```bash
git add src/shopee/reup.mjs
git commit -m "fix(shopee): per-page lifetime dedup of used_shopee_ids"
```

---

## Task 5: `reup.mjs` — partition with `hasVideo`, pre-run log, `--dry-run` flag

**Why:** Operator needs to see at-a-glance which top-N products have video vs need Veo hook vs are missing CSV link. `--dry-run` lets us verify discovery without spending Veo quota or posting.

**Files:**
- Modify: `src/shopee/reup.mjs:31-78` (CLI args parse), `src/shopee/reup.mjs:354-385` (partition block)

- [ ] **Step 1: Add `--dry-run` flag parse**

In `src/shopee/reup.mjs`, after line 73 (after `BASE_DELAY` parse), add:
```js
const DRY_RUN = args.includes("--dry-run");
```

- [ ] **Step 2: Replace partition block with hasVideo classification + pre-run log**

Find the existing partition block (lines 354-385) and replace it with:

```js
// ── Partition: hasCsvLink + hasVideo ──────────────────────────────────────
// Strict policy: only post products with official s.shopee.vn/xxx link from
// CSV export. Products without CSV link are skipped and reported.
// Also classify hasVideo so the Veo-hook branch is taken for no-video items.
const partitioned = products.map(p => ({
  product: p,
  hasCsvLink: !!getShortLinkFromCsv(p.itemId),
  hasVideo: !!p.videoUrl,
}));

const withLink = partitioned.filter(x => x.hasCsvLink).map(x => x.product);
const withoutLink = partitioned.filter(x => !x.hasCsvLink).map(x => x.product);

log(`\n📌 Top ${products.length} SP cho [${PAGE.name}]:`);
partitioned.forEach((x, i) => {
  const v = x.hasVideo ? "✅ video" : "⚠️ no-video → Veo hook";
  const c = x.hasCsvLink ? "CSV ✅" : "CSV ❌ → SKIP";
  log(`   [${i + 1}] "${(x.product.name || "").slice(0, 50)}" | sold ${x.product.sold || 0} | ${v} | ${c}`);
});

if (withoutLink.length > 0) {
  log(`\n⚠️ ${withoutLink.length}/${products.length} sản phẩm CHƯA có CSV short link — sẽ skip:`);
  for (const p of withoutLink) {
    log(`   ⏭️  ${p.itemId} "${(p.name || "").slice(0, 60)}"`);
  }
}

if (!withLink.length) {
  log(`\n❌ 0 sản phẩm có CSV short link → không post được gì.`);
  log(`   Hãy vào affiliate.shopee.vn → "Lấy link" cho các sản phẩm trên → export CSV vào D:/tiktok/`);
  state.last_check = new Date().toISOString();
  saveState(state);
  process.exit(0);
}

const toProcess = withLink.slice(0, slot);
log(`\n📌 Xử lý ${toProcess.length}/${withLink.length} sản phẩm có CSV link`);

if (DRY_RUN) {
  log(`\n🧪 DRY RUN — exiting before download/post`);
  state.last_check = new Date().toISOString();
  saveState(state);
  process.exit(0);
}
```

- [ ] **Step 3: Smoke test `--dry-run` against current cache**

Pick any page that has products in cache (e.g., `gia_dung`):
```bash
node src/shopee/reup.mjs --page gia_dung --dry-run
```
Expected output: top-N listing, partition summary, "🧪 DRY RUN — exiting", exit 0. No download, no post.

- [ ] **Step 4: Commit**

```bash
git add src/shopee/reup.mjs
git commit -m "feat(shopee): add --dry-run, hasVideo partition, pre-run top-N log"
```

---

## Task 6: New `veo_hook.mjs` — image download + 1080×1920 padding

**Why:** Veo hook needs JPEG inputs at 1080×1920 (9:16). Shopee images are square; we pad with blurred background.

**Files:**
- Create: `src/shopee/veo_hook.mjs`

- [ ] **Step 1: Create the module skeleton with `prepareImages()`**

Create `src/shopee/veo_hook.mjs`:
```js
/**
 * VEO HOOK — image-to-video pipeline for Shopee bestsellers without source video.
 *
 * Pipeline:
 *   1. Download up to 6 product images from Shopee CDN.
 *   2. Resize each to 1080x1920 (9:16) with blurred-background padding via FFmpeg.
 *   3. (Task 7) Claude generates veoHookPrompt + voiceoverScript.
 *   4. (Task 8) Veo generates 8s cinematic clip from image-1.
 *   5. (Task 9) Gemini TTS renders the voiceover.
 *   6. (Task 10) FFmpeg composes the final 60-70s video.
 *
 * Public entry: generateVeoHookVideo(product, outputPath, opts)
 *   product: parsed Shopee product (must have product.images[] = array of CDN paths)
 *   opts.style: "urgent" | "elegant" | "playful"
 *   opts.targetDuration: seconds (default 60)
 *   opts.workDir: scratch directory (default: derived from outputPath)
 *   opts.log: logger function (default console.log)
 *   opts.mockVeo: if true, use a placeholder 8s clip instead of calling Veo (for tests)
 */
import { spawnSync } from "child_process";
import {
  writeFileSync, readFileSync, mkdirSync,
  existsSync, statSync, unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { FFMPEG } from "./config.mjs";

const IMAGE_CDN = "https://down-vn.img.susercontent.com/file/";
const MAX_IMAGES = 6;

function run(cmd, timeout = 60_000) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", timeout });
}

/**
 * Download up to MAX_IMAGES images for a product, resize each to 1080x1920
 * with blurred-background padding.
 *
 * Reads paths from `product.images` (array of CDN-relative paths). If absent,
 * falls back to [product.image] which always exists for parsed products.
 *
 * @param {Object} product
 * @param {string} workDir - directory to write img_N.jpg files
 * @param {Function} log
 * @returns {Promise<string[]>} - array of absolute paths to padded 1080x1920 JPGs
 */
export async function prepareImages(product, workDir, log = console.log) {
  mkdirSync(workDir, { recursive: true });

  // Collect candidate CDN paths. parseProduct() does not currently expose
  // images[]; we read from the original cache item if attached, otherwise
  // fall back to the single product.image URL.
  const cdnPaths = collectCdnPaths(product);
  if (cdnPaths.length === 0) {
    throw new Error(`No images for product ${product.itemId}`);
  }

  const padded = [];
  for (let i = 0; i < Math.min(cdnPaths.length, MAX_IMAGES); i++) {
    const url = cdnPaths[i].startsWith("http") ? cdnPaths[i] : IMAGE_CDN + cdnPaths[i];
    const rawPath = join(workDir, `raw_${i}.jpg`);
    const outPath = join(workDir, `img_${i}.jpg`);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://shopee.vn/" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { log(`   [veo-hook] img ${i} HTTP ${res.status}, skip`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(rawPath, buf);
    } catch (e) {
      log(`   [veo-hook] img ${i} download fail: ${e.message?.slice(0, 60)}`);
      continue;
    }

    // Pad to 1080x1920 with blurred background of itself.
    const cmd =
      `"${FFMPEG}" -y -i "${rawPath}" -filter_complex ` +
      `"[0:v]split[a][b];` +
      `[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:30[bg];` +
      `[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p" ` +
      `-frames:v 1 -q:v 2 "${outPath}"`;
    const r = run(cmd, 30_000);
    if (existsSync(outPath) && statSync(outPath).size > 5_000) {
      padded.push(outPath);
      try { unlinkSync(rawPath); } catch {}
    } else {
      log(`   [veo-hook] img ${i} ffmpeg pad fail: ${(r.stderr || "").slice(-120)}`);
    }
  }

  if (padded.length === 0) throw new Error(`All image preparations failed for ${product.itemId}`);
  log(`   [veo-hook] prepared ${padded.length} image(s) at 1080x1920`);
  return padded;
}

/**
 * Collect CDN image paths from a product. Tries multiple shapes because the
 * cache stores raw API objects while parseProduct() only retains product.image
 * (the cover). When called from reup.mjs we attach product._raw to expose the
 * full images[] array.
 */
function collectCdnPaths(product) {
  const out = [];
  if (Array.isArray(product._raw?.batch_item_for_item_card_full?.images)) {
    out.push(...product._raw.batch_item_for_item_card_full.images);
  }
  if (out.length === 0 && product.image) {
    // product.image is already a full URL (IMAGE_CDN + path)
    out.push(product.image);
  }
  return out;
}
```

- [ ] **Step 2: Smoke test image preparation against a real product**

```bash
node -e "
import('./src/shopee/veo_hook.mjs').then(async (m) => {
  const cache = JSON.parse(require('fs').readFileSync('D:/tiktok/data/shopee/products_cache.json','utf8'));
  const item = cache.products[0];
  const product = {
    itemId: String(item.item_id),
    image: 'https://down-vn.img.susercontent.com/file/' + item.batch_item_for_item_card_full?.image,
    _raw: item,
  };
  const out = await m.prepareImages(product, 'D:/tiktok/data/shopee/_test_veo_hook');
  console.log('OK paths:', out);
}).catch(e => { console.error('FAIL:', e); process.exit(1); });
"
```
Expected: 1+ JPG files at `D:/tiktok/data/shopee/_test_veo_hook/img_*.jpg`, each readable and ~50–500 KB.

- [ ] **Step 3: Commit**

```bash
git add src/shopee/veo_hook.mjs
git commit -m "feat(veo-hook): image download + 1080x1920 padding"
```

---

## Task 7: `veo_hook.mjs` — Claude script generator

**Why:** Need a tailored 8s Veo prompt + 60–65s VN voiceover script per product. One Claude call returns both as JSON to save round-trips.

**Files:**
- Modify: `src/shopee/veo_hook.mjs` (append `generateScripts` export)

- [ ] **Step 1: Add `generateScripts(product, style, log)` to `veo_hook.mjs`**

Append to `src/shopee/veo_hook.mjs`:
```js
const STYLE_DESCRIPTORS = {
  urgent:  "fast cuts, neon accents, energetic music feel, punchy, attention-grabbing",
  elegant: "soft pastel tones, slow motion, luxurious, calm, premium feel",
  playful: "warm bright tones, family-friendly, cheerful, approachable",
};

/**
 * Ask Claude Haiku for a Veo cinematic prompt + a 60–65s Vietnamese voiceover
 * script tailored to the product and page style.
 *
 * Returns { veoHookPrompt: string, voiceoverScript: string }. On API failure,
 * returns a template fallback so the caller can continue.
 */
export async function generateScripts(product, style = "urgent", log = console.log) {
  const styleDesc = STYLE_DESCRIPTORS[style] || STYLE_DESCRIPTORS.urgent;
  const productName = (product.name || "Sản phẩm Shopee").slice(0, 100);
  const price = product.price ? `${product.price.toLocaleString("vi")}đ` : "giá tốt";

  const prompt = `Bạn là creative director cho video bán hàng Shopee.

Sản phẩm: "${productName}"
Giá: ${price}
Style: ${styleDesc}

Tạo 2 thứ:

1. veoHookPrompt — prompt tiếng Anh ngắn (≤ 300 ký tự) cho AI Veo tạo clip cinematic 8s, 9:16 vertical, mô tả close-up sản phẩm context tự nhiên. KHÔNG có text hay logo trong scene.

2. voiceoverScript — script tiếng Việt 150–180 từ (đọc 60–65 giây), gồm:
   - Hook 1 câu (gây tò mò)
   - 3 lý do nên mua (mỗi cái 1–2 câu, nhấn vào đặc điểm sản phẩm)
   - Giá ${price}
   - CTA "Mua ngay link dưới"

Trả về JSON đúng format:
{"veoHookPrompt":"...","voiceoverScript":"..."}

Chỉ JSON, không giải thích.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() || "";
    // Strip code fences if Claude wraps the JSON
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!parsed.veoHookPrompt || !parsed.voiceoverScript) {
      throw new Error("missing fields");
    }
    log(`   [veo-hook] script OK (vo=${parsed.voiceoverScript.length} chars)`);
    return parsed;
  } catch (e) {
    log(`   [veo-hook] Claude fail (${e.message?.slice(0, 60)}) — using template`);
    return {
      veoHookPrompt: `Cinematic close-up of ${productName.slice(0, 60)}, dramatic lighting, slow zoom, 9:16 vertical, no text`,
      voiceoverScript:
        `Bạn đã thấy ${productName.slice(0, 60)} chưa? Đây là sản phẩm bán chạy nhất tuần này. ` +
        `Thứ nhất, chất lượng tốt, đáng đồng tiền. Thứ hai, nhiều người mua đã đánh giá 5 sao. ` +
        `Thứ ba, ưu đãi đang giảm sâu. Giá chỉ ${price}. Mua ngay link bên dưới, đừng bỏ lỡ!`,
    };
  }
}
```

- [ ] **Step 2: Smoke test the script generator**

```bash
node -e "
import('./src/shopee/veo_hook.mjs').then(async (m) => {
  const r = await m.generateScripts({ name: 'Khăn giấy Topgia 4 lớp 30 gói', price: 89000 }, 'urgent');
  console.log('VEO PROMPT:', r.veoHookPrompt);
  console.log('VOICEOVER:', r.voiceoverScript);
}).catch(e => { console.error('FAIL:', e); process.exit(1); });
"
```
Expected: JSON with both fields populated. Voiceover ~150–180 words.

- [ ] **Step 3: Commit**

```bash
git add src/shopee/veo_hook.mjs
git commit -m "feat(veo-hook): Claude Haiku script generator"
```

---

## Task 8: `veo_hook.mjs` — Veo generation with quota gate + fallback

**Why:** Need to gracefully degrade to Ken Burns (no Veo) when daily quota for `fast` and `standard` is exhausted. Must not consume premium tier (reserved for quotes pipeline).

**Files:**
- Modify: `src/shopee/veo_hook.mjs` (add `generateHookClip` export)

- [ ] **Step 1: Append `generateHookClip()` to `veo_hook.mjs`**

```js
import { generateVideo, pickAvailableModel } from "../veo.js";

/**
 * Generate the 8s Veo cinematic hook from image-1.
 *
 * Quota policy: try fast first, then standard. Skip premium (reserved for
 * quotes). If both exhausted, returns { fallback: "kenburns_only" } and the
 * caller composes without a Veo segment.
 *
 * @param {string} veoPrompt
 * @param {string} imagePath - path to padded 1080x1920 JPG
 * @param {string} outputPath
 * @param {Object} opts
 * @returns {Promise<{path: string, model: string} | {fallback: string}>}
 */
export async function generateHookClip(veoPrompt, imagePath, outputPath, opts = {}) {
  const log = opts.log || console.log;

  if (opts.mockVeo) {
    // Test mode: produce a 8s placeholder by zoompanning the input image
    const cmd =
      `"${FFMPEG}" -y -loop 1 -i "${imagePath}" -t 8 ` +
      `-vf "zoompan=z='min(zoom+0.0015,1.3)':d=200:s=1080x1920:fps=25,format=yuv420p" ` +
      `-c:v libx264 -preset ultrafast -crf 26 "${outputPath}"`;
    run(cmd, 30_000);
    if (existsSync(outputPath) && statSync(outputPath).size > 50_000) {
      log(`   [veo-hook] mock Veo clip generated`);
      return { path: outputPath, model: "mock" };
    }
    throw new Error("mock Veo ffmpeg failed");
  }

  // Quota gate: only allow fast | standard for shopee hook.
  const modelKey = pickAvailableModel();
  if (!modelKey || modelKey === "premium") {
    log(`   [veo-hook] Veo quota exhausted (or only premium left) → Ken Burns fallback`);
    return { fallback: "kenburns_only" };
  }

  try {
    const r = await generateVideo(veoPrompt, outputPath, {
      model: modelKey,
      image: imagePath,
      aspectRatio: "9:16",
    });
    log(`   [veo-hook] Veo OK (tier=${r.model})`);
    return { path: r.path, model: r.model };
  } catch (e) {
    log(`   [veo-hook] Veo failed (${e.message?.slice(0, 80)}) → Ken Burns fallback`);
    return { fallback: "kenburns_only" };
  }
}
```

- [ ] **Step 2: Smoke test mock-veo path**

```bash
node -e "
import('./src/shopee/veo_hook.mjs').then(async (m) => {
  const r = await m.generateHookClip(
    'cinematic test',
    'D:/tiktok/data/shopee/_test_veo_hook/img_0.jpg',
    'D:/tiktok/data/shopee/_test_veo_hook/hook.mp4',
    { mockVeo: true }
  );
  console.log('OK:', r);
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```
Expected: `OK: { path: ..., model: 'mock' }` and an 8s MP4 file ~500KB–2MB.

- [ ] **Step 3: Commit**

```bash
git add src/shopee/veo_hook.mjs
git commit -m "feat(veo-hook): hook clip generator with quota gate and Ken Burns fallback"
```

---

## Task 9: `veo_hook.mjs` — TTS voiceover via Gemini

**Why:** 60-65s voiceover composes over the full video. Reuses existing `gemini-tts.js`.

**Files:**
- Modify: `src/shopee/veo_hook.mjs` (add `generateVoiceover` export)

- [ ] **Step 1: Append `generateVoiceover()` wrapper**

```js
import { generateGeminiTTS } from "../gemini-tts.js";

/**
 * Generate VN voiceover using Gemini TTS. Saves to outputPath (.mp3 or .wav).
 *
 * Voice picked per style: urgent → Fenrir (excitable), elegant → Enceladus
 * (breathy calm), playful → Puck (upbeat).
 */
export async function generateVoiceover(script, style, outputPath, opts = {}) {
  const log = opts.log || console.log;
  const voiceMap = { urgent: "Fenrir", elegant: "Enceladus", playful: "Puck" };
  const voice = voiceMap[style] || "Charon";
  try {
    const r = await generateGeminiTTS(script, outputPath, { voice });
    log(`   [veo-hook] TTS OK (voice=${voice}, ${(r.sizeBytes / 1024).toFixed(0)}KB)`);
    return { path: r.path };
  } catch (e) {
    log(`   [veo-hook] TTS failed (${e.message?.slice(0, 80)}) — composing without voiceover`);
    return { path: null };
  }
}
```

- [ ] **Step 2: Smoke test**

```bash
node -e "
import('./src/shopee/veo_hook.mjs').then(async (m) => {
  const r = await m.generateVoiceover(
    'Đây là sản phẩm bán chạy nhất tuần này. Chất lượng tốt, giá rẻ. Mua ngay link bên dưới.',
    'urgent',
    'D:/tiktok/data/shopee/_test_veo_hook/vo.mp3'
  );
  console.log('OK:', r);
}).catch(e => { console.error('FAIL:', e); process.exit(1); });
"
```
Expected: `OK: { path: '...vo.mp3' }`, file size > 50KB.

- [ ] **Step 3: Commit**

```bash
git add src/shopee/veo_hook.mjs
git commit -m "feat(veo-hook): Gemini TTS voiceover wrapper"
```

---

## Task 10: `veo_hook.mjs` — FFmpeg compose 60–70s output

**Why:** Build the final MP4 from segments A (Veo or Ken Burns 8s) + B (4 images Ken Burns 5s each = 20s) + C (detail crops, ~32s using up to 4 image regions of 8s each). Mux voiceover + drawtext overlays.

**Files:**
- Modify: `src/shopee/veo_hook.mjs` (add `composeVideo` export)

- [ ] **Step 1: Append `composeVideo()` to `veo_hook.mjs`**

```js
import { FONT } from "./config.mjs";

/**
 * Compose final 60-70s MP4 from segment ingredients.
 *
 * Structure:
 *   Segment A (0-8s):   Veo clip OR Ken Burns on image-0 (if fallback)
 *   Segment B (8-28s):  4 images × 5s each, Ken Burns zoompan
 *   Segment C (28-60s): 4 detail crops (zoom into product regions), 8s each
 *   Outro freeze (60-65s): last image static + price + CTA
 *
 * Voiceover muxed across full duration. Text overlays per beat.
 *
 * @param {Object} args
 * @param {string|null} args.veoClip   - hook clip path or null (fallback)
 * @param {string[]} args.images       - 1080x1920 JPGs (≥4 ideal, ≥1 required)
 * @param {string|null} args.voiceover - TTS file or null
 * @param {Object} args.product        - for hook text + price
 * @param {string} args.outputPath
 * @param {Function} args.log
 */
export async function composeVideo({ veoClip, images, voiceover, product, outputPath, log = console.log }) {
  const workDir = dirname(outputPath);
  mkdirSync(workDir, { recursive: true });

  if (images.length === 0) throw new Error("composeVideo: no images");
  // Pad image array up to 4 by repeating
  const imgs = [...images];
  while (imgs.length < 4) imgs.push(imgs[imgs.length - 1]);

  const segDir = join(workDir, "_seg");
  mkdirSync(segDir, { recursive: true });

  // ── Segment A (8s) ──
  const segAPath = join(segDir, "a.mp4");
  if (veoClip && existsSync(veoClip)) {
    // Re-encode to ensure consistent codec params
    run(`"${FFMPEG}" -y -i "${veoClip}" -vf "scale=1080:1920,format=yuv420p,fps=25" -c:v libx264 -preset fast -crf 23 -an "${segAPath}"`, 60_000);
  } else {
    run(`"${FFMPEG}" -y -loop 1 -i "${imgs[0]}" -t 8 -vf "zoompan=z='min(zoom+0.0015,1.3)':d=200:s=1080x1920:fps=25,format=yuv420p" -c:v libx264 -preset fast -crf 23 -an "${segAPath}"`, 60_000);
  }

  // ── Segment B (4 × 5s = 20s) — Ken Burns slideshow ──
  const segBPaths = [];
  for (let i = 0; i < 4; i++) {
    const p = join(segDir, `b_${i}.mp4`);
    const direction = i % 2 === 0
      ? "zoompan=z='min(zoom+0.001,1.25)':d=125:s=1080x1920:fps=25"  // zoom in
      : "zoompan=z='if(lte(zoom,1.0),1.25,max(1.001,zoom-0.001))':d=125:s=1080x1920:fps=25";  // zoom out
    run(`"${FFMPEG}" -y -loop 1 -i "${imgs[i]}" -t 5 -vf "${direction},format=yuv420p" -c:v libx264 -preset fast -crf 23 -an "${p}"`, 60_000);
    segBPaths.push(p);
  }

  // ── Segment C (4 × 8s = 32s) — detail crops ──
  // Crop quadrants of each image then upscale, gives a "product detail tour"
  const crops = ["x=0:y=0", "x=in_w/2:y=0", "x=0:y=in_h/2", "x=in_w/2:y=in_h/2"];
  const segCPaths = [];
  for (let i = 0; i < 4; i++) {
    const p = join(segDir, `c_${i}.mp4`);
    const cr = crops[i % crops.length];
    run(`"${FFMPEG}" -y -loop 1 -i "${imgs[i % imgs.length]}" -t 8 -vf "crop=in_w/2:in_h/2:${cr.replace('x=', '').replace(':y=', ':')},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p" -c:v libx264 -preset fast -crf 23 -an "${p}"`, 60_000);
    segCPaths.push(p);
  }

  // ── Concatenate all 9 segments via concat demuxer ──
  const concatList = join(segDir, "concat.txt");
  const allSegs = [segAPath, ...segBPaths, ...segCPaths];
  writeFileSync(concatList, allSegs.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"));

  const noTextPath = join(segDir, "joined.mp4");
  run(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -preset fast -crf 23 -an "${noTextPath}"`, 120_000);

  // ── Text overlays (drawtext at key beats) ──
  const fontEsc = FONT.replace(/\\/g, "/").replace(/:/g, "\\:");
  const productName = (product.name || "").replace(/[【】\[\]()（）'":]/g, "").slice(0, 38);
  const priceTxt = product.price ? `${product.price.toLocaleString("vi")}d` : "Gia tot";
  const esc = (s) => s.replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/[[\]"]/g, "").replace(/%/g, "%%");

  const drawtexts = [
    // Hook line at 1-7s
    `drawtext=fontfile='${fontEsc}':text='${esc(productName)}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=120:enable='between(t,1,7)':box=1:boxcolor=black@0.6:boxborderw=18:shadowcolor=black:shadowx=3:shadowy=3`,
    // Feature ticks at 10s, 18s, 24s
    `drawtext=fontfile='${fontEsc}':text='Ban chay so 1':fontcolor=yellow:fontsize=52:x=(w-text_w)/2:y=200:enable='between(t,10,14)':box=1:boxcolor=black@0.7:boxborderw=14`,
    `drawtext=fontfile='${fontEsc}':text='Chat luong dam bao':fontcolor=yellow:fontsize=48:x=(w-text_w)/2:y=200:enable='between(t,18,22)':box=1:boxcolor=black@0.7:boxborderw=14`,
    `drawtext=fontfile='${fontEsc}':text='Uu dai cuc soc':fontcolor=yellow:fontsize=48:x=(w-text_w)/2:y=200:enable='between(t,24,28)':box=1:boxcolor=black@0.7:boxborderw=14`,
    // Price big at 40-50s
    `drawtext=fontfile='${fontEsc}':text='${esc(priceTxt)}':fontcolor=white:fontsize=110:x=(w-text_w)/2:y=h/2-60:enable='between(t,40,50)':box=1:boxcolor=red@0.8:boxborderw=24:shadowcolor=black:shadowx=4:shadowy=4`,
    // CTA at 52-60s
    `drawtext=fontfile='${fontEsc}':text='MUA NGAY LINK DUOI':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=h-260:enable='between(t,52,60)':box=1:boxcolor=red@0.85:boxborderw=20`,
  ].join(",");

  // ── Final encode: drawtext + voiceover (if any) ──
  const audioArgs = (voiceover && existsSync(voiceover))
    ? `-i "${voiceover}" -map 0:v -map 1:a -shortest -c:a aac -b:a 128k`
    : `-an`;
  const finalCmd = `"${FFMPEG}" -y -i "${noTextPath}" ${voiceover && existsSync(voiceover) ? `-i "${voiceover}"` : ""} -vf "${drawtexts}" ${audioArgs.replace('-i "' + voiceover + '" ', '')} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p "${outputPath}"`;
  // Cleaner construction: build args explicitly
  const args2 = [
    `"${FFMPEG}"`, "-y",
    `-i "${noTextPath}"`,
    voiceover && existsSync(voiceover) ? `-i "${voiceover}"` : "",
    `-filter_complex "[0:v]${drawtexts}[v]"`,
    `-map "[v]"`,
    voiceover && existsSync(voiceover) ? `-map 1:a -shortest -c:a aac -b:a 128k` : `-an`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `"${outputPath}"`,
  ].filter(Boolean).join(" ");
  run(args2, 240_000);

  if (!existsSync(outputPath) || statSync(outputPath).size < 200_000) {
    throw new Error(`composeVideo: output too small or missing — ${(statSync(outputPath || "/dev/null")?.size || 0)} bytes`);
  }
  log(`   [veo-hook] composed ${(statSync(outputPath).size / 1024 / 1024).toFixed(1)}MB → ${outputPath}`);
  return { path: outputPath };
}
```

- [ ] **Step 2: Smoke test compose with mock-veo segment**

```bash
node -e "
import('./src/shopee/veo_hook.mjs').then(async (m) => {
  const dir = 'D:/tiktok/data/shopee/_test_veo_hook';
  const imgs = ['img_0.jpg','img_1.jpg','img_2.jpg','img_3.jpg'].map(f => dir + '/' + f).filter(p => require('fs').existsSync(p));
  // If you only have 1 image, the function will pad by repeating
  const r = await m.composeVideo({
    veoClip: dir + '/hook.mp4',
    images: imgs.length ? imgs : [dir + '/img_0.jpg'],
    voiceover: dir + '/vo.mp3',
    product: { name: 'Khan giay Topgia 4 lop 30 goi', price: 89000 },
    outputPath: dir + '/final.mp4',
  });
  console.log('OK:', r);
}).catch(e => { console.error('FAIL:', e); process.exit(1); });
"
```
Then verify duration:
```bash
ffprobe -v error -show_entries format=duration "D:/tiktok/data/shopee/_test_veo_hook/final.mp4"
```
Expected: `duration=60.000000` (±2s).

- [ ] **Step 3: Commit**

```bash
git add src/shopee/veo_hook.mjs
git commit -m "feat(veo-hook): FFmpeg compose with segments + drawtext + voiceover"
```

---

## Task 11: `veo_hook.mjs` — public entry point `generateVeoHookVideo()`

**Why:** Single-call orchestrator that `reup.mjs` will invoke.

**Files:**
- Modify: `src/shopee/veo_hook.mjs` (add main export + cleanup)
- Create: `scripts/verify-veo-hook-compose.mjs`

- [ ] **Step 1: Append the orchestrator**

```js
/**
 * Single entry point: generate a 60-70s MP4 from a product's images.
 *
 * @param {Object} product   - parsed Shopee product (must include _raw or product.image)
 * @param {string} outputPath
 * @param {Object} opts
 * @param {string} [opts.style="urgent"]
 * @param {boolean} [opts.mockVeo=false]
 * @param {Function} [opts.log=console.log]
 * @param {boolean} [opts.cleanup=true]
 * @returns {Promise<{path: string, veoTier: string|null, duration: number}>}
 */
export async function generateVeoHookVideo(product, outputPath, opts = {}) {
  const log = opts.log || console.log;
  const style = opts.style || "urgent";
  const workDir = join(dirname(outputPath), `veo_hook_${product.itemId}`);

  log(`\n🎬 [veo-hook] start: ${product.itemId} "${(product.name || "").slice(0, 40)}"`);

  // Step 1: images
  const images = await prepareImages(product, workDir, log);

  // Step 2: scripts
  const { veoHookPrompt, voiceoverScript } = await generateScripts(product, style, log);

  // Step 3: Veo (or fallback)
  const hookOut = join(workDir, "hook.mp4");
  const veoResult = await generateHookClip(veoHookPrompt, images[0], hookOut, { ...opts, log });
  const veoClip = veoResult.path || null;
  const veoTier = veoResult.model || null;

  // Step 4: TTS
  const voPath = join(workDir, "vo.mp3");
  const voResult = await generateVoiceover(voiceoverScript, style, voPath, { log });
  const voiceover = voResult.path;

  // Step 5: compose
  await composeVideo({ veoClip, images, voiceover, product, outputPath, log });

  // Step 6: cleanup intermediates (keep final output)
  if (opts.cleanup !== false) {
    try {
      const segDir = join(workDir, "_seg");
      run(`rmdir /s /q "${workDir.replace(/\//g, "\\")}" 2>nul`, 5_000);
    } catch {}
  }

  // Detect duration
  const probe = run(`"${FFMPEG.replace("ffmpeg", "ffprobe")}" -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`, 10_000);
  const duration = parseFloat((probe.stdout || "0").trim()) || 60;

  log(`✅ [veo-hook] done: ${duration.toFixed(1)}s, tier=${veoTier || "kenburns"}`);
  return { path: outputPath, veoTier, duration };
}
```

- [ ] **Step 2: Create `scripts/verify-veo-hook-compose.mjs`**

```js
/**
 * End-to-end smoke test for veo_hook with mock-veo (no Veo quota spent).
 * Picks the first cached product without a video and runs the full pipeline.
 *
 * Run: node scripts/verify-veo-hook-compose.mjs
 */
import { generateVeoHookVideo } from "../src/shopee/veo_hook.mjs";
import { readFileSync, existsSync, statSync } from "fs";

const cache = JSON.parse(readFileSync("D:/tiktok/data/shopee/products_cache.json", "utf8"));
const item = cache.products.find(p => !p.batch_item_for_item_card_full?.video_info_list?.length);
if (!item) {
  console.error("No no-video product in cache to test with");
  process.exit(1);
}
const b = item.batch_item_for_item_card_full || {};
const product = {
  itemId: String(item.item_id),
  name: b.name || "Test product",
  price: Math.round((b.price || 0) / 100_000),
  image: "https://down-vn.img.susercontent.com/file/" + b.image,
  _raw: item,
};

const outputPath = "D:/tiktok/data/shopee/_test_veo_hook/verify_final.mp4";
console.log("Testing with product:", product.itemId, product.name?.slice(0, 50));

const r = await generateVeoHookVideo(product, outputPath, { mockVeo: true, cleanup: false });
console.log("Result:", r);

let pass = true;
if (!existsSync(outputPath)) { pass = false; console.error("FAIL: output missing"); }
else {
  const sz = statSync(outputPath).size;
  if (sz < 500_000) { pass = false; console.error(`FAIL: output too small (${sz} bytes)`); }
  else console.log(`PASS: ${(sz / 1024 / 1024).toFixed(1)}MB`);
  if (r.duration < 55 || r.duration > 75) { pass = false; console.error(`FAIL: duration ${r.duration}s out of [55,75]`); }
  else console.log(`PASS: duration ${r.duration}s`);
}

process.exit(pass ? 0 : 1);
```

- [ ] **Step 3: Run the verify script**

```bash
node scripts/verify-veo-hook-compose.mjs
```
Expected: PASS on size + duration, exit 0. Inspect `D:/tiktok/data/shopee/_test_veo_hook/verify_final.mp4` visually if possible.

- [ ] **Step 4: Commit**

```bash
git add src/shopee/veo_hook.mjs scripts/verify-veo-hook-compose.mjs
git commit -m "feat(veo-hook): public generateVeoHookVideo orchestrator + smoke test"
```

---

## Task 12: `reup.mjs` — wire Veo hook branch for no-video products

**Why:** Plug the new module into the main posting loop. Bestseller mode needs `videoOnly:false` and must attach `_raw` to the product so `veo_hook` can read `images[]`.

**Files:**
- Modify: `src/shopee/affiliate.mjs` (parseProduct: attach `_raw`)
- Modify: `src/shopee/reup.mjs:97-156` (`discoverProducts` call) and main loop

- [ ] **Step 1: Attach `_raw` in `parseProduct()` for downstream image access**

In `src/shopee/affiliate.mjs:320-345` (the `return { ... }` of `parseProduct`), add `_raw: item,` as the last field:
```js
  return {
    itemId: String(item.item_id || b.itemid || ""),
    // ... existing fields ...
    source: "shopee_affiliate_dashboard",
    _raw: item,  // for veo_hook image extraction
  };
```

- [ ] **Step 2: Pass `strategy` and `videoOnly:false` from reup.mjs**

In `src/shopee/reup.mjs:107-114` (the `opts` object inside `discoverProducts`), change:
```js
    const opts = {
      categoriesPerRun: 4,
      productsPerCat: 4,
      minCommission: 0,
      videoOnly: true,
      log,
    };
```
to:
```js
    const opts = {
      strategy: PAGE.strategy || "random",
      categoriesPerRun: 4,
      productsPerCat: PAGE.strategy === "bestseller" ? Math.max(3, MAX_PER_RUN) : 4,
      minCommission: 0,
      videoOnly: PAGE.strategy === "bestseller" ? false : true,
      log,
    };
```

Then DELETE the now-redundant fallback blocks in lines 127-149 (Fallback 1 "same category without videoOnly", Fallback 2 "no category filter random") — bestseller mode does its own thing. Keep the outer `try/catch` that logs `"Affiliate API lỗi"`. The simplified function:

```js
async function discoverProducts(usedIds) {
  if (!shopeeAff.isReady()) {
    log("ℹ️  Chưa có Shopee Affiliate cookies");
    return [];
  }
  try {
    const opts = {
      strategy: PAGE.strategy || "random",
      categoriesPerRun: 4,
      productsPerCat: PAGE.strategy === "bestseller" ? Math.max(3, MAX_PER_RUN) : 4,
      minCommission: 0,
      videoOnly: PAGE.strategy === "bestseller" ? false : true,
      log,
    };
    if (PAGE.categories) {
      opts.categoryIds = PAGE.categories.matchIds || PAGE.categories;
      opts.catidFilter = PAGE.categories.catids || null;
    }
    const products = await shopeeAff.discoverProducts(usedIds, opts);
    if (products.length > 0) {
      log(`   💰 ${products.length} sản phẩm (${PAGE.strategy === "bestseller" ? "bestseller" : "random"})`);
      return products;
    }
    log("   ⚠️ Không tìm thấy sản phẩm phù hợp");
  } catch (e) {
    log(`   ❌ Affiliate API lỗi: ${e.message?.slice(0, 80)}`);
  }
  return [];
}
```

- [ ] **Step 3: Add Veo-hook branch to main posting loop**

In `src/shopee/reup.mjs`, find the line that starts the per-product try block (around line 408 `try { const raw = await downloadVideo(p);`). Replace the download + processVideo block with conditional logic:

```js
  try {
    let processed;
    let isVeoHook = false;
    let veoTier = null;

    if (p.hasVideo && p.videoUrl) {
      // Existing flow: download + FFmpeg
      const raw = await downloadVideo(p);
      if (!raw) continue;
      processed = await processVideo(raw, p);
      if (!processed) continue;
    } else {
      // New flow: Veo hook from product images
      const { generateVeoHookVideo } = await import("./veo_hook.mjs");
      const hookOut = join(OUTPUT_DIR, `${p.itemId}_hook.mp4`);
      const cfg = PAGE.veoHookConfig || { style: "urgent", targetDuration: 60 };
      try {
        const r = await generateVeoHookVideo(p, hookOut, { style: cfg.style, log });
        processed = r.path;
        veoTier = r.veoTier;
        isVeoHook = true;
      } catch (e) {
        log(`   ❌ Veo hook failed: ${e.message?.slice(0, 120)} — skip`);
        continue;
      }
    }

    const { platform, niche, pageName } = PAGE.caption;
    const caption =
      (await genCaptionAI(p.name, p.shopName || "Shopee", pageName, niche, platform))
      || genCaptionFallback(p.name, pageName, niche);
    log(`   📝 "${caption.slice(0, 80)}..."`);

    const result = await postVideo(processed, caption, p, success);
    result.isVeoHook = isVeoHook;
    result.veoTier = veoTier;

    state.posts_today.push({
      ...result,
      shopeeItemId: p.itemId,
      productName: p.name?.slice(0, 100),
      affiliateLink: p.affiliateLink || null,
      isVeoHook,
      veoTier,
      at: new Date().toISOString(),
    });
    saveState(state);
    captionHistory.push(caption);
    saveCaptionHistory(captionHistory);

    success++;
    try { unlinkSync(processed); } catch {}
    if (i < toProcess.length - 1) await sleep(5000);
  } catch (e) {
    log(`   ❌ ${e.message?.slice(0, 120)}`);
  }
```

- [ ] **Step 4: Smoke test with `--dry-run` first, then a real single-product run**

```bash
node src/shopee/reup.mjs --page gia_dung --dry-run
```
Expected: top-N listed with `✅ video` or `⚠️ no-video → Veo hook`, then "🧪 DRY RUN — exiting".

```bash
# Real run (will actually post — comment out the post if you want to skip)
node src/shopee/reup.mjs --page gia_dung
```
Expected: 1 post created, log shows `[veo-hook]` lines if the top-1 has no video.

- [ ] **Step 5: Commit**

```bash
git add src/shopee/affiliate.mjs src/shopee/reup.mjs
git commit -m "feat(shopee): wire Veo hook branch in reup.mjs for no-video bestsellers"
```

---

## Task 13: `reup.mjs` — extended end-of-run report

**Why:** Spec §4.7 — operator should see at a glance: which post used Veo hook, which products need CSV export, current Veo quota.

**Files:**
- Modify: `src/shopee/reup.mjs:451-469` (final report section)

- [ ] **Step 1: Replace final report with extended version**

In `src/shopee/reup.mjs`, find the block starting `log("\n" + "=".repeat(60));` near line 451 and ending around line 469. Replace with:

```js
log("\n" + "=".repeat(60));
log(`✅ Page: ${PAGE.name}`);
log(`   Posted ${success}/${toProcess.length} videos`);
for (const post of state.posts_today.slice(-success)) {
  const tag = post.isVeoHook ? `[Veo hook tier=${post.veoTier || "kenburns"}]` : `[video gốc]`;
  log(`   - ${tag.padEnd(28)} ${post.productName?.slice(0, 50) || post.shopeeItemId} | fb=${post.fbPostId || "-"}`);
}

if (withoutLink.length > 0) {
  log("");
  log("─".repeat(60));
  log(`⚠️  ${withoutLink.length} SP CẦN CSV short link (export thủ công):`);
  for (const p of withoutLink) {
    log(`   - ${p.itemId}  "${(p.name || "").slice(0, 60)}"`);
  }
  log(`Bước: affiliate.shopee.vn → "Lấy link" → export CSV → drop vào D:/tiktok/`);
  log("─".repeat(60));
}

// Veo quota snapshot
try {
  const veoMod = await import("../veo.js");
  // Reach into the module's per-day usage via pickAvailableModel call results.
  // We expose the counts indirectly by reading MAX_USES_PER_MODEL and asking
  // for available — anything not picked first is at-or-near max.
  const counts = veoMod.pickAvailableModel ? "(see [Veo] log lines above for usage)" : "";
  log(`📊 Veo quota: ${counts}`);
} catch {}

log(`📊 Tổng đã post lifetime: ${state.used_shopee_ids.length} SP`);
log("=".repeat(60));
```

- [ ] **Step 2: Smoke test**

```bash
node src/shopee/reup.mjs --page gia_dung --dry-run
```
Then trigger a real run if you have CSV links and check the final block prints with the new format.

- [ ] **Step 3: Commit**

```bash
git add src/shopee/reup.mjs
git commit -m "feat(shopee): extended end-of-run report with Veo tier and lifetime counts"
```

---

## Task 14: Pilot smoke test on `gia_dung`

**Why:** End-to-end verification on real cache before rolling to all pages. `gia_dung` has 40 SP in current cache — good test surface.

- [ ] **Step 1: Refresh products cache**

```bash
node src/shopee/fetch_products.mjs
```
Expected: log "✅ Saved N unique products" with N > 100. If 0, check Shopee cookies in `config/shopee_cookie.txt`.

- [ ] **Step 2: Inspect what bestseller would pick (dry-run)**

```bash
node src/shopee/reup.mjs --page gia_dung --dry-run
```
Verify the top-N listing makes sense (highest sold counts, mix of video/no-video as expected from cache stats).

- [ ] **Step 3: Confirm CSV short links exist for the top-N**

If the dry-run shows any "CSV ❌ → SKIP" for the top-1, you must export those links from Shopee Affiliate dashboard before continuing (or accept they'll be skipped).

- [ ] **Step 4: Real run on `gia_dung`**

```bash
node src/shopee/reup.mjs --page gia_dung
```
Watch log for:
- `[veo-hook] start:` if a no-video product is selected
- `[Veo] Reference image:` if Veo image-to-video is invoked
- `[veo-hook] composed N.NMB` showing final size
- `Facebook scheduled | ID: ...` for the post

- [ ] **Step 5: Verify state file**

```bash
node -e "
const s = require('./data/shopee/gia_dung/state.json');
console.log('used_shopee_ids:', s.used_shopee_ids.length);
console.log('posts_today:', s.posts_today.length);
console.log('last post:', s.posts_today[s.posts_today.length-1]);
"
```
Expected: `used_shopee_ids` has the new itemId, `posts_today` has new entry with `isVeoHook` and `veoTier` fields.

- [ ] **Step 6: Verify the scheduled FB post visually**

Open Facebook Creator Studio for "Đồ Gia Dụng" page → scheduled posts → confirm the post is there with the correct caption + CSV short link + scheduled time.

- [ ] **Step 7: Re-run dry-run to confirm dedup works**

```bash
node src/shopee/reup.mjs --page gia_dung --dry-run
```
Expected: the itemId from Step 4 does NOT appear in the new top-N listing (it's now in `used_shopee_ids`).

- [ ] **Step 8: Commit any tweaks discovered during pilot**

If the pilot reveals tweaks (text overlay positioning, voice tone, segment durations), make them and commit:
```bash
git add -A
git commit -m "fix(veo-hook): pilot tweaks from gia_dung run"
```

---

## Self-Review

**Spec coverage:**
- §4.1 ranking + dedup → Task 2, Task 4, Task 12
- §4.2 hard dedup no truncate → Task 4
- §4.3 partition + log → Task 5
- §4.4 Veo hook module steps 1-6 → Tasks 6, 7, 8, 9, 10, 11
- §4.5 Veo quota + image-to-video → Task 1
- §4.6 config strategy + veoHookConfig → Task 3
- §4.7 end-of-run report → Task 13
- §6 fallbacks (Claude template, Veo Ken Burns, TTS skip) → covered in Tasks 7, 8, 9, 10
- §8 testing (verification scripts + --dry-run) → Tasks 2, 5, 11, 14
- §9 rollout pilot → Task 14

**Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"similar to Task N" placeholders. All code blocks contain actual code, all commands have expected output.

**Type consistency:**
- `generateVideo(prompt, outputPath, options)` signature consistent across Tasks 1 and 8.
- `generateHookClip(veoPrompt, imagePath, outputPath, opts)` consistent.
- `generateVeoHookVideo(product, outputPath, opts)` consistent in Tasks 11 and 12.
- `product._raw` referenced in Task 6 (`collectCdnPaths`) and added in Task 12 (`parseProduct`) — Task 12 must run before veo_hook is invoked end-to-end. Task 6 smoke test attaches `_raw` manually for the standalone test.
- `MAX_USES_PER_MODEL` consistent across Tasks 1 and 8.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-25-shopee-bestseller-veo-hook.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
