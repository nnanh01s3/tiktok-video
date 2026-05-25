/**
 * Translate Chinese SRT cues to Vietnamese using Claude Haiku.
 */
import "../env.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { parseSRT, serializeSRT, validateSRTMatch } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SYSTEM_PROMPT = `You are translating Douyin storytelling video subtitles from Chinese to Vietnamese.

Context: spiritual/philosophical/cổ trang narrative (e.g., immortals, awakening, meditation, ancient stories).

Style requirements:
- Natural Vietnamese kể chuyện, giữ nhịp narrative.
- When relevant, use traditional vocabulary: "thiên thần", "giác ngộ", "tu sĩ", "căn nguyên", "linh hồn", "kiếp", "đạo".
- Use "ngài / vị ấy / hắn" depending on tone (avoid bland "anh ta" / "ông ta" for spiritual contexts).
- Each Vietnamese line must NOT exceed 1.5× the Chinese line character count (for subtitle timing fit).

Output requirements:
- Same cue numbering as input.
- Same timestamps EXACTLY as input (do not adjust timing).
- Vietnamese text only — no Chinese, no commentary, no markdown.
- Valid SRT format with blank line between cues.`;

function buildPrompt(cnSrtText, context) {
  return `Translate the following Chinese SRT to Vietnamese.

${context ? `Additional context: ${context}\n\n` : ""}Input SRT:
${cnSrtText}

Output the complete translated SRT now:`;
}

async function callClaude(cnSrtText, context, stricter = false) {
  const sys = stricter
    ? SYSTEM_PROMPT + "\n\nCRITICAL: previous attempt had invalid output. You MUST preserve cue numbering and timestamps EXACTLY as input. Output VALID SRT format with blank line between cues."
    : SYSTEM_PROMPT;
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: sys,
    messages: [{ role: "user", content: buildPrompt(cnSrtText, context) }],
  });
  return res.content?.[0]?.text || "";
}

export async function translateSRT(cn_srt_path, vn_srt_path, { context = "" } = {}) {
  const cnText = readFileSync(cn_srt_path, "utf8");
  const cnCues = parseSRT(cnText);
  if (!cnCues.length) throw new Error("translate: no cues in source SRT");

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log.info("translate", `Claude attempt ${attempt}/2 (${cnCues.length} cues)`);
      const vnText = await callClaude(cnText, context, attempt > 1);
      const vnCues = parseSRT(vnText);
      const { ok, errors } = validateSRTMatch(cnCues, vnCues, 50);
      if (!ok) {
        throw new Error(`SRT mismatch: ${errors.join("; ")}`);
      }
      const ratios = vnCues.map((v, i) => v.text.length / Math.max(1, cnCues[i].text.length));
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      if (avg > 1.8) {
        log.warn("translate", `VN/CN char_ratio=${avg.toFixed(2)} > 1.8 — sub may overflow`);
      }
      writeFileSync(vn_srt_path, serializeSRT(vnCues));
      return { vn_srt_path, cue_count: vnCues.length, char_ratio: avg };
    } catch (e) {
      lastErr = e;
      log.warn("translate", `attempt ${attempt} failed: ${e.message}`);
      if (attempt < 2) await sleep(2000);
    }
  }
  throw new Error(`translate failed after 2 attempts: ${lastErr.message}`);
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const cn = process.argv[2];
  const vn = process.argv[3] || cn.replace("_cn.srt", "_vn.srt");
  if (!cn) { console.error("usage: translate.mjs <cn_srt> [vn_srt]"); process.exit(1); }
  translateSRT(cn, vn).then(r => console.log(JSON.stringify(r, null, 2)));
}
