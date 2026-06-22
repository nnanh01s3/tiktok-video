# Reels: Topic Filter + Permanent Cross-Page Dedup

**Status**: Design — approved by user 2026-04-19
**Author**: Claude + user (nnanh01)
**Related files**: `src/shopee/reels.mjs`, `src/shopee/config.mjs`, `src/db.js`, `data/content.db`, `data/shopee/reels/<page>/processed.json`

## 1. Context

The Reels pipeline (`src/shopee/reels.mjs`) scrapes TikTok/Facebook sources, selects candidates, downloads via yt-dlp / CDP, re-encodes with FFmpeg, then schedules via PostForMe. It runs 3 slots/day across 8 FB pages — total 24 Reels/day.

Two production issues observed 2026-04-19:

1. **Off-topic posts.** Videos from right-niche creators get scheduled even when individual clips are off-topic. Concrete bugs:
   - `Schannel` → page `tech`: scheduled "Đoán tên người nổi tiếng: Sao mà gợi ý xong lú luôn" — a celebrity-guessing game, not tech.
   - `BYB Academy VN` → page `thoi_trang`: scheduled "Thử thách lắc chai nước ngẫu nhiên cùng các mẫu nhí" — a kids-shaking challenge, not fashion.

2. **Lossy dedup.** Current dedup uses per-page JSON file `data/shopee/reels/<page>/processed.json` with `state.processed_ids.slice(-500)` (keeps last 500 IDs only). Two failure modes:
   - **Truncation.** After 500 posts, older IDs roll off — same video can re-post months later.
   - **Per-page isolation.** A video posted to `shopee` is not blocked from re-posting to `bach_hoa` or `tech`. Cross-niche sources (e.g. Kenh14 appears in both `tech` and `bach_hoa`) produce cross-page duplicates visible to overlapping audiences.

## 2. Goals

- **G1**: Every scheduled Reel is **on-topic** for its page's niche. Off-topic candidates are skipped, pipeline continues with next candidate / next source.
- **G2**: A video (identified by source-native ID: TikTok numeric ID or FB watch ID) is **posted at most once across all pages forever**. No truncation, no per-page silos.
- **G3**: Failure of the new mechanisms must not silently crash the whole pipeline. Classifier API errors → fail-open (allow post). DB errors → surface as exception.

## 3. Non-goals

- **No multimodal classification in v1.** Title + hashtags only. First-frame / vision adds complexity and bandwidth with unclear ROI — today's concrete bugs are all catchable from title alone.
- **No automatic blocklist expiry.** Once posted, a video is permanently blocked. Future work could add `invalidate_after` (e.g. 18 months) but not in scope.
- **No classification for TikTok Tuệ Đàm pipeline** (`pipeline-quotes-veo.js`). That pipeline generates content from `quotes_v2` — dedup via `markQuotesUsed()` already exists, content is on-topic by construction.
- **No change to reup/fb_repost pipelines.** Out of scope — those are Shopee product pushes, different domain.
- **No refactor of `PAGES` structure.** Just add one field (`topic`).

## 4. User decisions (captured during brainstorming)

| # | Question | Choice |
|---|----------|--------|
| 1 | Dedup scope | **B — cross-page global forever** |
| 2 | Classification signal | **B — LLM** (not keyword rules) |
| 3 | LLM model | **B — Gemini 2.0 Flash** |
| 4 | Input format | **A — text-only (title + hashtags)** |
| 5 | Behavior on reject | **A — strict skip, fallback to next source** |
| 6 | Dedup storage | **A — SQLite (extend `data/content.db`)** |
| 7+ | Remaining design details | Delegated to Claude |

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  reels.mjs (worker per page)                                 │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│  scrapeTikTok/scrapeFacebook                                 │
│             │                                                │
│             ▼                                                │
│   ┌──────────────────┐  isVideoPosted(id)?                   │
│   │ dedup filter     │◄──────────────┐                       │
│   │ (per candidate)  │               │                       │
│   └────────┬─────────┘               │                       │
│            │ new only                │                       │
│            ▼                         │                       │
│   ┌──────────────────┐   Gemini      │     ┌──────────────┐  │
│   │ classify         │────Flash──────┼────►│ SQLite:      │  │
│   │ (reels-classifier│               │     │ posted_reels │  │
│   │  .mjs)           │               │     │ table        │  │
│   └────────┬─────────┘               │     │              │  │
│            │ match=true              │     │ (data/       │  │
│            ▼                         │     │  content.db) │  │
│   download → FFmpeg → uploadPFM      │     └──────────────┘  │
│            │                         │          ▲            │
│            ▼                         │          │            │
│      recordPostedVideo(entry) ───────┴──────────┘            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## 6. Data model

### 6.1 New SQLite table in `data/content.db`

```sql
CREATE TABLE IF NOT EXISTS posted_reels (
  video_id       TEXT PRIMARY KEY,   -- TikTok numeric ID or FB watch ID
  source_url     TEXT NOT NULL,      -- canonical URL
  source_name    TEXT,               -- "Schannel", "ELLE Vietnam", etc.
  page_name      TEXT NOT NULL,      -- "shopee", "tech", ...
  niche          TEXT NOT NULL,      -- mirrors page_name (forward-compat)
  posted_at      TEXT NOT NULL,      -- ISO UTC timestamp of scheduling
  scheduled_at   TEXT,               -- VN-time string when post goes live
  pfm_post_id    TEXT,               -- PostForMe "sp_..." reference
  topic_score    REAL,               -- classifier confidence 0.0-1.0
  video_title    TEXT,               -- truncated 200 chars for audit
  video_duration INTEGER,            -- seconds
  file_size_mb   REAL                -- post-FFmpeg output size
);

CREATE INDEX IF NOT EXISTS idx_posted_reels_page_date
  ON posted_reels(page_name, posted_at);
CREATE INDEX IF NOT EXISTS idx_posted_reels_source
  ON posted_reels(source_name);
```

### 6.2 New helpers in `src/db.js`

```js
export function isVideoPosted(videoId) {
  const db = getDb();
  return Boolean(
    db.prepare("SELECT 1 FROM posted_reels WHERE video_id = ?").get(videoId)
  );
}

export function recordPostedVideo(entry) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO posted_reels (
      video_id, source_url, source_name, page_name, niche,
      posted_at, scheduled_at, pfm_post_id, topic_score,
      video_title, video_duration, file_size_mb
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.video_id,
    entry.source_url || "",
    entry.source_name || null,
    entry.page_name,
    entry.niche || entry.page_name,
    entry.posted_at,
    entry.scheduled_at || null,
    entry.pfm_post_id || null,
    entry.topic_score ?? null,
    entry.video_title?.slice(0, 200) || null,
    entry.video_duration ?? null,
    entry.file_size_mb ?? null
  );
}

export function getPostedStats() {
  const db = getDb();
  return db.prepare(`
    SELECT page_name, COUNT(*) as n, MAX(posted_at) as latest
    FROM posted_reels GROUP BY page_name ORDER BY n DESC
  `).all();
}
```

Added to `initSchema()` via the existing `try/catch ALTER TABLE` migration pattern used elsewhere in `db.js`.

### 6.3 Topic descriptions in `src/shopee/config.mjs`

Add `topic` field to each `PAGES[pageName]` entry. Format: free-form Vietnamese, 30-60 words, structured as "Bao gồm: ... KHÔNG bao gồm: ...".

| Page | `topic` |
|------|---------|
| `shopee` | Đồ độc lạ, gadget thú vị, dụng cụ sáng tạo, phát minh tiện ích, unboxing sản phẩm không phổ biến. Bao gồm: mẹo vặt với dụng cụ, demo sản phẩm mới. KHÔNG bao gồm: game show, challenge trẻ em, trivia địa lý/lịch sử, vlog cá nhân. |
| `gia_dung` | Đồ gia dụng, thiết bị nhà bếp, nồi chiên không dầu, máy xay, smart home, mẹo dọn dẹp, tips làm bếp, organize tủ lạnh, dọn nhà. KHÔNG bao gồm: review điện thoại, vlog gia đình, content trẻ em thuần. |
| `tech` | Review điện thoại, laptop, tai nghe, smartwatch, camera, app công nghệ, so sánh spec, unboxing gadget, thủ thuật iOS/Android. KHÔNG bao gồm: game show đoán đồ/đoán người, trivia địa lý/lịch sử, challenge giải trí, lắc chai nước. |
| `sac_dep` | Skincare, mỹ phẩm, routine dưỡng da, makeup tutorial, review sản phẩm làm đẹp, son môi, kem chống nắng, serum, retinol, livestream sale mỹ phẩm. KHÔNG bao gồm: thời trang outfit, gadget, ẩm thực. |
| `thoi_trang` | OOTD, outfit styling, phối đồ, xu hướng thời trang, try-on haul, phụ kiện (túi, giày, trang sức), street style, diễn show. KHÔNG bao gồm: challenge lắc chai, game trẻ em, gia đình vlog thuần, skincare. |
| `me_be` | Chăm con, mẹ bỉm sữa, review đồ mẹ & bé (bỉm, sữa, xe đẩy), tips nuôi con, dạy con học, vlog gia đình có trẻ nhỏ, review sách thiếu nhi. KHÔNG bao gồm: content người lớn, tech review, outfit adult. |
| `the_thao` | Tập gym, workout tại nhà, yoga, cardio, kỹ thuật tập tạ, transformation trước-sau, tips giảm cân, fitness outdoor, chạy bộ, đồ tập. KHÔNG bao gồm: bóng ma hạnh phúc (trend), dance cover, vlog ăn uống thuần. |
| `bach_hoa` | Tin tức đời sống, tips tiêu dùng, review sản phẩm thiết yếu, sách hay nên đọc, mẹo học tập, trending social, kinh tế - giá cả. KHÔNG bao gồm: nội dung nhạy cảm (drama tình cảm, chính trị cực đoan), adult content. |

## 7. Classification module

### 7.1 New file `src/shopee/reels-classifier.mjs`

Public API:

```js
/**
 * Classify whether a video is on-topic for a page's niche.
 * Fail-open on API errors (returns match=true, score=0.5).
 *
 * @param {{id: string, title: string, duration?: number, source_name?: string}} video
 * @param {string} topic - PAGES[pageName].topic
 * @returns {Promise<{match: boolean, score: number, reason: string}>}
 */
export async function classifyRelevance(video, topic);
```

### 7.2 Implementation

- **Model**: `gemini-2.0-flash` via `@google/genai` (client already in `src/tts.js`, `src/imagen.js`, `src/veo.js`).
- **Temperature**: 0.1 (deterministic).
- **Response format**: `responseMimeType: "application/json"` with strict JSON schema `{match, score, reason}`.
- **System prompt**: fixes role as content moderator, specifies JSON output, defines score threshold (≥0.7 → match).
- **User prompt**: passes `topic` + `video.title` (truncated 300 chars) + source_name + duration.
- **Fail-open**: any exception returns `{match: true, score: 0.5, reason: "classifier error: ..."}` and logs to stderr. Rationale: classifier outage should not block the pipeline — size filter + source diversity remain as safety nets.

### 7.3 Threshold choice

Global threshold: **score ≥ 0.7 → match=true**. If false positives appear (off-topic videos still getting through), raise to 0.8. If false negatives dominate (real on-topic videos skipped), lower to 0.6. Do NOT tune per-niche — over-engineering for v1.

## 8. Pipeline integration

### 8.1 Changes to `src/shopee/reels.mjs`

**Remove** (lines 65, 79-86, 356-357, 373, 405, 413, 422, 424-425, 434, 438-439):
- `PROCESSED_FILE` constant, `loadProcessed()`, `saveProcessed()` functions, all calls to them.
- `state` variable and all `state.processed_ids.push(...)` calls.
- `state.processed_ids.slice(-500)` truncation.

**Add**:
- `import { isVideoPosted, recordPostedVideo } from "../db.js";`
- `import { classifyRelevance } from "./reels-classifier.mjs";`
- `const topic = PAGES[PAGE_ARG]?.topic;` with guard: `if (!topic) throw new Error(...)`.

**Modify scrape dedup filter** (was line 373):
```js
// was: if (!state.processed_ids.includes(v.id)) { ... }
if (!isVideoPosted(v.id)) { ... }
```

**Modify candidate loop** (was lines 397-436):
```js
for (let i = 0; i < toProcess.length; i++) {
  if (success >= MAX) break;
  const video = toProcess[i];
  log(`\n[${success + 1}/${MAX}] ${video._sourceName} — ${video.id}`);

  // Topic classification (pre-download)
  const verdict = await classifyRelevance(
    { id: video.id, title: video.title, duration: video.duration, source_name: video._sourceName },
    topic
  );
  if (!verdict.match) {
    log(`   ⏭️ Off-topic (score=${verdict.score.toFixed(2)}): ${verdict.reason}`);
    continue;  // don't record — other pages may want this video
  }
  log(`   ✅ Topic match (score=${verdict.score.toFixed(2)})`);

  try {
    const raw = downloadVideo(video);
    if (!raw) { log("   ⏭️ Skip (download failed)"); continue; }

    const processed = join(OUT_DIR, `${video.id}_reel.mp4`);
    const ok = processVideo(raw, processed);
    if (!ok) { log("   ⏭️ Skip (FFmpeg failed)"); try { unlinkSync(raw); } catch {}; continue; }

    const caption = makeCaption(video.title, PAGE_ARG);
    log(`   📝 "${caption.slice(0, 80)}..."`);

    // uploadAndPost currently returns only postId. Update its signature to
    // also return the computed scheduledAt ISO string. sizeMB we can read
    // directly from the processed file via statSync — no need to thread it
    // through uploadAndPost.
    const { postId, scheduledAt } = await uploadAndPost(processed, caption, DELAY + i * 2);
    const sizeMB = Math.round((statSync(processed).size / 1024 / 1024) * 10) / 10;

    recordPostedVideo({
      video_id: video.id,
      source_url: video.url,
      source_name: video._sourceName,
      page_name: PAGE_ARG,
      niche: PAGE_ARG,
      posted_at: new Date().toISOString(),
      scheduled_at: scheduledAt,
      pfm_post_id: postId,
      topic_score: verdict.score,
      video_title: video.title,
      video_duration: video.duration,
      file_size_mb: sizeMB,
    });
    success++;

    try { unlinkSync(raw); } catch {}
    try { unlinkSync(processed); } catch {}
    if (i < toProcess.length - 1) await sleep(3000);
  } catch (e) {
    log(`   ❌ Error: ${e.message?.slice(0, 150)}`);
    // do NOT record — transient failures should allow retry next run
  }
}
```

**Current state of `uploadAndPost`** (line 331-342 of `reels.mjs`): returns `postId` only. Internally computes `scheduledAt` string (line 334-335) then passes it to `poster.scheduleFacebook()`. Update to return `{ postId, scheduledAt }` — one extra field, no behavior change. `sizeMB` is read directly in the main loop via `statSync(processed).size`.

### 8.2 Crucial semantic decisions

| Scenario | Current behavior | New behavior | Reason |
|----------|------------------|--------------|--------|
| Video posted successfully | `processed_ids.push(id)` | `recordPostedVideo(...)` to SQLite | Permanent + cross-page |
| Download fails | `processed_ids.push(id)` (never retry) | **No record** — retry next run | Transient failures should retry (disk full, yt-dlp hiccup) |
| FFmpeg fails | `processed_ids.push(id)` | **No record** — retry next run | Same — transient (CDP timeout, chrome crash) |
| Classifier says off-topic | N/A | **No record** — let other pages try | A video off-topic for `thoi_trang` may be on-topic for `bach_hoa` |
| Video size < 0.5MB (existing rule) | `processed_ids.push(id)` | **No record** | Aligns with "record-on-success" principle. Cost: a short video may be re-downloaded on subsequent runs until it rolls off the `--playlist-end 5` window (creator posts 5+ newer videos). In practice bounded to <1 week of waste per video. Acceptable vs adding a separate failure-cache mechanism. |
| Exception in loop body | `processed_ids.push(id)` | **No record** | Error recovery — retry instead of silently blocking |

This is a **semantic shift**: we move from "mark-as-seen" to "record-on-success". The SQLite table represents videos that actually went to Facebook, not videos we looked at.

## 9. Migration

### 9.1 One-shot script `scripts/migrate-processed-json-to-sqlite.mjs`

```js
import "../src/env.js";
import { readFileSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { getDb } from "../src/db.js";

const db = getDb();
const REELS_DIR = "./data/shopee/reels";

const stmt = db.prepare(`
  INSERT OR IGNORE INTO posted_reels
    (video_id, source_url, source_name, page_name, niche, posted_at, topic_score, video_title)
  VALUES (?, '', 'legacy_migration', ?, ?, ?, NULL, NULL)
`);

const dirs = readdirSync(REELS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith("_"));

let migrated = 0, pages = 0;
const tx = db.transaction(() => {
  for (const d of dirs) {
    const file = join(REELS_DIR, d.name, "processed.json");
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      const ts = data.last_check || new Date().toISOString();
      for (const id of data.processed_ids || []) {
        stmt.run(id, d.name, d.name, ts);
        migrated++;
      }
      renameSync(file, file + ".migrated.bak");
      pages++;
    } catch (e) {
      console.error(`Skip ${d.name}: ${e.message}`);
    }
  }
});
tx();

console.log(`Migrated ${migrated} entries across ${pages} pages`);
```

Run once:
```bash
node scripts/migrate-processed-json-to-sqlite.mjs
```

Notes:
- `INSERT OR IGNORE` — if same video_id exists across multiple page JSONs, first wins.
- `source_url`, `source_name`, `topic_score`, `video_title` = null/empty for legacy entries (we don't have this data). Intent is preservation of "don't re-post", not full audit trail.
- JSON files renamed to `.migrated.bak` — safety net, can be deleted after 30 days.

### 9.2 Current scale

8 pages × 8-13 entries = ~76 rows. Migration runs in <1 second.

## 10. Error handling

| Failure point | Behavior |
|---|---|
| Gemini API error (network, quota, timeout) | `classifyRelevance` returns `{match: true, score: 0.5, reason: "error: ..."}` — fail-open. Logged to stderr. |
| SQLite open fails | `getDb()` throws. Worker exits (same as today — DB is core dependency). |
| `recordPostedVideo` throws | Propagates up, caught by outer try/catch, logged — but **post has already gone out** to PostForMe. Next run may attempt to re-post (dedup not recorded). Mitigation: `INSERT OR IGNORE` in helper + logged warning suffices in practice. If this becomes a real issue, add explicit retry-with-backoff in helper. |
| Missing `topic` field for a page | Throw at worker startup. Fails fast — operator fixes `config.mjs`. |
| `uploadAndPost` doesn't return `scheduledAt` | Change return from `postId` to `{ postId, scheduledAt }`. `sizeMB` is read via `statSync()` in the main loop — doesn't need to thread through `uploadAndPost`. |
| All MAX*5 candidates rejected as off-topic | Pipeline reports 0 Reels for that page — same behavior as today when all candidates are too short. Operator fixes by adjusting `topic` wording or adding more sources. No automatic recovery. |

## 11. Testing

### 11.1 Unit test `reels-classifier.mjs`

Fixtures (known-correct verdicts from 2026-04-19 bugs):

| video | topic | expected |
|-------|-------|----------|
| `{title: "Đoán tên người nổi tiếng: Sao mà gợi ý xong lú luôn =)))", source_name: "Schannel"}` | `tech` | `match=false, score<0.5` |
| `{title: "Thử thách lắc chai nước ngẫu nhiên cùng các mẫu nhí", source_name: "BYB Academy"}` | `thoi_trang` | `match=false, score<0.5` |
| `{title: "Camera giám sát năng lượng mặt trời đang được miễn phí 4K", source_name: "Anh Vũ Trọc"}` | `gia_dung` | `match=true, score>0.7` |
| `{title: "Vợ chồng cô quẩyyy cỡ nàyyyy @Mèo Trái Đất #ngocmatcha", source_name: "Ngọc Matcha"}` | `thoi_trang` | borderline — accept either, log result |

### 11.2 Dry-run flag `--dry-run-classify`

Add to `reels.mjs`: scrape 1 source, run classifier on 5 candidates, print verdicts, exit. No download/upload.

```bash
node src/shopee/reels.mjs --page tech --dry-run-classify
```

### 11.3 Live slot verification

Run `daily-reels.mjs` with custom window covering only 2 problem pages (`tech` + `thoi_trang`), verify:
- Off-topic today's bugs are skipped with log line `⏭️ Off-topic (score=X): reason`.
- Pipeline proceeds to next candidate and posts.
- `posted_reels` table has new entries with `topic_score > 0.7`.

### 11.4 Persistence check

```sql
SELECT page_name, COUNT(*) AS n, MAX(posted_at) AS latest
FROM posted_reels GROUP BY page_name ORDER BY n DESC;
```

Cross-check numbers vs `Posted X Reels` lines in daily-reels summary log.

## 12. Rollout sequence

1. Implement schema + helpers in `src/db.js`.
2. Implement `src/shopee/reels-classifier.mjs`.
3. Add `topic` field to 8 `PAGES` entries in `src/shopee/config.mjs`.
4. Write and run migration script.
5. Modify `src/shopee/reels.mjs` (integration). May require tweaking `uploadAndPost` return value.
6. Run unit tests + dry-run-classify on 2-3 pages.
7. Run 1 live slot (all 8 pages) with schedule in near-future window.
8. If pass → commit all files + migration script. Delete `*.migrated.bak` files after 1 week.

## 13. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Gemini misclassifies on-topic videos as off-topic (false positive) → pages post 0 Reels | Fail-open on API error; strict threshold 0.7 (not 0.8+); monitor log counts; adjust topic descriptions if a niche shows high skip rate |
| Topic descriptions too strict/loose → constant threshold tuning | Start with drafts in §6.3; iterate based on 1 week of live data |
| SQLite contention with 8 parallel workers | Already using WAL mode (`_db.pragma("journal_mode = WAL")` in `db.js:16`) — handles concurrent writes |
| Migration loses data | JSON files renamed to `.bak`, not deleted. `INSERT OR IGNORE` preserves first-seen |
| Classifier latency (~1-2s/call) adds 8-15s per slot | Sequential within a page worker (8 parallel workers still) — acceptable. Could parallelize candidate classification within worker if needed (future) |
| Gemini quota exhaustion | 120 calls/day is well under free tier (1500 RPD for 2.0-flash) |

## 14. Future work (out of scope)

- **Classification of TikTok Tuệ Đàm output** — currently uses quote dedup only; AI-generated content on-topic by construction.
- **Multimodal classification** (add first frame) if text-only shows weakness.
- **Automatic topic description improvement** — collect misclassifications, feed to Claude to suggest topic refinements.
- **Dashboard** — simple web UI querying `posted_reels` for source health + content variety stats.
- **Cross-niche video reuse strategy** — a video off-topic for niche A but on-topic for niche B could be proactively offered to B instead of waiting for rotation. Would require a persistent "candidate pool" queue.
