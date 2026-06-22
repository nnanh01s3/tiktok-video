# Pipeline Stories Veo — Design Doc

**Date:** 2026-04-27
**Status:** Approved by user (sections 1-4 confirmed)
**Author:** Claude + nnanh01
**Related files:**
- New: `src/pipeline-stories-veo.js`
- Modify: `src/db.js` (add 2 helpers)
- Reference: `src/pipeline-quotes-veo.js`, `src/gemini-tts.js`, `src/veo.js`, `src/imagen.js`
- Reads: `data/content.db` table `content_library` (50 entries seeded)

## 1. Context

User wants to post **real-life inspirational stories** (Steve Jobs, Oprah, Nick Vujicic, Jack Ma, J.K. Rowling, etc.) as TikTok Reels, separate from the existing Tuệ Đàm philosophical quotes pipeline. Database table `content_library` already contains 50 verified entries (24 stories + 13 books + 13 concepts) seeded earlier but never had a posting pipeline built.

User question: "Tôi nhớ rằng chúng ta có những câu chuyện có thật về nghị lực này kia, có hay không?" — confirmed yes, content exists, asked to build pipeline (Option A, ~30-60 min code).

## 2. Goals

- **G1**: Post 1 verified real-life story to Tuệ Đàm TikTok account daily
- **G2**: Reuse existing infrastructure (Veo + Imagen + TTS + PostForMe) — no new SDKs
- **G3**: Respect celebrity-likeness limits in Imagen (no real face generation)
- **G4**: Strong, dramatic narration (voice = Puck, dynamic pacing)
- **G5**: Adaptive video length (3-6 acts, cap 180s) for narrative completeness without retention drop

## 3. Non-goals

- **No new TikTok account** — same Tuệ Đàm account `@trituemoingay.vn` (pfmTtId `spc_rbYFCtoEuLh8fa3ravla`)
- **No Wikipedia photo lookup** — abstract symbolic Imagen scenes only
- **No multi-part series** in v1 — single-post per story even if compressed
- **No native Veo audio** — keep Veo `fast` tier (free, no audio), audio mixed from Gemini TTS at compose step

## 4. User decisions captured (brainstorming)

| # | Question | Choice |
|---|----------|--------|
| 1 | TikTok account | **A — same Tuệ Đàm account** |
| 2 | Visual style | **A — abstract/symbolic Imagen** (no real photos) |
| 3 | Length | **A — adaptive 3-6 slides, cap 180s** |
| 4 | Voice | **Puck** (storyteller, upbeat, versatile) |

## 5. Architecture

```
content_library DB (50 entries)
        ↓
   pickStory(filters)         → least-used + oldest used_at first
        ↓
   genStoryDirector()         → Claude Sonnet 4 → JSON {scenes, hook, ...}
        ↓
   genVoiceover(Puck + style) → Gemini TTS → MP3
        ↓
   genVeoHook(8s)             → Veo 2.0 fast (free) → MP4 hook
        ↓
   generateScenes(N=3..6)     → Imagen 4 → MP4 clips with Ken Burns
        ↓
   composeVideo()             → FFmpeg xfade + audio mix
        ↓
   uploadAndPost()            → PostForMe → schedule TikTok
        ↓
   markStoryUsed()            → DB tracking
```

**Reuse from `pipeline-quotes-veo.js`** (~80% of code):
- `composeVideo()` (FFmpeg + xfade transitions)
- `generateScenes()` (Imagen + Ken Burns) — extend to support 3-6 scenes (currently fixed 4)
- Veo hook generation (8s with text-to-video)
- `genVoiceover()` integration
- `uploadAndPost()` (PostForMe TikTok schedule)
- Caption + hashtags structure
- Director script JSON parsing

**New code**:
- `pickStory(filters)` — DB query with least-used logic
- `genStoryDirector()` — Claude prompt for narrative arc (vs quote selection)
- Voice config override (Puck + custom style instruction vs Algenib default)
- DB helpers `getNextStory`, `markStoryUsed`

## 6. Story selection

### 6.1 Algorithm

```js
function pickStory(filters = {}) {
  if (filters.id) return db.prepare("SELECT * FROM content_library WHERE id = ?").get(filters.id);
  // Least-used first, break ties by oldest used_at (NULL treated as oldest)
  let sql = `SELECT * FROM content_library WHERE 1=1`;
  const params = [];
  if (filters.type) { sql += ` AND type = ?`; params.push(filters.type); }
  if (filters.category) { sql += ` AND category = ?`; params.push(filters.category); }
  sql += ` ORDER BY used_count ASC, COALESCE(used_at, '1970-01-01') ASC LIMIT 1`;
  return db.prepare(sql).all(...params)[0];
}
```

### 6.2 Why least-used (not day-of-year rotation)?

50 stories with day-of-year would have predictable cycle but uneven inventory: most stories have `used_count = 0` initially. Least-used naturally walks through all 50 entries first, then rotates oldest-used. After 50 days all entries have `used_count = 1`, then second cycle of 50 days bringing all to 2, etc. Each story used roughly evenly.

### 6.3 Filters via CLI

```bash
--story-id=4         # Force specific story (Nick Vujicic)
--type=story         # Only stories (skip books, concepts)
--type=book          # Only books
--type=concept       # Only concepts
--category="nghị lực"  # Only category match
```

## 7. Director script (Claude Sonnet 4)

### 7.1 Prompt

```
Bạn là director cho video kể chuyện 90-180s style Tuệ Đàm trên TikTok.

CÂU CHUYỆN:
- Tiêu đề: {title}
- Loại: {type} (story / book / concept)
- Danh mục: {category}
- Nội dung: {content_vi} ({wordCount} từ)
- Bài học: {lesson_vi}
- Quote (nếu có): "{quote_vi}" — {author}

TẠO JSON:
{
  "actCount": <integer 3-6, auto-pick>,
  "title": "<30-60 ký tự>",
  "hook": "<câu mở đầu 1-2 dòng gây tò mò mạnh>",
  "hookVeoPrompt": "<visual abstract symbolic prompt cho Veo 8s, KHÔNG name celebrity>",
  "scenes": [
    {
      "narration": "<60-100 từ>",
      "imagenPrompt": "<abstract scene description, KHÔNG name celebrity>",
      "duration": <25-35 seconds>
    }
    // 3-6 scenes total
  ],
  "endQuote": "<quote_vi nếu có, làm closing slide; null nếu không>"
}

LOGIC actCount:
- <250 từ → 3 scenes (~90s total)
- 250-400 từ → 4 scenes (~120s)
- 400-500 từ → 5 scenes (~150s)
- >500 từ → 6 scenes (~180s)
- Cap absolute 180s

QUY TẮC narration:
- Tone storyteller (voice = Puck): dynamic pacing, dramatic pauses
- Mở đầu hook strong (curiosity / emotional)
- Act 2-3 build tension (setback / conflict)
- Penultimate act = turning point / insight
- Final act = lesson + call to reflection (KHÔNG CTA bán hàng)
- KHÔNG dùng "đỉnh", "ghiền", "đỉnh của đỉnh" (overused)

QUY TẮC imagenPrompt:
- KHÔNG generate face/body của celebrity tên cụ thể (Imagen reject)
- Symbolic: empty office, growing pile of letters, sunrise on horizon
- Period-accurate: 1980s computer, vintage typewriter, monastery
- Cinematic: golden hour, dramatic shadow, slow camera dolly
- 9:16 vertical aspect, photorealistic OR painterly stylized

VÍ DỤ tốt cho story Steve Jobs:
- Scene 1 imagenPrompt: "1976 garage workshop with vintage Apple I prototype on workbench, dim lamp, two silhouettes working late at night, photorealistic, 9:16"
- Scene 2 imagenPrompt: "empty boardroom with single chair pushed back, paper scattered, blinds half-drawn, melancholy lighting, cinematic"
- Scene 3 imagenPrompt: "dawn light streaming into Apple Cupertino headquarters lobby, lone figure walking back through glass doors, hopeful golden hour"

Chỉ trả về JSON thuần, KHÔNG meta-comment.
```

### 7.2 Model

`claude-sonnet-4-5` (or current Sonnet) via existing `script-writer.js` infrastructure. Cost: ~$0.02/post.

## 8. Voiceover (Gemini TTS)

### 8.1 Config

```js
generateVoiceover(scriptText, outputPath, {
  voice: "Puck",  // GEMINI_VOICES.storyteller
  style: "Tell this story with passion and dynamic pacing. " +
         "Slow at reflection, faster during action. " +
         "Use dramatic pauses before key reveals. " +
         "Build emotional crescendo to the turning point. " +
         "Convey both struggle and triumph in your delivery."
});
```

### 8.2 Why Puck (vs Tuệ Đàm's Algenib)?

| Voice | Personality | Stories fit |
|-------|-------------|-------------|
| Algenib (Tuệ Đàm) | Gravelly, deep, mature | ✅ Reflective philosophy |
| **Puck** (new for stories) | **Upbeat, versatile, storyteller** | ✅✅ Dynamic narrative |
| Orus | Firm, decisive | ✅ Powerful but rigid |
| Sadaltager | Wise, authoritative | ✅ Sage tone |

User explicitly chose Puck. Storyteller versatility supports the dynamic pacing required for narrative arcs (intro calm → conflict tense → climax dramatic → resolution warm).

### 8.3 Fallback

Same fallback chain as Tuệ Đàm: Gemini TTS Puck → Edge TTS `vi-VN-NamMinhNeural` if Gemini fails. Edge fallback loses Puck timbre but preserves narration content.

## 9. Veo + Imagen visual generation

### 9.1 Veo hook (8s)

- **Model**: `veo-2.0-generate-001` (`fast` tier, free, no audio)
- **Prompt source**: `directorJson.hookVeoPrompt`
- **Output**: 8s vertical 9:16 MP4 with no audio (audio mixed from voiceover later)
- **Why fast tier**: free, no upgrade needed. Stories don't need lip-sync (voice-over narration, no character speaking on screen).

### 9.2 Imagen scenes (3-6 clips)

- **Model**: `imagen-4.0-generate-001` (existing `imagen.js`)
- **Per scene**: 1 image → Ken Burns effect (zoom/pan) → 25-35s MP4 clip
- **Effect rotation**: zoom_in_center, parallax_zoom_out, zoom_pan_right, etc. (existing 8 effects in `composeVideo`)
- **Variable count**: Pipeline currently hardcodes 4 scenes; **need to extend `generateScenes()` to accept 3-6**.

### 9.3 Critical change in `generateScenes()`

Current (in pipeline-quotes-veo.js):
```js
async function generateScenes(quotes, jobId) {
  // Always 4 quotes → always 4 scenes
  for (let i = 0; i < quotes.length; i++) { ... }
}
```

New (in pipeline-stories-veo.js):
```js
async function generateScenes(scenes, jobId) {
  // Variable count 3-6
  for (let i = 0; i < scenes.length; i++) { ... }
}
```

Just take an array — already works dynamically. Verify ffmpeg compose handles variable count (xfade chain needs N-1 transitions).

## 10. Compose video

### 10.1 Structure

```
[title slide 1.5s] → xfade dissolve → [Veo hook 8s] → xfade circleopen
   → [Scene 1 ~25-35s] → xfade smoothup → [Scene 2] → ...
   → [Scene N-1] → xfade smoothup → [Scene N (lesson + endQuote if any)]
```

Total = 1.5 + 8 + N×(25-35) seconds. For N=3: ~85s. For N=6: ~175s. Cap 180s.

### 10.2 endQuote handling

If story has `quote_vi`, the LAST scene becomes a quote slide:
- Scene N text overlay = quote_vi (large, centered)
- Scene N image = abstract calm landscape (matches reflective tone)
- Scene N narration = the lesson + quote read aloud

If no quote_vi, last scene is normal "lesson summary" act.

## 11. DB tracking

### 11.1 New helpers in `src/db.js`

```js
export function getNextStory(filters = {}) {
  const db = getDb();
  let sql = `SELECT id, type, title, category, content_vi, lesson_vi, quote_vi, author,
                    metadata, used_count
             FROM content_library WHERE 1=1`;
  const params = [];
  if (filters.id) { sql += ` AND id = ?`; params.push(filters.id); }
  if (filters.type) { sql += ` AND type = ?`; params.push(filters.type); }
  if (filters.category) { sql += ` AND category = ?`; params.push(filters.category); }
  sql += ` ORDER BY used_count ASC, COALESCE(used_at, '1970-01-01') ASC LIMIT 1`;
  return db.prepare(sql).get(...params);
}

export function markStoryUsed(id) {
  if (!id) return;
  const db = getDb();
  db.prepare(`
    UPDATE content_library
    SET used_count = used_count + 1, used_at = datetime('now')
    WHERE id = ?
  `).run(id);
}
```

### 11.2 No schema changes

`content_library` already has `used_count` and `used_at` columns. Just need to write to them post-upload.

## 12. Caption + hashtags

### 12.1 Generation

Reuse caption generation from pipeline-quotes-veo.js (Claude generates short Vietnamese caption + hashtags). Replace hashtag pool to story-specific:

```js
const STORY_HASHTAGS = [
  "#cauchuyen", "#cauchuyencothat", "#nghilucsong", "#camhung",
  "#thanhcong", "#tinhthantruyencam", "#downghilucvuotkho", "#fyp"
];
```

Always end with `#trendingvideo #trend` per `feedback_caption_hashtags.md` memory rule.

### 12.2 Caption tone

- Hook (1-2 lines): "Bạn có biết, [nhân vật/loại] đã từng [thử thách lớn nhất]?"
- Body (1-2 lines): tóm tắt insight chính
- Hashtags: 6-8 mix Vietnamese + English

Example for Steve Jobs:
```
Có một người từng bị đuổi khỏi chính công ty mình sáng lập.
12 năm sau, anh quay lại và biến nó thành công ty giá trị nhất hành tinh.

#cauchuyencothat #stevejobs #apple #nghiluc #camhung #thanhcong #trendingvideo #trend
```

## 13. CLI

```bash
# Default: pick least-used story, schedule +1 min from now
node src/pipeline-stories-veo.js

# Custom delay (e.g. 6h10m for next morning slot)
node src/pipeline-stories-veo.js --delay=370

# Force specific story by ID
node src/pipeline-stories-veo.js --story-id=4

# Filter by type
node src/pipeline-stories-veo.js --type=book

# Filter by category
node src/pipeline-stories-veo.js --category="nghị lực"

# Dry run (stop before posting)
node src/pipeline-stories-veo.js --dry-run

# Step-stop (e.g. up to Veo only)
node src/pipeline-stories-veo.js --step=veo

# Skip Veo hook (cheaper, just slides)
node src/pipeline-stories-veo.js --no-veo-hook
```

## 14. Cost estimate per post

| Step | Cost | Time |
|------|------|------|
| Director script (Claude Sonnet) | ~$0.02 | ~30s |
| Voiceover (Gemini TTS Puck) | ~$0.01 | ~60s |
| Veo hook 8s (`fast` tier) | $0 free | ~30-60s |
| Imagen 4 (3-6 slides) | ~$0.04-0.08 | ~30-90s |
| Compose FFmpeg | $0 | ~40-60s |
| Upload + schedule | $0 | ~15s |
| **Total** | **~$0.07-0.11/post** | **~3-6 min** |

Slightly cheaper than Tuệ Đàm ($0.12) because shorter stories (3 scenes) save 1-2 Imagen calls.

Daily cost if 1 story/day = ~$3/month. Negligible.

## 15. Error handling

### 15.1 Story exhaustion

If `pickStory()` returns null (no entries match filter):
- Log error
- Exit gracefully (no post)
- User adds more stories to `content_library` then retries

### 15.2 Director JSON malformed

- Log full Claude response
- Exit with non-zero code
- Don't post partial content

### 15.3 Voiceover Puck failure

- Fall back to Edge TTS `vi-VN-NamMinhNeural`
- Log warning (lost storyteller voice)
- Continue pipeline

### 15.4 Veo quota exhausted

- `pickAvailableModel()` already handles cascading fallback (fast → lite → standard → premium)
- If all exhausted: log error, skip Veo hook entirely, use 1 extra Imagen scene as opener

### 15.5 Upload failure

- Retry once with exponential backoff (existing PostForMe wrapper)
- If still fails: log + exit, video file preserved in queue/ for manual retry

## 16. Testing plan

### 16.1 Dry run unit test

```bash
node src/pipeline-stories-veo.js --dry-run --story-id=1
```
Expected: Claude generates valid JSON for Steve Jobs story, scene count = 4-6, no upload attempted.

### 16.2 Long story test (Nick Vujicic)

```bash
node src/pipeline-stories-veo.js --story-id=4 --delay=1440
```
Expected: 5-6 scenes generated, total duration 150-180s, video file in queue/, scheduled 24h from now.

### 16.3 Filter test

```bash
node src/pipeline-stories-veo.js --type=book --dry-run
```
Expected: Picks a book entry (not story), director prompt adapts (book summary tone vs hero journey).

### 16.4 Live integration test

1. Run with `--delay=10` for next 10 minutes
2. Verify TikTok schedules post
3. After post goes live, verify quality (audio/video/caption all correct)
4. Confirm `content_library.used_count` incremented + `used_at` set

## 17. Rollout

1. Implement `src/pipeline-stories-veo.js` (new file)
2. Implement `src/db.js` 2 helpers (`getNextStory`, `markStoryUsed`)
3. Run dry-run (Steve Jobs) — verify director output
4. Run live test (filter to short story, schedule near future)
5. If ok → commit + ship
6. After 1 week: review which stories used, adjust if certain stories never picked due to filter

## 18. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Imagen rejects "Steve Jobs" face | Director prompt explicitly says symbolic only — verified during prompt design |
| Story too long, exceeds 180s cap | Director prompt instructs cap, monitors via `actCount` rule |
| Puck voice drama too excited for somber stories | Fallback to Algenib via `--voice=Algenib` flag |
| Caption too generic (looks AI) | Caption prompt uses story title + lesson for context, prevents bland output |
| Recycle stories too fast | Least-used logic + 50 stories = ~50 days before any reuse |
| TikTok detects same account posting different content style | Mitigation: brand voice consistent (Puck = same human-feel as Algenib for audience continuity) |

## 19. Future work (out of scope for v1)

- **Multi-part series**: split very long stories (>500 words) across 2-3 days. Adds state tracking complexity.
- **Real photo lookup**: Wikipedia API + license check + photo cache. Requires CC-BY/PD verification logic.
- **Veo 3.1 native audio**: upgrade `lite` tier ($0.40/post) for lip-synced character speaking moments.
- **Per-category voice rotation**: Algenib for "triết học", Puck for "nghị lực", Sadaltager for "lãnh đạo".
- **Auto-generated story summaries**: Claude generates new stories from Wikipedia API → expand `content_library` beyond seeded 50.

---

**End of design.** Ready for writing-plans to break into implementation tasks.
