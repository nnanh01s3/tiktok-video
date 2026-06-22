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
import { generateVoiceover } from "./tts.js";
import { generateVideo, pickAvailableModel } from "./veo.js";
import { generateImage } from "./imagen.js";
import { createPoster } from "./social-poster.js";
import { TIKTOK_QUOTES_CONFIG } from "./shopee/config.mjs";
import { getNextStory, markStoryUsed } from "./db.js";

// --- CLI argument parsing ---
const DRY_RUN = process.argv.includes("--dry-run");
const STEP = process.argv.find((a) => a.startsWith("--step="))?.split("=")[1];
const DELAY_MIN = parseInt(process.argv.find((a) => a.startsWith("--delay="))?.split("=")[1] || "1", 10);
const STORY_ID = parseInt(process.argv.find((a) => a.startsWith("--story-id="))?.split("=")[1] || "0", 10) || null;
const TYPE_FILTER = process.argv.find((a) => a.startsWith("--type="))?.split("=")[1] || null;
const CATEGORY_FILTER = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1] || null;
const SKIP_VEO_HOOK = process.argv.includes("--no-veo-hook");

const QUEUE_DIR = process.env.QUEUE_DIR || "./queue";
const NICHE = "stories";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

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
  // Defense-in-depth: collapse newlines so story content can't break out of the prompt template
  const safe = (s) => String(s ?? "").replace(/\r?\n+/g, " ").trim();
  const safeStory = {
    title: safe(story.title),
    type: safe(story.type),
    category: safe(story.category),
    content_vi: safe(story.content_vi),
    lesson_vi: safe(story.lesson_vi),
    quote_vi: safe(story.quote_vi),
    author: safe(story.author),
  };

  const wordCount = safeStory.content_vi.split(/\s+/).filter(Boolean).length;

  const prompt = `Bạn là director cho video kể chuyện 90-180s style Tuệ Đàm trên TikTok.

CÂU CHUYỆN:
- Tiêu đề: ${safeStory.title}
- Loại: ${safeStory.type} (story / book / concept)
- Danh mục: ${safeStory.category}
- Nội dung: ${safeStory.content_vi} (${wordCount} từ)
- Bài học: ${safeStory.lesson_vi || "(không có)"}
- Quote (nếu có): "${safeStory.quote_vi || ""}" — ${safeStory.author || ""}

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

  let parsed;
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response?.content?.[0]?.text?.trim();
    if (!text) throw new Error("Claude returned empty content");
    // Strip markdown fence if Claude wrapped it (handles ```json, ```, with/without trailing newlines)
    const json = text
      .replace(/^[\s\n]*```(?:json)?\s*\n?/i, "")
      .replace(/\n?\s*```\s*$/i, "")
      .trim();
    parsed = JSON.parse(json);
  } catch (err) {
    log(`❌ genStoryDirector failed: ${err.message}`);
    throw err;
  }

  // Validate scenes array
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw new Error(`Director returned no scenes (got ${parsed.scenes?.length ?? "undefined"})`);
  }
  if (parsed.scenes.length < 3) {
    throw new Error(`Director returned only ${parsed.scenes.length} scenes (minimum 3 per spec)`);
  }
  // Cap absolute 6 scenes
  if (parsed.scenes.length > 6) {
    log(`⚠ scenes truncated from ${parsed.scenes.length} to 6`);
    parsed.scenes = parsed.scenes.slice(0, 6);
  }
  // Force actCount to match real scenes length
  if (parsed.actCount !== parsed.scenes.length) {
    log(`⚠ actCount ${parsed.actCount} ≠ scenes.length ${parsed.scenes.length}, using scenes.length`);
    parsed.actCount = parsed.scenes.length;
  }

  return parsed;
}

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

/**
 * Generate Veo 8s hook clip from director's hookVeoPrompt.
 * Uses cheapest available Veo tier (cascading fallback).
 * Returns null if all Veo quotas exhausted (graceful degradation).
 *
 * @param {string} hookPrompt - from director output
 * @param {string} jobId
 * @returns {Promise<string|null>} path to MP4, or null
 */
export async function genVeoHook(hookPrompt, jobId) {
  const veoModel = pickAvailableModel();
  if (!veoModel) {
    log(`⚠ All Veo quotas exhausted, skipping hook clip`);
    return null;
  }
  log(`Step: Generating Veo hook clip (8s) with model: ${veoModel}...`);
  const hookPath = `${QUEUE_DIR}/${jobId}-hook.mp4`;
  try {
    await generateVideo(hookPrompt, hookPath, {
      model: veoModel,
      aspectRatio: "9:16",
      resolution: "1080p",
    });
    log(`Hook clip generated: ${hookPath}`);
    return hookPath;
  } catch (err) {
    log(`⚠ Veo hook failed (model=${veoModel}): ${err.message}. Proceeding without hook.`);
    return null;
  }
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
  log(`  Imagen + Ken Burns clip ${idx + 1}...`);
  const imgPath = `${QUEUE_DIR}/${jobId}-scene${idx}.png`;
  const clipPath = `${QUEUE_DIR}/${jobId}-scene${idx}.mp4`;

  // Imagen — only takes (prompt, outputPath); aspectRatio is fixed at 9:16 inside
  try {
    await generateImage(scene.imagenPrompt, imgPath);
  } catch (err) {
    log(`❌ Scene ${idx + 1} Imagen failed: ${err.message}`);
    throw err;
  }

  // Pick Ken Burns effect deterministically by scene index (rotate)
  const effects = [
    "zoom_in_center", "zoom_out_reveal", "zoom_pan_right", "zoom_pan_up",
    "parallax_zoom_in", "parallax_zoom_out", "parallax_drift_right", "zoom_breathe",
  ];
  const effect = effects[idx % effects.length];

  // FFmpeg Ken Burns (zoompan) — simplified single-layer per plan
  const fps = 30;
  const frames = scene.duration * fps;
  let filter;
  if (effect.startsWith("zoom_in")) {
    filter = `zoompan=z='min(zoom+0.0008,1.3)':d=${frames}:s=1080x1920:fps=${fps}`;
  } else if (effect.startsWith("zoom_out")) {
    filter = `zoompan=z='if(eq(on,0),1.3,max(zoom-0.0008,1.0))':d=${frames}:s=1080x1920:fps=${fps}`;
  } else if (effect === "zoom_pan_right" || effect === "parallax_drift_right") {
    filter = `zoompan=z='1.15':x='if(gte(zoom,1.0),x+1,x)':d=${frames}:s=1080x1920:fps=${fps}`;
  } else {
    // Default: gentle drift in
    filter = `zoompan=z='1+0.0005*on':d=${frames}:s=1080x1920:fps=${fps}`;
  }

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

/**
 * Compose final story video: optional title slide → optional Veo hook → scene clips → audio.
 *
 * Strategy: simple xfade chain. Uses ffprobe to get exact duration of each clip, then
 * computes cumulative xfade offsets. Audio is the single voiceover track (no per-scene
 * audio mixing — stories are voiceover-driven, not ambient).
 *
 * @param {string[]} sceneClips - paths to N scene MP4s (each 1080x1920, durations from director)
 * @param {string|null} hookClip - path to Veo hook MP4 (8s), or null if Veo skipped
 * @param {string} audioPath - path to voiceover MP3
 * @param {string} title - title text for opening slide
 * @param {string} outputPath - final MP4 path
 * @returns {Promise<{path: string, duration: number}>}
 */
export async function composeStoryVideo(sceneClips, hookClip, audioPath, title, outputPath) {
  const N = sceneClips.length;
  log(`Composing final story video (${N} scenes${hookClip ? " + Veo hook" : ""}${title ? " + title" : ""})...`);

  // ffprobe duration helper (consistent with codebase style: -of csv=p=0)
  function probeDuration(p) {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`,
      { encoding: "utf8" }
    );
    return parseFloat(out.trim());
  }

  const TITLE_DURATION = 1.5;
  const FADE_DURATION = 0.5;

  // Build segment list in playback order.
  // Each segment: { inputArgs, duration, filterPreamble(idx), streamLabel(idx) }
  const segments = [];

  // Segment 0 (optional): synthetic title slide via lavfi — no PNG asset needed.
  // Dark navy background (0x1a1a2e) with white text in semi-transparent box.
  if (title) {
    const safeTitle = title.replace(/[':\\%\[\]]/g, "").slice(0, 40);
    // On Windows, FFmpeg fontfile paths need forward slashes and the colon escaped as \:
    const fontPath = "./assets/fonts/Montserrat-Bold.ttf"
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:");
    segments.push({
      inputArgs: [
        "-f", "lavfi", "-t", String(TITLE_DURATION),
        "-i", `color=c=0x1a1a2e:size=1080x1920:rate=30`,
      ],
      duration: TITLE_DURATION,
      filterPreamble: (idx) =>
        `[${idx}:v]drawtext=fontfile='${fontPath}':text='${safeTitle}'` +
        `:fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2` +
        `:box=1:boxcolor=black@0.5:boxborderw=20[v${idx}]`,
      streamLabel: (idx) => `v${idx}`,
    });
  }

  // Segment (optional): Veo hook clip
  if (hookClip) {
    segments.push({
      inputArgs: ["-i", hookClip],
      duration: probeDuration(hookClip),
      filterPreamble: (idx) =>
        `[${idx}:v]scale=1080:1920:flags=bilinear,fps=30,setpts=PTS-STARTPTS[v${idx}]`,
      streamLabel: (idx) => `v${idx}`,
    });
  }

  // Scene clips
  for (const clip of sceneClips) {
    segments.push({
      inputArgs: ["-i", clip],
      duration: probeDuration(clip),
      filterPreamble: (idx) =>
        `[${idx}:v]scale=1080:1920:flags=bilinear,fps=30,setpts=PTS-STARTPTS[v${idx}]`,
      streamLabel: (idx) => `v${idx}`,
    });
  }

  if (segments.length === 0) {
    throw new Error("composeStoryVideo: no segments to compose (no title, no hook, no scenes)");
  }

  // Voiceover audio is the LAST input
  const audioIdx = segments.length;

  // Flatten input args (each segment's args + the audio file at the end)
  const inputs = [];
  for (const s of segments) inputs.push(...s.inputArgs);
  inputs.push("-i", audioPath);

  // Build filter_complex:
  // 1. Each segment's preamble normalizes its stream to [v0], [v1], [v2], ...
  const filterParts = segments.map((s, i) => s.filterPreamble(i));

  // 2. Cross-fade chain:
  //    [v0][v1]xfade=transition=T:duration=0.5:offset=(seg0.duration - 0.5)[c1]
  //    [c1][v2]xfade=transition=T:duration=0.5:offset=(seg0.dur + seg1.dur - 2*0.5)[c2]
  //    ...
  //    CORRECT xfade order: [outgoing][incoming] — prev FIRST, new SECOND.
  const transitions = ["fade", "dissolve", "fadeblack", "wipeleft", "circleopen", "smoothup"];

  let prevLabel = "v0";
  let cumulativeOffset = segments[0].duration - FADE_DURATION;

  for (let i = 1; i < segments.length; i++) {
    const trans = transitions[(i - 1) % transitions.length];
    const outLabel = i === segments.length - 1 ? "vout" : `c${i}`;
    // [outgoing][incoming]xfade — outgoing (prevLabel) FIRST, incoming (v${i}) SECOND
    filterParts.push(
      `[${prevLabel}][v${i}]xfade=transition=${trans}:duration=${FADE_DURATION}:offset=${cumulativeOffset.toFixed(3)}[${outLabel}]`
    );
    prevLabel = outLabel;
    cumulativeOffset += segments[i].duration - FADE_DURATION;
  }

  // Edge case: only 1 segment — no xfade chain, rename v0→vout via null filter
  if (segments.length === 1) {
    filterParts.push(`[v0]null[vout]`);
  }

  const filterComplex = filterParts.join(";");

  // Total expected video duration (for logging)
  const totalDuration =
    segments.reduce((acc, s) => acc + s.duration, 0) -
    FADE_DURATION * Math.max(0, segments.length - 1);

  log(`  Expected video duration: ${totalDuration.toFixed(1)}s, ${segments.length} segments`);

  const cmd = [
    `"${FFMPEG}"`,
    "-y",
    ...inputs,
    "-filter_complex", `"${filterComplex}"`,
    "-map", `"[vout]"`,
    "-map", `${audioIdx}:a`,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    `"${outputPath}"`,
  ].join(" ");

  // Warn if audio/video durations diverge significantly — `-shortest` will clip
  const audioDuration = probeDuration(audioPath);
  const drift = Math.abs(audioDuration - totalDuration);
  if (drift > 2) {
    log(`⚠ Audio ${audioDuration.toFixed(1)}s vs video ${totalDuration.toFixed(1)}s (drift ${drift.toFixed(1)}s) — \`-shortest\` will clip`);
  }

  execSync(cmd, { stdio: "pipe" });

  const actualDuration = probeDuration(outputPath);
  log(`Final story video: ${actualDuration.toFixed(1)}s at ${outputPath}`);
  return { path: outputPath, duration: actualDuration };
}

/**
 * Generate TikTok caption for a story post.
 * Hook (1-2 lines from director) + body (lesson) + hashtags.
 *
 * @param {Object} director - from genStoryDirector()
 * @param {Object} story - content library entry
 * @returns {string} caption (max 2000 chars, ends with #trendingvideo #trend)
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
  const contentOnly = [
    director.hook,
    lessonLine ? `\n${lessonLine}` : "",
  ].join("");

  // Reserve room for hashtags (and "\n\n" separator) so they survive 2000-char cap
  const maxContentLen = Math.max(0, 2000 - tags.length - 2);
  const slicedContent = contentOnly.slice(0, maxContentLen);

  return `${slicedContent}\n\n${tags}`;
}

/**
 * Upload final video and schedule TikTok post.
 * Uses same Tuệ Đàm account (TIKTOK_QUOTES_CONFIG).
 *
 * @param {string} videoPath - path to final MP4
 * @param {string} caption - from genStoryCaption()
 * @param {number} delayMin - minutes from now to schedule
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

/**
 * Main orchestrator — wires all pipeline stages end-to-end.
 * Controlled by CLI flags: --dry-run, --step=, --story-id=, --type=, --category=,
 * --delay=, --no-veo-hook.
 */
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

// CLI entry point (triple-slash prefix required on Windows: file:///D:/...)
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
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
