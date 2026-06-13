/**
 * Semantic episode/segment splitter.
 *
 * Given a long video's Chinese SRT (with timestamps), ask an LLM to group
 * consecutive cues into self-contained narrative segments of a target length
 * (default 2-4 min). Cuts fall ONLY on cue boundaries, so we never slice
 * mid-sentence, and segments always cover the whole transcript contiguously.
 *
 * Returns: Array<{ index, start_ms, end_ms, title, cues: Cue[] }>
 *
 * Why LLM over scene/black/silence detection: these donghua recaps have
 * continuous audio and no black transitions (verified: blackdetect=0,
 * silencedetect=0), so the only reliable signal for a *narrative* break is
 * the meaning of the narration itself — which the transcript carries.
 */
import "../env.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { parseSRT } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildPrompt(cues, { minSec, maxSec }) {
  const lines = cues.map((c, i) => {
    const t = (c.start_ms / 1000).toFixed(0);
    return `[${i + 1}] (${t}s) ${c.text}`;
  }).join("\n");

  const totalSec = Math.round(cues[cues.length - 1].end_ms / 1000);
  const targetSegments = Math.max(2, Math.round(totalSec / ((minSec + maxSec) / 2)));

  return `Bạn đang chia một video kể chuyện (tu tiên/cổ trang Trung Quốc) thành các phân cảnh để đăng lại.

Transcript dưới đây là ${cues.length} câu thoại, mỗi câu có [số thứ tự] và (giây bắt đầu). Tổng ${totalSec}s.

NHIỆM VỤ: gom các câu LIÊN TIẾP thành các phân cảnh (segment), sao cho:
- Mỗi segment dài khoảng ${minSec}-${maxSec} giây (ưu tiên ${Math.round((minSec+maxSec)/2)}s). Khoảng ${targetSegments} segments.
- Ranh giới cắt rơi vào điểm NGẮT TỰ NHIÊN của mạch truyện: hết một trận đánh, chuyển cảnh, chuyển nhân vật, hết một sự kiện. KHÔNG cắt giữa một diễn biến đang dở.
- Các segment phải PHỦ KÍN toàn bộ câu (câu 1 đến câu ${cues.length}), liên tục, không bỏ sót, không chồng lấn.
- Mỗi segment đặt 1 tiêu đề tiếng Việt ngắn (≤8 từ) mô tả nội dung chính.

Transcript:
${lines}

TRẢ VỀ DUY NHẤT một mảng JSON, không markdown, không giải thích, theo dạng:
[{"start_cue": 1, "end_cue": 18, "title": "Hàn Lập đại chiến lục đạo"}, {"start_cue": 19, "end_cue": 35, "title": "..."}]`;
}

function stripJson(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/**
 * @param {string} cnSrtPath
 * @param {{minSec?:number, maxSec?:number}} opts
 */
export async function splitSegments(cnSrtPath, { minSec = 120, maxSec = 240 } = {}) {
  const cues = parseSRT(readFileSync(cnSrtPath, "utf8"));
  if (cues.length < 2) throw new Error("split: need at least 2 cues");

  const totalSec = Math.round(cues[cues.length - 1].end_ms / 1000);
  // Short video: no split needed
  if (totalSec <= maxSec) {
    log.info("split", `video ${totalSec}s <= ${maxSec}s — single segment`);
    return [{
      index: 1,
      start_ms: 0,
      end_ms: cues[cues.length - 1].end_ms,
      title: "full",
      cues,
    }];
  }

  log.info("split", `segmenting ${cues.length} cues / ${totalSec}s into ${minSec}-${maxSec}s parts`);

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8000,
    messages: [{ role: "user", content: buildPrompt(cues, { minSec, maxSec }) }],
  });
  const res = await stream.finalMessage();
  const raw = res.content?.[0]?.text || "";

  let groups;
  try {
    groups = JSON.parse(stripJson(raw));
  } catch (e) {
    throw new Error(`split: LLM returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(groups) || !groups.length) {
    throw new Error("split: LLM returned empty grouping");
  }

  // Validate + repair contiguity. Force full coverage: first group starts at
  // cue 1, each subsequent starts right after the previous, last ends at N.
  const N = cues.length;
  const segments = [];
  let cursor = 1;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const startCue = cursor;
    let endCue = Math.min(N, Math.max(startCue, parseInt(g.end_cue, 10) || startCue));
    if (i === groups.length - 1) endCue = N; // last segment absorbs remainder
    if (startCue > N) break;

    const slice = cues.slice(startCue - 1, endCue);
    segments.push({
      index: segments.length + 1,
      start_ms: slice[0].start_ms,
      end_ms: slice[slice.length - 1].end_ms,
      title: (g.title || `phần ${segments.length + 1}`).slice(0, 60),
      cues: slice,
    });
    cursor = endCue + 1;
  }
  // If LLM under-covered, append the tail as one more segment
  if (cursor <= N) {
    const slice = cues.slice(cursor - 1, N);
    segments.push({
      index: segments.length + 1,
      start_ms: slice[0].start_ms,
      end_ms: slice[slice.length - 1].end_ms,
      title: `phần ${segments.length + 1}`,
      cues: slice,
    });
  }

  log.info("split", `→ ${segments.length} segments: ${segments.map(s => `${Math.round((s.end_ms - s.start_ms) / 1000)}s`).join(", ")}`);
  return segments;
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const srt = process.argv[2];
  const minSec = process.argv.includes("--min") ? parseInt(process.argv[process.argv.indexOf("--min") + 1]) : 120;
  const maxSec = process.argv.includes("--max") ? parseInt(process.argv[process.argv.indexOf("--max") + 1]) : 240;
  if (!srt) { console.error("usage: split-segments.mjs <cn_srt> [--min 120] [--max 240]"); process.exit(1); }
  splitSegments(srt, { minSec, maxSec }).then(segs => {
    for (const s of segs) {
      const d = Math.round((s.end_ms - s.start_ms) / 1000);
      const a = (s.start_ms / 1000).toFixed(0), b = (s.end_ms / 1000).toFixed(0);
      console.log(`#${s.index}  ${a}s–${b}s  (${d}s, ${s.cues.length} cues)  ${s.title}`);
    }
  }).catch(e => { console.error(e); process.exit(1); });
}
