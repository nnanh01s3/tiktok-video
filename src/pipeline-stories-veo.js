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
