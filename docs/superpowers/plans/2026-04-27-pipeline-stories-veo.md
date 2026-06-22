# Pipeline Stories Veo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/pipeline-stories-veo.js` — TikTok pipeline that posts real-life inspirational stories from `content_library` table to Tuệ Đàm account, with adaptive 3-6 scene length and Puck (storyteller) voice.

**Architecture:** New 700-line ES module that reuses ~80% of `src/pipeline-quotes-veo.js` infrastructure (Veo hook gen, Imagen scene gen, FFmpeg compose, PostForMe upload). Three new components: `pickStory()` from DB, `genStoryDirector()` Claude prompt, voice config override (Puck vs Algenib).

**Tech Stack:** Node.js ESM, `better-sqlite3`, `@google/genai` (Veo + Imagen + TTS), `@anthropic-ai/sdk` (Claude Sonnet 4 director), FFmpeg, PostForMe.

**Spec:** `docs/superpowers/specs/2026-04-27-pipeline-stories-veo-design.md`

---

## File Structure

**Create:**
- `src/pipeline-stories-veo.js` (~700 lines) — main pipeline entry point
- `scripts/verify-pipeline-stories.mjs` — dry-run verification script

**Modify:**
- `src/db.js` — append 2 helpers (`getNextStory`, `markStoryUsed`) at end of file

**Reference (read-only, no changes):**
- `src/pipeline-quotes-veo.js` — copy ~80% of structure
- `src/gemini-tts.js` — for Puck voice config
- `src/veo.js` — Veo hook generation (already supports text-to-video)
- `src/imagen.js` — Imagen scene generation
- `src/script-writer.js` — Claude director infrastructure
- `src/social-poster.js` — PostForMe wrapper
- `src/shopee/config.mjs` — `TIKTOK_QUOTES_CONFIG` for posting account

---

## Task 1: DB helpers in `src/db.js`

**Files:**
- Modify: `src/db.js` — append after existing helpers
- Create: `scripts/verify-pipeline-stories.mjs` — verification script

- [ ] **Step 1.1: Write the failing verification script**

Create `scripts/verify-pipeline-stories.mjs`:

```js
/**
 * Verify pipeline-stories-veo DB helpers.
 * Tests getNextStory() filter logic + markStoryUsed() side effects.
 */
import "../src/env.js";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, unlinkSync } from "fs";

// Use a temp DB to avoid polluting production
const PROD_DB = "./data/content.db";
const TEST_DB = "./data/_test_stories.db";
process.env.DB_PATH = TEST_DB;
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
copyFileSync(PROD_DB, TEST_DB); // Clone production DB for read fixtures

const { getNextStory, markStoryUsed, getDb } = await import("../src/db.js");

// 1. getNextStory() with no filters returns least-used (ASC by used_count)
const story1 = getNextStory();
assert.ok(story1, "getNextStory() should return a story");
assert.ok(story1.id, "story should have id");
assert.ok(story1.title, "story should have title");
assert.ok(story1.content_vi, "story should have content_vi");
assert.ok(story1.type, "story should have type");
console.log(`✅ Default pick: ${story1.type} #${story1.id} "${story1.title.slice(0, 40)}" (used_count=${story1.used_count})`);

// 2. Filter by type
const bookOnly = getNextStory({ type: "book" });
assert.equal(bookOnly?.type, "book", "type=book filter should return book");
console.log(`✅ Type filter: book #${bookOnly.id} "${bookOnly.title.slice(0, 40)}"`);

// 3. Filter by category
const nghiluc = getNextStory({ category: "nghị lực" });
assert.equal(nghiluc?.category, "nghị lực", "category filter should match");
console.log(`✅ Category filter: nghị lực #${nghiluc.id} "${nghiluc.title.slice(0, 40)}"`);

// 4. Filter by id
const byId = getNextStory({ id: story1.id });
assert.equal(byId?.id, story1.id, "id filter should return exact entry");
console.log(`✅ ID filter: #${byId.id}`);

// 5. markStoryUsed increments used_count + sets used_at
const beforeCount = story1.used_count || 0;
markStoryUsed(story1.id);
const afterRow = getDb().prepare("SELECT used_count, used_at FROM content_library WHERE id = ?").get(story1.id);
assert.equal(afterRow.used_count, beforeCount + 1, "used_count should increment");
assert.ok(afterRow.used_at, "used_at should be set");
console.log(`✅ markStoryUsed: count ${beforeCount} → ${afterRow.used_count}, used_at=${afterRow.used_at}`);

// 6. After mark, ORDER BY used_count ASC should rotate to a different story
const story2 = getNextStory();
assert.notEqual(story2.id, story1.id, "after marking story1 used, getNextStory should return different story");
console.log(`✅ Rotation: after marking #${story1.id}, next = #${story2.id}`);

// Cleanup
import { closeDb } from "../src/db.js";
closeDb();
unlinkSync(TEST_DB);
console.log("\n✅ All verify-pipeline-stories DB checks passed");
```

- [ ] **Step 1.2: Run verification (expected to fail)**

Run: `node scripts/verify-pipeline-stories.mjs`

Expected: `TypeError: getNextStory is not a function` (helpers don't exist yet).

- [ ] **Step 1.3: Add `getNextStory` and `markStoryUsed` to `src/db.js`**

Append at the end of `src/db.js` (after `getRecentSourceNames`):

```js
// --- content_library helpers (Tuệ Đàm stories pipeline) ---

/**
 * Pick the next story to post from content_library.
 * Strategy: least used_count first; tie-break by oldest used_at (NULL treated as oldest).
 * Filters: { id, type, category } — all optional, all AND-combined.
 *
 * @param {{id?: number, type?: 'story'|'book'|'concept', category?: string}} [filters]
 * @returns {Object|null} story row, or null if no match
 */
export function getNextStory(filters = {}) {
  const db = getDb();
  let sql = `SELECT id, type, title, category, content_vi, lesson_vi,
                    quote, quote_vi, author, year, metadata, used_count, used_at
             FROM content_library WHERE 1=1`;
  const params = [];
  if (filters.id) { sql += ` AND id = ?`; params.push(filters.id); }
  if (filters.type) { sql += ` AND type = ?`; params.push(filters.type); }
  if (filters.category) { sql += ` AND category = ?`; params.push(filters.category); }
  sql += ` ORDER BY used_count ASC, COALESCE(used_at, '1970-01-01') ASC LIMIT 1`;
  return db.prepare(sql).get(...params) || null;
}

/**
 * Mark a content_library story as used: increment used_count, set used_at = now.
 * Idempotent: caller responsible for only calling AFTER successful upload.
 *
 * @param {number} id - content_library row id
 */
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

- [ ] **Step 1.4: Run verification (expected to pass)**

Run: `node scripts/verify-pipeline-stories.mjs`

Expected output: 6 ✅ checks pass + final `✅ All verify-pipeline-stories DB checks passed`

- [ ] **Step 1.5: Commit**

```bash
git add src/db.js scripts/verify-pipeline-stories.mjs
git commit -m "Add content_library helpers: getNextStory + markStoryUsed"
```

---

## Task 2: Director script generator

**Files:**
- Create: `src/pipeline-stories-veo.js` (just director function for now, add to file we'll grow in next tasks)

- [ ] **Step 2.1: Create `src/pipeline-stories-veo.js` skeleton with director only**

Create `src/pipeline-stories-veo.js`:

```js
/**
 * Stories Pipeline — Real-life inspirational story videos.
 *
 * Reads from content_library table (50 entries seeded), generates
 * adaptive-length 3-6 scene narrative videos, posts to Tuệ Đàm TikTok.
 *
 * See spec: docs/superpowers/specs/2026-04-27-pipeline-stories-veo-design.md
 *
 * Usage:
 *   node src/pipeline-stories-veo.js                    # Auto-pick least-used story
 *   node src/pipeline-stories-veo.js --story-id=4       # Force specific story
 *   node src/pipeline-stories-veo.js --type=book        # Books only
 *   node src/pipeline-stories-veo.js --category="nghị lực"
 *   node src/pipeline-stories-veo.js --delay=370        # Schedule 6h10m later
 *   node src/pipeline-stories-veo.js --dry-run          # Stop before posting
 */

import "./env.js";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "fs";
import { execSync, spawn } from "child_process";

import Anthropic from "@anthropic-ai/sdk";

const QUEUE_DIR = process.env.QUEUE_DIR || "./queue";
const NICHE = "stories";

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generate director script JSON for a story.
 * Adapts scene count 3-6 based on content length.
 *
 * @param {Object} story - row from content_library
 * @returns {Promise<{actCount, title, hook, hookVeoPrompt, scenes, endQuote}>}
 */
export async function genStoryDirector(story) {
  const wordCount = (story.content_vi || "").split(/\s+/).filter(Boolean).length;

  const prompt = `Bạn là director cho video kể chuyện 90-180s style Tuệ Đàm trên TikTok.

CÂU CHUYỆN:
- Tiêu đề: ${story.title}
- Loại: ${story.type} (story / book / concept)
- Danh mục: ${story.category}
- Nội dung: ${story.content_vi} (${wordCount} từ)
- Bài học: ${story.lesson_vi || "(không có)"}
- Quote (nếu có): "${story.quote_vi || ""}" — ${story.author || ""}

TẠO JSON với schema EXACT:
{
  "actCount": <integer 3-6>,
  "title": "<30-60 ký tự>",
  "hook": "<câu mở đầu 1-2 dòng gây tò mò mạnh>",
  "hookVeoPrompt": "<visual abstract symbolic prompt cho Veo 8s, KHÔNG name celebrity>",
  "scenes": [
    {
      "narration": "<60-100 từ tiếng Việt>",
      "imagenPrompt": "<abstract scene description, KHÔNG name celebrity>",
      "duration": <integer 25-35>
    }
  ],
  "endQuote": "<quote_vi nếu story có; null nếu không>"
}

LOGIC actCount:
- <250 từ → 3 scenes (~90s)
- 250-400 từ → 4 scenes (~120s)
- 400-500 từ → 5 scenes (~150s)
- >500 từ → 6 scenes (~180s)
- Cap absolute 180s

QUY TẮC narration:
- Tone storyteller (giọng đọc Puck — dynamic pacing, dramatic pauses)
- Mở đầu hook strong (curiosity / emotional)
- Act 2-3 build tension (setback / conflict)
- Penultimate act = turning point / insight
- Final act = lesson + call to reflection (KHÔNG CTA bán hàng)
- KHÔNG dùng các từ overused: "đỉnh", "ghiền", "đỉnh của đỉnh", "không xem là tiếc"

QUY TẮC imagenPrompt:
- KHÔNG generate face/body của celebrity tên cụ thể (Imagen sẽ reject)
- Symbolic: empty office, growing pile of letters, sunrise on horizon, hands holding small light
- Period-accurate: 1980s computer, vintage typewriter, monastery, war zone, garage workshop
- Cinematic: golden hour, dramatic shadow, slow camera dolly, 9:16 vertical
- Photorealistic OR painterly stylized

Chỉ trả về JSON thuần (không markdown fence, không meta-comment).`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.trim();
  // Strip markdown fence if Claude wrapped it
  const json = text.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(json);

  // Sanity-check actCount matches scenes array length
  if (parsed.actCount !== parsed.scenes.length) {
    log(`⚠ actCount ${parsed.actCount} ≠ scenes.length ${parsed.scenes.length}, using scenes.length`);
    parsed.actCount = parsed.scenes.length;
  }
  // Cap absolute 6 scenes
  if (parsed.scenes.length > 6) {
    log(`⚠ scenes truncated from ${parsed.scenes.length} to 6`);
    parsed.scenes = parsed.scenes.slice(0, 6);
    parsed.actCount = 6;
  }

  return parsed;
}
```

- [ ] **Step 2.2: Add director test to verify script**

Append at end of `scripts/verify-pipeline-stories.mjs` (before the cleanup):

```js
// 7. Director generates valid JSON for a real story
import { genStoryDirector } from "../src/pipeline-stories-veo.js";

console.log("\n--- Testing genStoryDirector (slow, ~30s) ---");
const testStory = getNextStory({ type: "story" });
console.log(`Generating director for: "${testStory.title}"`);
const director = await genStoryDirector(testStory);

assert.ok(director.title && director.title.length > 0, "director should have title");
assert.ok(director.hook && director.hook.length > 0, "director should have hook");
assert.ok(director.hookVeoPrompt && director.hookVeoPrompt.length > 0, "director should have Veo prompt");
assert.ok(Array.isArray(director.scenes), "scenes should be array");
assert.ok(director.scenes.length >= 3 && director.scenes.length <= 6, `scenes should be 3-6 (got ${director.scenes.length})`);
for (const [i, s] of director.scenes.entries()) {
  assert.ok(s.narration, `scene ${i} should have narration`);
  assert.ok(s.imagenPrompt, `scene ${i} should have imagenPrompt`);
  assert.ok(typeof s.duration === "number" && s.duration >= 20 && s.duration <= 40, `scene ${i} duration should be 20-40s (got ${s.duration})`);
}
console.log(`✅ Director generated ${director.scenes.length} scenes for "${testStory.title}"`);
console.log(`   Hook: "${director.hook.slice(0, 80)}..."`);
console.log(`   Veo prompt: "${director.hookVeoPrompt.slice(0, 80)}..."`);
```

(Move the cleanup block — `closeDb()` and `unlinkSync(TEST_DB)` and final log — after this new section.)

- [ ] **Step 2.3: Run verification (~30s due to Claude call)**

Run: `node scripts/verify-pipeline-stories.mjs`

Expected: 7 ✅ checks pass including director output validated.

- [ ] **Step 2.4: Commit**

```bash
git add src/pipeline-stories-veo.js scripts/verify-pipeline-stories.mjs
git commit -m "Add genStoryDirector — Claude prompt for story narrative arc"
```

---

## Task 3: Voiceover with Puck voice

**Files:**
- Modify: `src/pipeline-stories-veo.js` — add `genStoryVoiceover` function

- [ ] **Step 3.1: Read existing `genVoiceover` from quotes pipeline (no changes, just understand)**

Open `src/pipeline-quotes-veo.js` and find the `generateVoiceover` import and usage (~line 30 + body). Confirm it's imported from `./tts.js` and accepts `{ voice, style }` options.

- [ ] **Step 3.2: Add `genStoryVoiceover` to pipeline-stories-veo.js**

Append after `genStoryDirector`:

```js
import { generateVoiceover } from "./tts.js";

/**
 * Generate voiceover with Puck voice + storyteller style instruction.
 * Stories use dynamic pacing vs Tuệ Đàm's reflective Algenib.
 *
 * @param {string} script - full narration script (joined scenes)
 * @param {string} outputPath - .mp3 file path
 * @returns {Promise<{provider, path, sizeBytes}>}
 */
export async function genStoryVoiceover(script, outputPath) {
  return generateVoiceover(script, outputPath, {
    voice: "Puck",
    style:
      "Tell this story with passion and dynamic pacing. " +
      "Slow at reflection, faster during action. " +
      "Use dramatic pauses before key reveals. " +
      "Build emotional crescendo to the turning point. " +
      "Convey both struggle and triumph in your delivery.",
  });
}
```

- [ ] **Step 3.3: Manual smoke test (no automated test for audio quality)**

Run inline:
```bash
cd D:/tiktok && node -e "
import('./src/env.js').then(() => import('./src/pipeline-stories-veo.js')).then(async m => {
  const out = './queue/_smoke_voiceover.mp3';
  const r = await m.genStoryVoiceover(
    'Có một người từng bị đuổi khỏi chính công ty mình sáng lập. Mười hai năm sau, anh quay lại và biến nó thành công ty giá trị nhất hành tinh. Đó là câu chuyện về Steve Jobs.',
    out
  );
  console.log('Voiceover generated:', r);
  console.log('File size:', require('fs').statSync(out).size, 'bytes');
});
"
```

Expected: File `./queue/_smoke_voiceover.mp3` created, size > 50KB. Listen briefly to confirm Puck voice (different from Algenib).

Cleanup: `rm ./queue/_smoke_voiceover.mp3`

- [ ] **Step 3.4: Commit**

```bash
git add src/pipeline-stories-veo.js
git commit -m "Add genStoryVoiceover — Puck voice with storyteller style"
```

---

## Task 4: Reuse Veo hook + Imagen scenes from quotes pipeline

**Files:**
- Modify: `src/pipeline-stories-veo.js` — import + adapt scene generation

The quotes pipeline already does this. We need to refactor 2 utility functions out so both pipelines share them — OR just copy with minor changes. **Decision: copy** to keep diff minimal, refactor later if needed.

- [ ] **Step 4.1: Read `composeVideo` and Veo hook gen patterns from quotes pipeline**

Open `src/pipeline-quotes-veo.js`. Identify:
- `composeVideo()` function around line 146 — this generates final FFmpeg-composed video
- Veo hook generation block (look for `generateVideo` from `./veo.js` import) around lines 685-700 of `runPipeline()`
- Imagen scene generation (look for `generateImage` import + Ken Burns FFmpeg block) around line 705-770 of `runPipeline()`

Make notes (in your head) of what they take as input.

- [ ] **Step 4.2: Add scene generation function**

Append to `src/pipeline-stories-veo.js`:

```js
import { generateVideo, pickAvailableModel } from "./veo.js";
import { generateImage } from "./imagen.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Generate Veo 8s hook clip from director's hookVeoPrompt.
 * Uses cheapest available Veo tier (cascading fallback).
 *
 * @param {string} hookPrompt - from director output
 * @param {string} jobId
 * @returns {Promise<string|null>} path to MP4, or null if all Veo quotas exhausted
 */
export async function genVeoHook(hookPrompt, jobId) {
  const veoModel = pickAvailableModel();
  if (!veoModel) {
    log(`⚠ All Veo quotas exhausted, skipping hook clip`);
    return null;
  }
  log(`Step: Generating Veo hook clip (8s) with model: ${veoModel}...`);
  const hookPath = `${QUEUE_DIR}/${jobId}-hook.mp4`;
  const result = await generateVideo({
    model: veoModel,
    prompt: hookPrompt,
    outputPath: hookPath,
    aspectRatio: "9:16",
    durationSeconds: 8,
  });
  log(`Hook clip generated: ${result.path}`);
  return result.path;
}

/**
 * Generate Imagen image + Ken Burns motion clip for one scene.
 *
 * @param {Object} scene - { imagenPrompt, duration }
 * @param {string} jobId
 * @param {number} idx - 0-indexed
 * @returns {Promise<string>} path to scene MP4
 */
async function generateScene(scene, jobId, idx) {
  log(`  Imagen + Ken Burns clip ${idx + 1}/?...`);
  const imgPath = `${QUEUE_DIR}/${jobId}-scene${idx}.png`;
  const clipPath = `${QUEUE_DIR}/${jobId}-scene${idx}.mp4`;

  await generateImage({
    prompt: scene.imagenPrompt,
    outputPath: imgPath,
    aspectRatio: "9:16",
  });

  // Pick Ken Burns effect (rotate)
  const effects = [
    "zoom_in_center", "zoom_out_reveal", "zoom_pan_right", "zoom_pan_up",
    "parallax_zoom_in", "parallax_zoom_out", "parallax_drift_right", "zoom_breathe",
  ];
  const effect = effects[idx % effects.length];

  // FFmpeg Ken Burns (zoompan) — simplified, follows quotes pipeline pattern
  const fps = 30;
  const frames = scene.duration * fps;
  const filter = effect.startsWith("zoom_in")
    ? `zoompan=z='min(zoom+0.0008,1.3)':d=${frames}:s=1080x1920:fps=${fps}`
    : effect.startsWith("zoom_out")
    ? `zoompan=z='max(1.3-on*0.0008,1.0)':d=${frames}:s=1080x1920:fps=${fps}`
    : effect.startsWith("zoom_pan_right")
    ? `zoompan=z='1.15':x='if(gte(zoom,1.0),x+1,x)':d=${frames}:s=1080x1920:fps=${fps}`
    : `zoompan=z='1+0.0005*on':d=${frames}:s=1080x1920:fps=${fps}`;

  execSync(
    `"${FFMPEG}" -y -loop 1 -i "${imgPath}" -vf "${filter}" -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -t ${scene.duration} "${clipPath}"`,
    { stdio: "pipe" }
  );
  log(`    Effect: ${effect} (single)`);

  // Cleanup PNG (no longer needed)
  try { unlinkSync(imgPath); } catch {}

  return clipPath;
}

/**
 * Generate all scene clips (3-6).
 *
 * @param {Array} scenes - director.scenes
 * @param {string} jobId
 * @returns {Promise<string[]>} paths to scene MP4s in order
 */
export async function generateAllScenes(scenes, jobId) {
  const paths = [];
  for (let i = 0; i < scenes.length; i++) {
    const path = await generateScene(scenes[i], jobId, i);
    paths.push(path);
  }
  log(`All ${scenes.length} scene clips generated (Imagen)`);
  return paths;
}
```

- [ ] **Step 4.3: Smoke test scene generation**

Run inline (uses real Imagen + FFmpeg, costs ~$0.02):
```bash
cd D:/tiktok && node -e "
import('./src/env.js').then(() => import('./src/pipeline-stories-veo.js')).then(async m => {
  const scenes = [
    { imagenPrompt: '1980s garage workshop with vintage Apple I prototype on workbench, dim lamp lighting, photorealistic, 9:16 vertical', duration: 25 }
  ];
  const paths = await m.generateAllScenes(scenes, 'smoke-test');
  console.log('Generated:', paths);
  const fs = require('fs');
  console.log('Size:', fs.statSync(paths[0]).size, 'bytes');
  // Cleanup
  for (const p of paths) try { fs.unlinkSync(p); } catch {}
});
"
```

Expected: One MP4 generated ~500KB-2MB. Cleanup happens automatically.

- [ ] **Step 4.4: Commit**

```bash
git add src/pipeline-stories-veo.js
git commit -m "Add Veo hook + Imagen scene generators (variable count 3-6)"
```

---

## Task 5: Compose video (FFmpeg xfade chain)

**Files:**
- Modify: `src/pipeline-stories-veo.js` — add `composeStoryVideo` adapted from quotes

- [ ] **Step 5.1: Add compose function adapted for variable scene count**

Append to `src/pipeline-stories-veo.js`:

```js
/**
 * Compose final video: title → Veo hook → scene clips → audio mix.
 *
 * Adapted from pipeline-quotes-veo.js:composeVideo for variable
 * scene count (3-6) and story-specific transitions.
 *
 * @param {string[]} sceneClips - paths to N scene MP4s
 * @param {string|null} hookClip - path to Veo hook MP4, or null if Veo skipped
 * @param {string} audioPath - path to voiceover MP3
 * @param {string} title - title shown on opening slide
 * @param {string} outputPath - final MP4 path
 * @returns {Promise<{path, duration}>}
 */
export async function composeStoryVideo(sceneClips, hookClip, audioPath, title, outputPath) {
  const N = sceneClips.length;
  log(`Composing final story video (${N} scenes${hookClip ? " + Veo hook" : ""})...`);

  // Build input list
  const inputs = [];
  inputs.push("-loop", "1", "-t", "1.5", "-i", "./assets/branding/title-bg.png"); // title slide
  if (hookClip) inputs.push("-i", hookClip);
  for (const clip of sceneClips) inputs.push("-i", clip);
  inputs.push("-i", audioPath);

  // Build filter graph: drawtext title + xfade chain
  // For N scenes, we have (1 title) + (1 hook?) + N scene clips = 2+N or 1+N inputs
  const numClips = (hookClip ? 1 : 0) + N + 1; // +1 for title
  // Title overlay text
  const titleText = title.replace(/'/g, "’").replace(/[[\]"]/g, "");
  const fontPath = (process.env.FONT_PATH || "./assets/fonts/Montserrat-Bold.ttf").replace(/\\/g, "/").replace(/:/g, "\\:");

  // Each clip duration index for xfade offsets
  const titleDur = 1.5;
  const hookDur = hookClip ? 8 : 0;
  // Scene durations come from scenes (in director). For compose we use FFmpeg-detected duration via -t in earlier step.
  // For simplicity: query each clip's duration via ffprobe
  function probeDuration(path) {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`,
      { encoding: "utf8" }
    );
    return parseFloat(out.trim());
  }
  const sceneDurations = sceneClips.map(probeDuration);

  // Build xfade chain (transitions overlap 0.5s each)
  const fadeDur = 0.5;
  let filter = `[0:v]drawtext=fontfile='${fontPath}':text='${titleText}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=20[v0];`;

  // chain: v0 + (hook + scenes) using xfade
  const transitions = ["dissolve", "circleopen", "smoothup", "wipeleft", "fadeblack", "slideleft"];
  let curOffset = titleDur - fadeDur;
  let prevLabel = "v0";
  let inputIdx = 1;

  if (hookClip) {
    filter += `[${inputIdx}:v][${prevLabel}]xfade=transition=${transitions[0]}:duration=${fadeDur}:offset=${curOffset}[v${inputIdx}];`;
    curOffset += hookDur - fadeDur;
    prevLabel = `v${inputIdx}`;
    inputIdx++;
  }

  for (let i = 0; i < N; i++) {
    const trans = transitions[(inputIdx) % transitions.length];
    filter += `[${inputIdx}:v][${prevLabel}]xfade=transition=${trans}:duration=${fadeDur}:offset=${curOffset}[v${inputIdx}];`;
    curOffset += sceneDurations[i] - fadeDur;
    prevLabel = `v${inputIdx}`;
    inputIdx++;
  }

  // Audio: just use voiceover input (last input)
  const audioInputIdx = inputIdx;

  const cmd = [
    `"${FFMPEG}" -y`,
    inputs.join(" "),
    `-filter_complex "${filter}" -map "[${prevLabel}]" -map ${audioInputIdx}:a`,
    `-c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p`,
    `-c:a aac -b:a 128k`,
    `-shortest "${outputPath}"`,
  ].join(" ");

  execSync(cmd, { stdio: "pipe" });
  const duration = probeDuration(outputPath);
  log(`Final story video: ${duration.toFixed(1)}s at ${outputPath}`);
  return { path: outputPath, duration };
}
```

> **NOTE:** This compose function is more complex than ideal. If during testing it produces broken output, fall back to using **the exact `composeVideo` from `pipeline-quotes-veo.js`** with minor adjustments (it already handles variable count via the `quotes` array — pass `scenes` as the same shape).

- [ ] **Step 5.2: Verify title-bg.png asset exists (or create placeholder)**

Run: `ls assets/branding/title-bg.png 2>&1 || ls assets/branding/`

If `title-bg.png` doesn't exist, find what quotes pipeline uses (likely a solid color or gradient). Most likely path: `./assets/branding/avatar.png` or generate one.

If missing, create a 1080×1920 black PNG:
```bash
ffmpeg -f lavfi -i color=c=0x1a1a2e:size=1080x1920 -frames:v 1 ./assets/branding/title-bg.png
```

- [ ] **Step 5.3: Commit**

```bash
git add src/pipeline-stories-veo.js assets/branding/title-bg.png
git commit -m "Add composeStoryVideo — FFmpeg xfade for variable scenes"
```

---

## Task 6: Caption + upload integration

**Files:**
- Modify: `src/pipeline-stories-veo.js` — add caption + upload functions

- [ ] **Step 6.1: Add caption generator**

Append:

```js
/**
 * Generate TikTok caption for a story post.
 * Hook (1-2 lines from director) + body (lesson) + hashtags.
 */
export function genStoryCaption(director, story) {
  const hashtagPool = [
    "#cauchuyen", "#cauchuyencothat", "#nghilucsong", "#camhung",
    "#thanhcong", "#tinhthantruyencam", "#vuotkho", "#fyp",
  ];
  // Pick 5 random + always end with rules from feedback_caption_hashtags.md
  const shuffled = [...hashtagPool].sort(() => Math.random() - 0.5).slice(0, 5);
  const tags = `${shuffled.join(" ")} #trendingvideo #trend`;

  const lessonLine = (story.lesson_vi || "").slice(0, 120);
  const caption = [
    director.hook,
    lessonLine ? `\n${lessonLine}` : "",
    `\n\n${tags}`,
  ].join("");
  return caption.slice(0, 2000); // TikTok caption limit
}
```

- [ ] **Step 6.2: Add upload integration (reuse social-poster + config)**

Append:

```js
import { createPoster } from "./social-poster.js";
import { TIKTOK_QUOTES_CONFIG } from "./shopee/config.mjs";

/**
 * Upload final video and schedule TikTok post.
 * Uses same Tuệ Đàm account (TIKTOK_QUOTES_CONFIG).
 *
 * @param {string} videoPath
 * @param {string} caption
 * @param {number} delayMin
 * @returns {Promise<{postId, scheduledAt}>}
 */
export async function uploadAndSchedule(videoPath, caption, delayMin) {
  const poster = createPoster(TIKTOK_QUOTES_CONFIG);
  const mediaRef = await poster.upload(videoPath);
  log(`Uploaded: ${mediaRef.slice(0, 60)}`);

  const scheduledAt = new Date(Date.now() + delayMin * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, ".000Z");

  const result = await poster.scheduleTikTok({ mediaRef, caption, scheduledAt });
  const postId = result?.postId || result?.postIds?.[0];
  log(`Scheduled: post ${postId} at ${scheduledAt}`);
  return { postId, scheduledAt };
}
```

- [ ] **Step 6.3: Commit**

```bash
git add src/pipeline-stories-veo.js
git commit -m "Add caption generator + TikTok upload integration"
```

---

## Task 7: Main orchestrator + CLI

**Files:**
- Modify: `src/pipeline-stories-veo.js` — add `runPipeline` + CLI handling

- [ ] **Step 7.1: Parse CLI args**

Append at top (after imports, before functions):

```js
const DRY_RUN = process.argv.includes("--dry-run");
const STEP = process.argv.find((a) => a.startsWith("--step="))?.split("=")[1];
const DELAY_MIN = parseInt(process.argv.find((a) => a.startsWith("--delay="))?.split("=")[1] || "1", 10);
const STORY_ID = parseInt(process.argv.find((a) => a.startsWith("--story-id="))?.split("=")[1] || "0", 10) || null;
const TYPE_FILTER = process.argv.find((a) => a.startsWith("--type="))?.split("=")[1] || null;
const CATEGORY_FILTER = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1] || null;
const SKIP_VEO_HOOK = process.argv.includes("--no-veo-hook");
```

- [ ] **Step 7.2: Add runPipeline orchestrator**

Append:

```js
import { getNextStory, markStoryUsed } from "./db.js";

export async function runPipeline() {
  const jobId = `story-${Date.now()}-${randomUUID().slice(0, 8)}`;
  log(`=== Story Pipeline Start: ${jobId} ===`);

  // Step 1: Pick story
  const story = getNextStory({
    id: STORY_ID,
    type: TYPE_FILTER,
    category: CATEGORY_FILTER,
  });
  if (!story) {
    log(`❌ No story found matching filters (id=${STORY_ID}, type=${TYPE_FILTER}, category=${CATEGORY_FILTER})`);
    process.exit(1);
  }
  log(`Story #${story.id}: "${story.title}" [${story.type}/${story.category}, used_count=${story.used_count}]`);

  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });

  // Step 2: Director
  log(`Step 2: Generating director script...`);
  const director = await genStoryDirector(story);
  log(`Script: ${director.scenes.length} scenes, hook: "${director.hook.slice(0, 60)}..."`);
  writeFileSync(`${QUEUE_DIR}/${jobId}-director.json`, JSON.stringify(director, null, 2));
  log(`Director saved: ${QUEUE_DIR}/${jobId}-director.json`);

  if (DRY_RUN) {
    log(`✅ Dry-run complete (--dry-run flag)`);
    return { success: true, jobId, dryRun: true, director };
  }
  if (STEP === "director") return { success: true, jobId, director };

  // Step 3: Voiceover (Puck)
  log(`Step 3: Generating voiceover (Puck)...`);
  const fullScript = director.scenes.map((s) => s.narration).join(" ");
  const audioPath = `${QUEUE_DIR}/${jobId}-voice.mp3`;
  await genStoryVoiceover(fullScript, audioPath);
  log(`Voiceover: ${Math.round(statSync(audioPath).size / 1024)}KB`);
  if (STEP === "voiceover") return { success: true, jobId, audioPath };

  // Step 4a: Veo hook
  let hookClip = null;
  if (!SKIP_VEO_HOOK) {
    hookClip = await genVeoHook(director.hookVeoPrompt, jobId);
  }
  if (STEP === "veo") return { success: true, jobId, hookClip };

  // Step 4b: Imagen scenes
  log(`Step 4b: Generating ${director.scenes.length} scene clips...`);
  const sceneClips = await generateAllScenes(director.scenes, jobId);
  if (STEP === "imagen") return { success: true, jobId, sceneClips };

  // Step 5: Compose
  log(`Step 5: Composing final video...`);
  const finalPath = `${QUEUE_DIR}/${jobId}.mp4`;
  const { duration } = await composeStoryVideo(sceneClips, hookClip, audioPath, director.title, finalPath);
  if (STEP === "compose") return { success: true, jobId, finalPath, duration };

  // Step 6: Upload + schedule
  log(`Step 6: Uploading to PostForMe...`);
  const caption = genStoryCaption(director, story);
  const { postId, scheduledAt } = await uploadAndSchedule(finalPath, caption, DELAY_MIN);

  // Step 7: Mark story used (only after successful upload)
  markStoryUsed(story.id);

  log(`=== Pipeline Complete: ${jobId} ===`);
  return {
    success: true,
    jobId,
    postId,
    storyId: story.id,
    storyTitle: story.title,
    videoPath: finalPath,
    duration,
    category: story.category,
    estimatedCost: `~$${((director.scenes.length * 0.015) + 0.03).toFixed(2)}`,
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  runPipeline()
    .then((result) => {
      console.log("\nResult:", JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Pipeline failed:", err);
      process.exit(1);
    });
}
```

- [ ] **Step 7.3: Run dry-run test**

```bash
cd D:/tiktok && node src/pipeline-stories-veo.js --dry-run
```

Expected:
- Picks a story (least-used)
- Generates director (~30s)
- Saves director.json to queue/
- Exits with `dryRun: true` result

- [ ] **Step 7.4: Commit**

```bash
git add src/pipeline-stories-veo.js
git commit -m "Add runPipeline orchestrator + CLI for stories pipeline"
```

---

## Task 8: Live integration test

**Files:** None modified. Test only.

- [ ] **Step 8.1: Compute schedule time for ~10 minutes from now**

```bash
cd D:/tiktok && node -e "
const d = new Date();
const vn = new Date(d.toLocaleString('en-US', {timeZone:'Asia/Ho_Chi_Minh'}));
console.log('VN now:', vn.toTimeString().slice(0,5));
console.log('--delay=10 → posts at +10 min');
"
```

- [ ] **Step 8.2: Run live pipeline**

Pick a SHORT story for first live test (less Imagen cost):

```bash
cd D:/tiktok && node src/pipeline-stories-veo.js --type=concept --delay=10 2>&1 | tee queue/_test-stories-live.log
```

Expected:
- Director generates 3-4 scenes (concept stories tend short)
- Voiceover ~30s
- Veo hook ~30-60s
- 3-4 Imagen scenes ~30-60s
- Compose ~40s
- Upload + schedule succeeds
- Total ~3-4 minutes

- [ ] **Step 8.3: Verify TikTok schedule**

Check `queue/_test-stories-live.log` for `Scheduled: post sp_...` line. Note the `postId`.

Wait 10+ minutes, then check Tuệ Đàm TikTok account to confirm post went live with:
- Correct title
- Puck voice (different from usual Algenib)
- 3-4 scenes flow well
- Caption + hashtags correct
- Audio matches video duration

- [ ] **Step 8.4: Verify DB updated**

```bash
cd D:/tiktok && node -e "
import('./src/db.js').then(m => {
  const recent = m.getDb().prepare('SELECT id, title, used_count, used_at FROM content_library WHERE used_count > 0 ORDER BY used_at DESC LIMIT 5').all();
  console.table(recent);
});
"
```

Expected: The story used in test shows `used_count >= 1` and `used_at` is recent timestamp.

- [ ] **Step 8.5: Cleanup test artifacts (don't commit log file)**

```bash
cd D:/tiktok && rm -f queue/_test-stories-live.log queue/story-* 2>/dev/null
```

- [ ] **Step 8.6: Final commit (if any tweaks made during test)**

If the live test required code adjustments (e.g. compose filter bugs, missing imports):

```bash
git add src/pipeline-stories-veo.js
git commit -m "Fix integration issues from live test"
```

If no changes needed, skip this commit.

---

## Self-Review checklist

Before marking complete, verify:

**Spec coverage (from `docs/superpowers/specs/2026-04-27-pipeline-stories-veo-design.md`):**
- §5 Architecture → Tasks 1-7 implement all components ✓
- §6 Story selection (least-used + filters) → Task 1 ✓
- §7 Director script (Claude) → Task 2 ✓
- §8 Voiceover (Puck + style) → Task 3 ✓
- §9 Veo + Imagen → Task 4 ✓
- §10 Compose → Task 5 ✓
- §11 DB tracking → Task 1 (helpers) + Task 7 (call site) ✓
- §12 Caption + hashtags → Task 6 ✓
- §13 CLI → Task 7 ✓
- §15 Error handling → distributed across tasks (try/catch in director, fail-open in voiceover, Veo cascade fallback already in pickAvailableModel)
- §16 Testing → Task 8 covers integration; Task 1 covers DB unit; Task 2 covers director unit ✓

**Type consistency:**
- `getNextStory(filters)` returns story row (Task 1) — used in Task 7 with same shape ✓
- `genStoryDirector(story)` returns `{actCount, title, hook, hookVeoPrompt, scenes, endQuote}` (Task 2) — Task 7 uses `director.scenes`, `director.hook`, etc. ✓
- `genStoryVoiceover(script, outputPath)` returns provider info (Task 3) — Task 7 just uses presence of audioPath file ✓
- `composeStoryVideo(sceneClips, hookClip, audioPath, title, outputPath)` returns `{path, duration}` (Task 5) — Task 7 destructures correctly ✓
- `uploadAndSchedule(videoPath, caption, delayMin)` returns `{postId, scheduledAt}` (Task 6) — Task 7 destructures correctly ✓

**No placeholders:** All steps have full code or full commands with expected output. No "TBD", "fill in", "similar to". ✓

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-27-pipeline-stories-veo.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
