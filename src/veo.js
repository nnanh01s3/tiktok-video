/**
 * Veo video generation module — cost-priority strategy.
 *
 * Generates 8-second cinematic video clips from text prompts using Google's
 * Veo models via the Gemini API. Only used for the HOOK clip (8s opening).
 * Scene slides use Imagen + Ken Burns instead (much cheaper).
 *
 * Pipeline integration:
 *   1. Claude generates hookVeoPrompt (cinematic opening scene)
 *   2. Veo generates 1x 8s hook clip (9:16)
 *   3. FFmpeg composes: hook + Imagen slides + text overlay + voiceover
 *
 * Models (cheapest-first priority):
 *   - veo-2.0-generate-001: Free tier / cheapest — default ("fast")
 *   - veo-3.0-fast-generate-001: Mid-tier, better quality ("standard")
 *   - veo-3.1-generate-preview: Best quality + native audio ("premium")
 *
 * Cost per 8s video: Veo 2.0 ~free, Veo 3.0-fast ~$1.20, Veo 3.1 ~$3.20
 * Rate limits: 2 uses/model/day. Videos retained 2 days.
 */
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const POLL_INTERVAL_MS = 10_000; // 10 seconds between status checks
const MAX_POLL_ATTEMPTS = 60;    // 10 minutes max wait
const MAX_USES_PER_MODEL_PER_DAY = 2;

const MODELS = {
  fast: "veo-2.0-generate-001",          // Free tier / cheapest — default
  standard: "veo-3.0-fast-generate-001", // Mid-tier (~$0.15/s)
  premium: "veo-3.1-generate-preview",   // Best quality + native audio (~$0.40/s)
};

// Priority order: cheapest first — always prefer lower cost
const MODEL_PRIORITY = ["fast", "standard", "premium"];

// Track daily usage per model: { "2026-03-29": { fast: 1, standard: 0, premium: 0 } }
let _dailyUsage = { date: "", counts: {} };

function getTodayUsage() {
  const today = new Date().toISOString().slice(0, 10);
  if (_dailyUsage.date !== today) {
    _dailyUsage = { date: today, counts: {} };
  }
  return _dailyUsage.counts;
}

function recordModelUse(modelKey) {
  const counts = getTodayUsage();
  counts[modelKey] = (counts[modelKey] || 0) + 1;
}

/**
 * Pick the cheapest available Veo model that still has quota today.
 * Returns model key (fast/standard/premium) or null if all exhausted.
 */
export function pickAvailableModel() {
  const counts = getTodayUsage();
  for (const key of MODEL_PRIORITY) {
    const used = counts[key] || 0;
    if (used < MAX_USES_PER_MODEL_PER_DAY) {
      return key;
    }
  }
  return null; // All models exhausted
}

// Scene prompt templates by mood — appended to quote-specific prompts.
// Brightness tuned slightly up per user feedback (Option A: keep cinematic
// feel, just nudge lighting keywords toward brighter/warmer tones).
const SCENE_STYLES = {
  epic: "bright cinematic lighting, luminous golden hour, warm sunbeams piercing clouds, slow camera movement, 4K film grain",
  calm: "bright soft natural light, gentle breeze, serene airy atmosphere, smooth slow-motion, shallow depth of field",
  dark: "twilight with warm ambient glow, soft rain with neon reflections, dusk city scene with street lamps, atmospheric haze",
  nature: "sunlit lush landscape, flowing water catching light, bright morning mist, birds in flight, organic movement",
  abstract: "bright flowing particles, warm cosmic colors, luminous light trails, ethereal glowing atmosphere",
};

let _client;
function getClient() {
  if (!_client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set in environment");
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

/**
 * Generate a single 8-second video clip from a text prompt.
 *
 * @param {string} prompt - Scene description for the video
 * @param {string} outputPath - Where to save the MP4 file
 * @param {Object} [options]
 * @param {string} [options.model] - 'fast' (default) or 'standard'
 * @param {string} [options.aspectRatio] - '9:16' (default) or '16:9'
 * @param {string} [options.resolution] - '720p' or '1080p' (default)
 * @returns {Promise<{path: string, duration: number, model: string, prompt: string}>}
 */
export async function generateVideo(prompt, outputPath, options = {}) {
  const ai = getClient();
  const modelKey = options.model || "fast";
  const model = MODELS[modelKey] || MODELS.fast;

  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  console.log(`[Veo] Generating video (${modelKey})...`);
  console.log(`[Veo] Prompt: "${prompt.slice(0, 80)}..."`);

  const config = { aspectRatio: options.aspectRatio || "9:16" };
  // resolution only supported on Veo 3.x models
  if (model.includes("3.")) {
    config.resolution = options.resolution || "1080p";
  }

  let operation = await ai.models.generateVideos({ model, prompt, config });

  // Poll until done
  let attempts = 0;
  while (!operation.done) {
    if (++attempts > MAX_POLL_ATTEMPTS) {
      throw new Error(`Veo generation timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
    }
    if (attempts % 3 === 0) {
      console.log(`[Veo] Still generating... (${attempts * POLL_INTERVAL_MS / 1000}s elapsed)`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  // Download video
  const videos = operation.response?.generatedVideos;
  if (!videos || videos.length === 0) {
    throw new Error("Veo returned no videos (possible audio processing issue)");
  }

  await ai.files.download({
    file: videos[0].video,
    downloadPath: outputPath,
  });

  console.log(`[Veo] Video saved: ${outputPath}`);
  recordModelUse(modelKey);
  const counts = getTodayUsage();
  console.log(`[Veo] Daily usage: ${MODEL_PRIORITY.map(k => `${k}=${counts[k] || 0}/${MAX_USES_PER_MODEL_PER_DAY}`).join(", ")}`);
  return {
    path: outputPath,
    duration: 8,
    model: modelKey,
    prompt,
  };
}

/**
 * Generate scene prompts for quotes to use with Veo.
 *
 * Takes quotes and returns Veo-optimized scene description prompts
 * that will produce visually engaging backgrounds for text overlay.
 *
 * @param {Array<{text: string, category: string}>} quotes
 * @param {string} [style] - Scene style: 'epic', 'calm', 'dark', 'nature', 'abstract'
 * @returns {string[]} Array of Veo prompts, one per quote
 */
export function buildScenePrompts(quotes, style) {
  const styleKey = style || pickRandomStyle();
  const styleDesc = SCENE_STYLES[styleKey] || SCENE_STYLES.epic;

  return quotes.map((quote, i) => {
    // Generate a scene that complements the quote's mood
    const sceneHint = getSceneHint(quote.text, quote.category);
    return [
      `Vertical video (9:16 aspect ratio).`,
      `${sceneHint}.`,
      `No text, no people talking, no UI elements.`,
      `Background video suitable for text overlay.`,
      `Style: ${styleDesc}.`,
      `Smooth continuous shot, no cuts, loopable.`,
    ].join(" ");
  });
}

/**
 * Pick a scene description hint based on quote content/category.
 */
function getSceneHint(text, category) {
  const hints = {
    "thành công và tham vọng": "A person walking confidently through a modern city at sunrise, skyscrapers reflecting golden light",
    "kỷ luật và thói quen": "Close-up of hands writing in a journal at a wooden desk, warm morning light streaming through window",
    "sức mạnh tinh thần": "A lone tree standing strong against a dramatic stormy sky, roots visible and firm",
    "vượt qua thất bại": "Phoenix-like golden sparks rising from darkness, ember particles floating upward",
    "phát triển bản thân": "Time-lapse of a seed sprouting and growing into a plant, soft backlight",
    "triết lý sống": "Calm ocean waves at twilight, stars beginning to appear, reflection on water",
    "tư duy tài chính": "Gold coins and light beams in a grand library setting, warm amber tones",
    "lãnh đạo và ảnh hưởng": "A lighthouse beam cutting through fog over a dark ocean, powerful and guiding",
    "quản lý thời gian": "Hourglass with golden sand flowing, bokeh lights in background, macro shot",
    "trí tuệ cảm xúc": "Rain on a window with warm indoor light behind, cozy and reflective mood",
  };

  return hints[category] || "Beautiful atmospheric landscape with dramatic lighting and gentle camera movement";
}

function pickRandomStyle() {
  const styles = Object.keys(SCENE_STYLES);
  return styles[Math.floor(Math.random() * styles.length)];
}

export { MODELS, SCENE_STYLES, MODEL_PRIORITY };
