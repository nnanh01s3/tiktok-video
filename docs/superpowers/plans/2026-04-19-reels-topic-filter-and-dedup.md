# Reels Topic Filter + Permanent Cross-Page Dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent off-topic videos from being scheduled to FB pages, and guarantee no video is ever posted twice across any page.

**Architecture:** Add SQLite `posted_reels` table to `data/content.db` as global blocklist (keyed by source video_id). Add Gemini Flash text classifier that scores video title+source against a per-page `topic` description; skip when score < 0.7. Wire both into `src/shopee/reels.mjs` candidate loop, replacing the lossy per-page `processed.json` files.

**Tech Stack:** Node.js ESM, `better-sqlite3` (already in deps), `@google/genai` (already in deps), `node:assert` for verification scripts (project doesn't use a test framework — uses `scripts/verify-*.js` convention).

**Spec:** `docs/superpowers/specs/2026-04-19-reels-topic-filter-and-dedup-design.md`

---

## File Structure

**Create:**
- `src/shopee/reels-classifier.mjs` — `classifyRelevance(video, topic)` — Gemini Flash call
- `scripts/verify-db-posted-reels.mjs` — verify schema + helpers work (replaces unit test)
- `scripts/verify-classifier.mjs` — verify classifier on 4 known cases (replaces unit test)
- `scripts/migrate-processed-json-to-sqlite.mjs` — one-shot data migration

**Modify:**
- `src/db.js` — add `posted_reels` schema in `initSchema()`, add 3 helpers: `isVideoPosted`, `recordPostedVideo`, `getPostedStats`
- `src/shopee/config.mjs` — add `topic: "..."` field to all 8 entries in `PAGES`
- `src/shopee/reels.mjs` — main integration:
  - Replace `loadProcessed/saveProcessed` calls with SQLite helpers
  - Add classifier gate before download
  - Change `uploadAndPost` return to `{ postId, scheduledAt }`
  - Remove mark-on-skip semantics; record only on success

---

## Task 1: SQLite schema + helpers in `src/db.js`

**Files:**
- Modify: `src/db.js` — add schema statement, 3 new exported functions
- Create: `scripts/verify-db-posted-reels.mjs` — test fixture

- [ ] **Step 1.1: Write verification script (expected to fail)**

Create `scripts/verify-db-posted-reels.mjs`:

```js
import "../src/env.js";
import assert from "node:assert/strict";
import { getDb, isVideoPosted, recordPostedVideo, getPostedStats } from "../src/db.js";

// Use a temp DB to avoid polluting production
process.env.DB_PATH = "./data/_test_posted_reels.db";
try { (await import("node:fs")).unlinkSync(process.env.DB_PATH); } catch {}

const db = getDb();

// 1. Schema exists
const cols = db.prepare("PRAGMA table_info(posted_reels)").all();
assert.ok(cols.length >= 10, `expected >=10 columns, got ${cols.length}`);
const colNames = cols.map((c) => c.name);
for (const required of ["video_id", "source_url", "page_name", "niche", "posted_at", "pfm_post_id", "topic_score"]) {
  assert.ok(colNames.includes(required), `missing column: ${required}`);
}

// 2. isVideoPosted returns false for unknown id
assert.equal(isVideoPosted("nonexistent_id"), false);

// 3. recordPostedVideo inserts
recordPostedVideo({
  video_id: "test_123",
  source_url: "https://www.tiktok.com/@x/video/test_123",
  source_name: "Test Source",
  page_name: "tech",
  posted_at: new Date().toISOString(),
  pfm_post_id: "sp_test",
  topic_score: 0.85,
  video_title: "Test video",
});

// 4. isVideoPosted returns true after insert
assert.equal(isVideoPosted("test_123"), true);

// 5. INSERT OR IGNORE — second insert does not throw
recordPostedVideo({
  video_id: "test_123",
  source_url: "different",
  page_name: "shopee",
  posted_at: new Date().toISOString(),
});

// 6. getPostedStats returns aggregate
const stats = getPostedStats();
assert.ok(Array.isArray(stats));
assert.ok(stats.some((s) => s.page_name === "tech"));

console.log("✅ All verify-db-posted-reels checks passed");
```

- [ ] **Step 1.2: Run script to verify it fails**

Run: `node scripts/verify-db-posted-reels.mjs`
Expected: error — helpers not exported from `src/db.js` (likely `TypeError: isVideoPosted is not a function`).

- [ ] **Step 1.3: Add schema to `initSchema()` in `src/db.js`**

In `src/db.js`, locate `initSchema(db)` function (around line 22). Add the following `CREATE TABLE` at the end of the first `db.exec()` call (before the `// --- Migrations ---` comment):

```sql
CREATE TABLE IF NOT EXISTS posted_reels (
  video_id       TEXT PRIMARY KEY,
  source_url     TEXT NOT NULL,
  source_name    TEXT,
  page_name      TEXT NOT NULL,
  niche          TEXT NOT NULL,
  posted_at      TEXT NOT NULL,
  scheduled_at   TEXT,
  pfm_post_id    TEXT,
  topic_score    REAL,
  video_title    TEXT,
  video_duration INTEGER,
  file_size_mb   REAL
);

CREATE INDEX IF NOT EXISTS idx_posted_reels_page_date
  ON posted_reels(page_name, posted_at);
CREATE INDEX IF NOT EXISTS idx_posted_reels_source
  ON posted_reels(source_name);
```

- [ ] **Step 1.4: Add 3 exported helpers to `src/db.js`**

Append these functions at the end of `src/db.js` (after `closeDb`):

```js
// --- posted_reels helpers (cross-page permanent blocklist) ---

export function isVideoPosted(videoId) {
  if (!videoId) return false;
  const db = getDb();
  return Boolean(
    db.prepare("SELECT 1 FROM posted_reels WHERE video_id = ?").get(videoId)
  );
}

export function recordPostedVideo(entry) {
  if (!entry?.video_id || !entry?.page_name || !entry?.posted_at) {
    throw new Error("recordPostedVideo: video_id, page_name, posted_at required");
  }
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
  return db
    .prepare(
      `SELECT page_name, COUNT(*) AS n, MAX(posted_at) AS latest
       FROM posted_reels GROUP BY page_name ORDER BY n DESC`
    )
    .all();
}
```

- [ ] **Step 1.5: Run verification script, expect pass**

Run: `node scripts/verify-db-posted-reels.mjs`
Expected: `✅ All verify-db-posted-reels checks passed`

- [ ] **Step 1.6: Clean up test DB + commit**

```bash
rm -f data/_test_posted_reels.db
git add src/db.js scripts/verify-db-posted-reels.mjs
git commit -m "Add posted_reels table + dedup helpers in db.js"
```

---

## Task 2: Gemini Flash classifier module

**Files:**
- Create: `src/shopee/reels-classifier.mjs`
- Create: `scripts/verify-classifier.mjs`

- [ ] **Step 2.1: Write verification script (expected to fail)**

Create `scripts/verify-classifier.mjs`:

```js
import "../src/env.js";
import assert from "node:assert/strict";
import { classifyRelevance } from "../src/shopee/reels-classifier.mjs";

const TECH_TOPIC = "Review điện thoại, laptop, tai nghe, smartwatch, camera, app công nghệ, so sánh spec, unboxing gadget, thủ thuật iOS/Android. KHÔNG bao gồm: game show đoán đồ/đoán người, trivia địa lý/lịch sử, challenge giải trí, lắc chai nước.";

const GIA_DUNG_TOPIC = "Đồ gia dụng, thiết bị nhà bếp, nồi chiên không dầu, máy xay, smart home, mẹo dọn dẹp, tips làm bếp, organize tủ lạnh, dọn nhà. KHÔNG bao gồm: review điện thoại, vlog gia đình, content trẻ em thuần.";

const THOI_TRANG_TOPIC = "OOTD, outfit styling, phối đồ, xu hướng thời trang, try-on haul, phụ kiện (túi, giày, trang sức), street style, diễn show. KHÔNG bao gồm: challenge lắc chai, game trẻ em, gia đình vlog thuần, skincare.";

const cases = [
  {
    name: "Schannel game show → tech (expect OFF-TOPIC)",
    video: {
      id: "test_1",
      title: "Đoán tên người nổi tiếng: Sao mà gợi ý xong lú luôn =))) #schannel #xuhuong",
      duration: 60,
      source_name: "Schannel",
    },
    topic: TECH_TOPIC,
    expectMatch: false,
  },
  {
    name: "BYB challenge → thoi_trang (expect OFF-TOPIC)",
    video: {
      id: "test_2",
      title: "Thử thách lắc chai nước ngẫu nhiên cùng các mẫu nhí #bybacademy",
      duration: 45,
      source_name: "BYB Academy VN",
    },
    topic: THOI_TRANG_TOPIC,
    expectMatch: false,
  },
  {
    name: "Anh Vũ Trọc camera → gia_dung (expect ON-TOPIC)",
    video: {
      id: "test_3",
      title: "Camera giám sát năng lượng mặt trời đang được miễn phí 4K ống kính HD",
      duration: 60,
      source_name: "Anh Vũ Trọc",
    },
    topic: GIA_DUNG_TOPIC,
    expectMatch: true,
  },
];

let passed = 0;
for (const c of cases) {
  const verdict = await classifyRelevance(c.video, c.topic);
  const ok = verdict.match === c.expectMatch;
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${c.name}`);
  console.log(`   → match=${verdict.match} score=${verdict.score.toFixed(2)} reason="${verdict.reason}"`);
  if (ok) passed++;
}

assert.equal(passed, cases.length, `${cases.length - passed} classification case(s) failed`);
console.log(`\n✅ All ${cases.length} classifier verification cases passed`);
```

- [ ] **Step 2.2: Run script to verify it fails**

Run: `node scripts/verify-classifier.mjs`
Expected: `ERR_MODULE_NOT_FOUND` — `src/shopee/reels-classifier.mjs` does not exist.

- [ ] **Step 2.3: Implement classifier**

Create `src/shopee/reels-classifier.mjs`:

```js
/**
 * Reels content relevance classifier.
 *
 * Uses Gemini 2.0 Flash to score whether a video (title + source metadata)
 * matches a page's topic description. Fails open on API errors so outages
 * don't block the whole pipeline.
 */
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM = `Bạn là content moderator cho 1 fanpage Facebook. Nhiệm vụ: đánh giá video có đúng chủ đề fanpage không.

Trả về JSON EXACTLY theo schema:
{"match": true|false, "score": 0.0-1.0, "reason": "giải thích ngắn tiếng Việt"}

Quy tắc:
- score >= 0.7 → match=true (đúng chủ đề, có thể post)
- score < 0.7 → match=false (lệch chủ đề, bỏ qua)
- "reason" TỐI ĐA 20 từ, tiếng Việt
- Đọc kỹ phần "KHÔNG bao gồm" của chủ đề — video rơi vào các pattern đó phải match=false dù source có vẻ đúng niche`;

/**
 * @param {{id?: string, title?: string, duration?: number, source_name?: string}} video
 * @param {string} topic - PAGES[pageName].topic
 * @returns {Promise<{match: boolean, score: number, reason: string}>}
 */
export async function classifyRelevance(video, topic) {
  if (!topic) return { match: true, score: 0.5, reason: "no topic defined" };

  const prompt = `CHỦ ĐỀ FANPAGE: ${topic}

VIDEO CẦN ĐÁNH GIÁ:
- Title/caption: "${(video.title || "(no title)").slice(0, 300)}"
- Source: ${video.source_name || "unknown"}
- Duration: ${video.duration || "?"}s

Video này có đúng chủ đề fanpage không?`;

  try {
    const res = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM,
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });
    const text = res.text || res.response?.text?.() || "";
    const json = JSON.parse(text);
    return {
      match: Boolean(json.match),
      score: typeof json.score === "number" ? json.score : 0,
      reason: String(json.reason || "").slice(0, 200),
    };
  } catch (e) {
    // Fail-open: don't block pipeline on classifier error
    console.error(`[classifier] Error: ${(e.message || String(e)).slice(0, 150)}`);
    return { match: true, score: 0.5, reason: `classifier error: ${(e.message || "").slice(0, 80)}` };
  }
}
```

- [ ] **Step 2.4: Run verification script**

Run: `node scripts/verify-classifier.mjs`
Expected:
```
✅ Schannel game show → tech (expect OFF-TOPIC)
   → match=false score=0.XX reason="..."
✅ BYB challenge → thoi_trang (expect OFF-TOPIC)
   → match=false score=0.XX reason="..."
✅ Anh Vũ Trọc camera → gia_dung (expect ON-TOPIC)
   → match=true score=0.XX reason="..."

✅ All 3 classifier verification cases passed
```

If any case fails: re-read the topic wording of the failing case in §6.3 of the spec — likely needs tightening (add more explicit "KHÔNG bao gồm" examples). Do NOT lower the threshold; adjust the topic.

- [ ] **Step 2.5: Commit**

```bash
git add src/shopee/reels-classifier.mjs scripts/verify-classifier.mjs
git commit -m "Add Gemini Flash classifier for Reels topic relevance"
```

---

## Task 3: Topic descriptions in `src/shopee/config.mjs`

**Files:**
- Modify: `src/shopee/config.mjs` — add `topic` to all 8 `PAGES` entries

- [ ] **Step 3.1: Locate PAGES object**

Open `src/shopee/config.mjs`. Find the `PAGES` constant/export. It currently has entries like:

```js
shopee: { fbId: "...", categories: null, provider: "postfast", ... },
```

- [ ] **Step 3.2: Add `topic` field to each of 8 pages**

For each of the 8 page entries (`shopee`, `gia_dung`, `tech`, `sac_dep`, `thoi_trang`, `me_be`, `the_thao`, `bach_hoa`), add a `topic` field. Exact strings to use (copy verbatim):

```js
shopee: {
  // ... existing fields ...
  topic: "Đồ độc lạ, gadget thú vị, dụng cụ sáng tạo, phát minh tiện ích, unboxing sản phẩm không phổ biến. Bao gồm: mẹo vặt với dụng cụ, demo sản phẩm mới. KHÔNG bao gồm: game show, challenge trẻ em, trivia địa lý/lịch sử, vlog cá nhân.",
},

gia_dung: {
  // ... existing fields ...
  topic: "Đồ gia dụng, thiết bị nhà bếp, nồi chiên không dầu, máy xay, smart home, mẹo dọn dẹp, tips làm bếp, organize tủ lạnh, dọn nhà. KHÔNG bao gồm: review điện thoại, vlog gia đình, content trẻ em thuần.",
},

tech: {
  // ... existing fields ...
  topic: "Review điện thoại, laptop, tai nghe, smartwatch, camera, app công nghệ, so sánh spec, unboxing gadget, thủ thuật iOS/Android. KHÔNG bao gồm: game show đoán đồ/đoán người, trivia địa lý/lịch sử, challenge giải trí, lắc chai nước.",
},

sac_dep: {
  // ... existing fields ...
  topic: "Skincare, mỹ phẩm, routine dưỡng da, makeup tutorial, review sản phẩm làm đẹp, son môi, kem chống nắng, serum, retinol, livestream sale mỹ phẩm. KHÔNG bao gồm: thời trang outfit, gadget, ẩm thực.",
},

thoi_trang: {
  // ... existing fields ...
  topic: "OOTD, outfit styling, phối đồ, xu hướng thời trang, try-on haul, phụ kiện (túi, giày, trang sức), street style, diễn show. KHÔNG bao gồm: challenge lắc chai, game trẻ em, gia đình vlog thuần, skincare.",
},

me_be: {
  // ... existing fields ...
  topic: "Chăm con, mẹ bỉm sữa, review đồ mẹ & bé (bỉm, sữa, xe đẩy), tips nuôi con, dạy con học, vlog gia đình có trẻ nhỏ, review sách thiếu nhi. KHÔNG bao gồm: content người lớn, tech review, outfit adult.",
},

the_thao: {
  // ... existing fields ...
  topic: "Tập gym, workout tại nhà, yoga, cardio, kỹ thuật tập tạ, transformation trước-sau, tips giảm cân, fitness outdoor, chạy bộ, đồ tập. KHÔNG bao gồm: bóng ma hạnh phúc (trend), dance cover, vlog ăn uống thuần.",
},

bach_hoa: {
  // ... existing fields ...
  topic: "Tin tức đời sống, tips tiêu dùng, review sản phẩm thiết yếu, sách hay nên đọc, mẹo học tập, trending social, kinh tế - giá cả. KHÔNG bao gồm: nội dung nhạy cảm (drama tình cảm, chính trị cực đoan), adult content.",
},
```

- [ ] **Step 3.3: Verify all 8 pages have `topic`**

Run this one-liner to verify:
```bash
node -e "import('./src/shopee/config.mjs').then(m => { const miss = Object.entries(m.PAGES).filter(([k,v]) => !v.topic || typeof v.topic !== 'string' || v.topic.length < 30); if (miss.length) { console.error('Missing topic on:', miss.map(([k]) => k)); process.exit(1); } else { console.log('✅ All', Object.keys(m.PAGES).length, 'pages have topic'); } })"
```

Expected: `✅ All 8 pages have topic` (or however many are in PAGES).

- [ ] **Step 3.4: Commit**

```bash
git add src/shopee/config.mjs
git commit -m "Add topic description to each FB page for classifier"
```

---

## Task 4: Migration script (legacy JSON → SQLite)

**Files:**
- Create: `scripts/migrate-processed-json-to-sqlite.mjs`

- [ ] **Step 4.1: Write the migration script**

Create `scripts/migrate-processed-json-to-sqlite.mjs`:

```js
/**
 * One-shot: migrate data/shopee/reels/<page>/processed.json files into
 * the new posted_reels SQLite table, then rename JSON files to .migrated.bak.
 *
 * Safe to re-run — uses INSERT OR IGNORE.
 */
import "../src/env.js";
import { readFileSync, readdirSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { getDb } from "../src/db.js";

const REELS_DIR = "./data/shopee/reels";
if (!existsSync(REELS_DIR)) {
  console.error(`Not found: ${REELS_DIR}`);
  process.exit(1);
}

const db = getDb();
const stmt = db.prepare(`
  INSERT OR IGNORE INTO posted_reels
    (video_id, source_url, source_name, page_name, niche, posted_at, topic_score, video_title)
  VALUES (?, '', 'legacy_migration', ?, ?, ?, NULL, NULL)
`);

const dirs = readdirSync(REELS_DIR, { withFileTypes: true }).filter(
  (d) => d.isDirectory() && !d.name.startsWith("_")
);

let migrated = 0;
let pages = 0;
const skipped = [];

const tx = db.transaction(() => {
  for (const d of dirs) {
    const file = join(REELS_DIR, d.name, "processed.json");
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      const ts = data.last_check || new Date().toISOString();
      for (const id of data.processed_ids || []) {
        if (!id) continue;
        stmt.run(String(id), d.name, d.name, ts);
        migrated++;
      }
      renameSync(file, file + ".migrated.bak");
      pages++;
    } catch (e) {
      skipped.push({ page: d.name, err: e.message });
    }
  }
});
tx();

console.log(`✅ Migrated ${migrated} entries across ${pages} pages`);
if (skipped.length) {
  console.log(`⚠️  Skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`    ${s.page}: ${s.err}`);
}
```

- [ ] **Step 4.2: Run migration on current data**

Run: `node scripts/migrate-processed-json-to-sqlite.mjs`
Expected: `✅ Migrated ~76 entries across 8 pages` (exact count depends on current state).

- [ ] **Step 4.3: Verify SQLite state**

Run:
```bash
node -e "import('./src/db.js').then(m => console.table(m.getPostedStats()))"
```

Expected: table showing `page_name`, `n`, `latest` for each of 8 pages, totals ~76.

- [ ] **Step 4.4: Verify `.bak` files created**

Run: `ls data/shopee/reels/*/processed.json.migrated.bak 2>&1 | head`
Expected: 8 `.migrated.bak` files listed.

- [ ] **Step 4.5: Commit migration script**

```bash
git add scripts/migrate-processed-json-to-sqlite.mjs
git commit -m "Add migration script: processed.json -> posted_reels table"
```

Note: do NOT commit the `.bak` files or the DB (both gitignored).

---

## Task 5: Update `uploadAndPost` return value in `reels.mjs`

**Files:**
- Modify: `src/shopee/reels.mjs:331-342`

- [ ] **Step 5.1: Open reels.mjs, locate uploadAndPost**

Open `src/shopee/reels.mjs`. Lines 328-342 contain:

```js
// ── Step 5: Upload + schedule ─────────────────────────────────────────────
const poster = createPoster(PAGE);

async function uploadAndPost(videoPath, caption, delayMin) {
  const mediaRef = await poster.upload(videoPath);
  log(`   ✅ Uploaded: ${mediaRef.slice(0, 60)}`);
  const scheduledAt = new Date(Date.now() + delayMin * 60_000)
    .toISOString();

  const result = await poster.scheduleFacebook({ mediaRef, caption, scheduledAt });
  const postId = result.postId || result.postIds?.[0];
  log(`   ✅ FB Scheduled: ${scheduledAt} | PostID: ${postId}`);
  return postId;
}
```

- [ ] **Step 5.2: Change return to `{ postId, scheduledAt }`**

Replace line `return postId;` with `return { postId, scheduledAt };`.

Final function:
```js
async function uploadAndPost(videoPath, caption, delayMin) {
  const mediaRef = await poster.upload(videoPath);
  log(`   ✅ Uploaded: ${mediaRef.slice(0, 60)}`);
  const scheduledAt = new Date(Date.now() + delayMin * 60_000)
    .toISOString();

  const result = await poster.scheduleFacebook({ mediaRef, caption, scheduledAt });
  const postId = result.postId || result.postIds?.[0];
  log(`   ✅ FB Scheduled: ${scheduledAt} | PostID: ${postId}`);
  return { postId, scheduledAt };
}
```

- [ ] **Step 5.3: Find the caller and update destructuring**

Locate the line (currently around line 421):
```js
await uploadAndPost(processed, caption, DELAY + i * 2);
```

Change to:
```js
const { postId, scheduledAt } = await uploadAndPost(processed, caption, DELAY + i * 2);
```

(We'll actually use `postId` and `scheduledAt` in Task 7.)

- [ ] **Step 5.4: Quick syntax sanity check**

Run: `node -e "import('./src/shopee/reels.mjs').catch(e => { if (!e.message.includes('Missing argument')) throw e; console.log('✅ module loads (arg error expected)'); })"`

Expected: `✅ module loads` — we expect the arg-validation error since we didn't pass `--page`, but the module should parse successfully.

- [ ] **Step 5.5: Do NOT commit yet**

This change is incomplete without Tasks 6–8. Stay on the working tree.

---

## Task 6: Replace `processed_ids` scrape filter with `isVideoPosted`

**Files:**
- Modify: `src/shopee/reels.mjs` — imports section, scrape loop (lines 355-383)

- [ ] **Step 6.1: Add new imports**

At the top of `src/shopee/reels.mjs` (near the existing `import` lines, after the `getUnusedQuotes` / other DB imports if present, otherwise right after the other `../db.js` imports):

```js
import { isVideoPosted, recordPostedVideo } from "../db.js";
import { classifyRelevance } from "./reels-classifier.mjs";
import { statSync } from "fs";
```

(Note: `statSync` may already be imported. Check existing `import ... from "fs"` line and merge if needed — don't create duplicate imports.)

- [ ] **Step 6.2: Replace `loadProcessed()` banner + call**

Find lines 356-357:
```js
const state = loadProcessed();
log(`📋 Đã xử lý: ${state.processed_ids.length} videos`);
```

Replace with:
```js
log(`📋 Dedup: SQLite posted_reels (global, cross-page)`);

// Topic description for this page — required for classifier.
// PAGES is already imported at the top of the file via:
//   import { PAGES, BASE_DIR, FFMPEG } from "./config.mjs";
// so use it directly — no dynamic import needed.
const topic = PAGES[PAGE_ARG]?.topic;
if (!topic) {
  log(`❌ No 'topic' defined for page '${PAGE_ARG}' in config.mjs PAGES — refusing to run`);
  process.exit(1);
}
```

- [ ] **Step 6.3: Replace `processed_ids.includes(v.id)` with SQLite check**

Find line 373 (inside the scrape loop):
```js
if (!state.processed_ids.includes(v.id)) {
```

Replace with:
```js
if (!isVideoPosted(v.id)) {
```

Find line 382 (count log):
```js
if (newVideos.length > 0) log(`   ➕ [${idx}] +${videos.filter(v => !state.processed_ids.includes(v.id)).length} new`);
```

Replace with:
```js
if (newVideos.length > 0) log(`   ➕ [${idx}] +${videos.filter(v => !isVideoPosted(v.id)).length} new`);
```

- [ ] **Step 6.4: Remove `saveProcessed` call on "no new videos" path**

Find lines 385-390:
```js
if (newVideos.length === 0) {
  log(`✅ Không có video mới từ ${triedSources.length} sources thử được.`);
  state.last_check = new Date().toISOString();
  saveProcessed(state);
  process.exit(0);
}
```

Replace with:
```js
if (newVideos.length === 0) {
  log(`✅ Không có video mới từ ${triedSources.length} sources thử được.`);
  process.exit(0);
}
```

- [ ] **Step 6.5: Dry-check — scrape phase runs without errors**

This can't be fully tested without running live against a source (yt-dlp call), but we can verify the page-topic guard works:

Run: `node src/shopee/reels.mjs --page nonexistent_page --max 1 --delay 1 2>&1 | head -5`
Expected: output includes `❌ No 'topic' defined for page 'nonexistent_page'` and exits with code 1.

- [ ] **Step 6.6: Do NOT commit yet**

Task 7 + 8 still needed. Stay on working tree.

---

## Task 7: Add classifier gate + remove mark-on-skip

**Files:**
- Modify: `src/shopee/reels.mjs` — candidate processing loop (lines 397-436)

- [ ] **Step 7.1: Replace the candidate loop body**

Find the current candidate processing loop (lines 397-436). Current code pushes `video.id` to `state.processed_ids` in multiple places (success path, download fail, FFmpeg fail, catch block). Replace the entire `for` loop with this new version:

```js
let success = 0;
for (let i = 0; i < toProcess.length; i++) {
  if (success >= MAX) break;
  const video = toProcess[i];
  log(`\n[${success + 1}/${MAX}] ${video._sourceName} — ${video.id}`);

  // ── Topic classifier gate (pre-download, skip off-topic) ──
  let verdict;
  try {
    verdict = await classifyRelevance(
      {
        id: video.id,
        title: video.title,
        duration: video.duration,
        source_name: video._sourceName,
      },
      topic
    );
  } catch (e) {
    // classifyRelevance itself swallows errors, but belt-and-suspenders
    log(`   ⚠ Classifier threw: ${e.message?.slice(0, 100)} — allow post`);
    verdict = { match: true, score: 0.5, reason: "classifier exception" };
  }

  if (!verdict.match) {
    log(`   ⏭️ Off-topic (score=${verdict.score.toFixed(2)}): ${verdict.reason}`);
    // Do NOT record — other pages might accept this video
    continue;
  }
  log(`   ✅ Topic match (score=${verdict.score.toFixed(2)})`);

  try {
    const raw = downloadVideo(video);
    if (!raw) {
      log("   ⏭️ Skip (download failed)");
      // No record — transient failure, retry next run
      continue;
    }

    const processed = join(OUT_DIR, `${video.id}_reel.mp4`);
    const ok = processVideo(raw, processed);
    if (!ok) {
      log("   ⏭️ Skip (FFmpeg failed)");
      try { unlinkSync(raw); } catch {}
      continue;
    }

    const caption = makeCaption(video.title, PAGE_ARG);
    log(`   📝 "${caption.slice(0, 80)}..."`);

    const { postId, scheduledAt } = await uploadAndPost(processed, caption, DELAY + i * 2);

    // ── Record ONLY on successful upload ──
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

    // Cleanup
    try { unlinkSync(raw); } catch {}
    try { unlinkSync(processed); } catch {}
    if (i < toProcess.length - 1) await sleep(3000);
  } catch (e) {
    log(`   ❌ Error: ${e.message?.slice(0, 150)}`);
    // No record — transient failures should retry next run
  }
}
```

- [ ] **Step 7.2: Remove trailing `saveProcessed` at end of main**

Find lines 438-439 (below the loop):
```js
state.last_check = new Date().toISOString();
saveProcessed(state);
```

**Delete both lines entirely.**

- [ ] **Step 7.3: Remove now-unused helpers and constants**

In `src/shopee/reels.mjs`, also remove:

1. The `const PROCESSED_FILE = join(OUT_DIR, "processed.json");` line (around line 65).
2. The `loadProcessed()` function (lines 79-82).
3. The `saveProcessed()` function (lines 84-86).

These are no longer called anywhere.

- [ ] **Step 7.4: Syntax sanity check**

Run: `node -c src/shopee/reels.mjs 2>&1` (check syntax only) — wait, `node -c` doesn't work for ESM the same way. Use:

```bash
node --check src/shopee/reels.mjs
```

Expected: no output (success), or explicit syntax error if something's broken.

- [ ] **Step 7.5: Do NOT commit yet**

Task 8 is the live smoke test.

---

## Task 8: Live smoke test — one problem page

**Files:**
- None modified. Run live against production with limited scope.

- [ ] **Step 8.1: Compute a near-future VN time window**

Run: `node -e "const d=new Date(); const vn=new Date(d.toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh'})); const start=new Date(vn.getTime()+3*60000); const end=new Date(vn.getTime()+18*60000); const fmt=(d)=>d.toTimeString().slice(0,5); console.log('--schedule-at', fmt(start), '--schedule-end', fmt(end));"`

Example output: `--schedule-at 14:23 --schedule-end 14:38`

- [ ] **Step 8.2: Run `tech` + `thoi_trang` only (2 bug-prone pages)**

Use the `--skip-page` flag to run only the 2 pages we care about. List all OTHER pages in `--skip-page`:

```bash
node src/daily-reels.mjs --skip-page shopee,gia_dung,sac_dep,me_be,the_thao,bach_hoa --schedule-at <START> --schedule-end <END>
```

(Substitute the actual `--schedule-at` / `--schedule-end` values from Step 8.1.)

- [ ] **Step 8.3: Inspect logs for the new signals**

In the output, look for these new log lines (should appear at least once each):

- `📋 Dedup: SQLite posted_reels (global, cross-page)` (instead of old "Đã xử lý: N videos")
- `✅ Topic match (score=0.XX)` OR `⏭️ Off-topic (score=0.XX): ...`

If you see `⏭️ Off-topic` followed by successful post of the NEXT candidate, that's the classifier working as designed.

- [ ] **Step 8.4: Verify SQLite updated**

After the run finishes, run:
```bash
node -e "import('./src/db.js').then(m => { const today = new Date().toISOString().slice(0,10); const rows = m.getDb().prepare(\"SELECT page_name, video_id, topic_score, source_name FROM posted_reels WHERE posted_at LIKE ? ORDER BY posted_at DESC LIMIT 10\").all(today + '%'); console.table(rows); })"
```

Expected: rows for `tech` and/or `thoi_trang` with non-null `topic_score` (indicates new-pipeline entries, distinguishable from `legacy_migration` entries which have null).

- [ ] **Step 8.5: Commit the integration if smoke test passes**

```bash
git add src/shopee/reels.mjs
git commit -m "Wire reels.mjs to use posted_reels SQLite + Gemini topic classifier

Replaces per-page processed.json dedup (lossy, 500-cap, per-page isolation)
with cross-page forever blocklist in SQLite. Adds pre-download topic
relevance check via Gemini Flash — skips candidates that are off-topic for
the page niche, falls through to next candidate.

Semantic shift: record on successful post only (not on skip/failure).
Transient failures retry on next run."
```

---

## Task 9: Full 8-page slot test (optional but recommended)

**Files:**
- None modified.

- [ ] **Step 9.1: Compute next slot window**

Pick the next upcoming natural slot (6:30, 11:30, or 18:00 VN — whichever is next). Or use `--schedule-at HH:MM --schedule-end HH+15:MM` for a custom window at least 5 minutes in the future.

- [ ] **Step 9.2: Run full daily-reels (all 8 pages)**

```bash
node src/daily-reels.mjs --schedule-at <HH:MM> --schedule-end <HH:MM>
```

- [ ] **Step 9.3: Verify summary**

Expected summary output (at end):
```
╔══════════════════════════════════════════════════╗
║                    SUMMARY                      ║
╚══════════════════════════════════════════════════╝
  ✅ <page>       1 Reel
  ... (8 rows)
```

Most/all pages should show 1 Reel. Some may show 0 Reels if ALL candidates were off-topic OR all too short — that's correct behavior (strict filter). Check logs for `⏭️ Off-topic` lines on 0-Reel pages — if they're there, the filter is working (just need to adjust topic wording or add sources for that niche).

- [ ] **Step 9.4: Cross-check SQLite totals**

```bash
node -e "import('./src/db.js').then(m => console.table(m.getPostedStats()))"
```

All 8 pages should have incremented counts vs Task 4 baseline (76 + new posts).

---

## Task 10: Clean up `.bak` files after observation period

**Files:**
- Delete: `data/shopee/reels/*/processed.json.migrated.bak`

- [ ] **Step 10.1: DO NOT do this immediately**

Keep the `.bak` files for at least 7 days in case we need to roll back. Do this task after observing 1 week of clean runs.

- [ ] **Step 10.2: After 7 days, verify no regressions and delete**

```bash
rm data/shopee/reels/*/processed.json.migrated.bak
```

No commit needed — `.bak` files are gitignored by default (or should be — verify with `git status`).

---

## Self-Review Checklist

Run through this after the plan is written:

**Spec coverage:**
- §5 Architecture → Tasks 1-7 ✅
- §6.1 Schema → Task 1 ✅
- §6.2 Helpers → Task 1 ✅
- §6.3 Topic descriptions → Task 3 ✅
- §7 Classifier module → Task 2 ✅
- §8.1 Integration code → Tasks 5, 6, 7 ✅
- §8.2 Semantic decisions → Task 7 (record-on-success only) ✅
- §9 Migration → Task 4 ✅
- §10 Error handling → Classifier fail-open in Task 2, guard in Task 6 ✅
- §11 Testing → Tasks 1, 2, 8, 9 ✅
- §12 Rollout → Task order matches §12 ✅

**Placeholder scan:** No TBD/TODO/placeholder in steps.

**Type consistency:**
- `classifyRelevance(video, topic)` returns `{match, score, reason}` — used consistently in Task 7
- `recordPostedVideo(entry)` signature matches across Task 1 and Task 7 call site
- `uploadAndPost` return `{postId, scheduledAt}` — Task 5 changes sig, Task 7 destructures
- `isVideoPosted(id) → boolean` — used in Task 6

Everything references concrete code with exact paths and line numbers.

---

## Execution notes

- **No test framework** → verification scripts (`scripts/verify-*.mjs`) are run ad-hoc, not via `npm test`. They use `node:assert` and exit code 0/1.
- **Gemini API key** must be set in `.env` for Tasks 2 and 7+ verification. If missing, Task 2 verification will fail with clear error.
- **WAL mode already enabled** in `db.js:16` — concurrent writes from 8 daily-reels workers are safe with SQLite.
- **Classifier calls are sequential** within a worker (one `await classifyRelevance` per candidate). 8 workers run in parallel → up to 8 concurrent Gemini calls max. Well under free tier.
- **Cost estimate**: ~120 classifier calls/day × $0.000075 ≈ $0.01/day = $0.30/month.
