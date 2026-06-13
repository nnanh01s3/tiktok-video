/**
 * Recap script generator — the "thuyết minh" (解说) narration style.
 *
 * Instead of translating dialogue line-by-line (which overlaps when spoken),
 * this reads the full Chinese transcript and writes a CONTINUOUS Vietnamese
 * narration that retells the story in flowing "kể chuyện" style — exactly the
 * format VN anime-recap channels use. The output sentences become both the
 * voiceover (read sequentially) and the on-screen captions.
 *
 * Returns: { sentences: string[], target_sec: number }
 */
import "../env.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { parseSRT } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// VN narration ~2.3 spoken words/sec via Edge TTS. Used to size the script
// so the voiceover roughly fills the video length.
const WORDS_PER_SEC = 2.3;

const SYSTEM_PROMPT = `Bạn là người viết kịch bản thuyết minh (lời bình) cho video tóm tắt phim hoạt hình tu tiên Trung Quốc, đăng lại cho khán giả Việt.

PHONG CÁCH:
- Kể chuyện liên tục, mạch lạc, lôi cuốn — như một người dẫn truyện đang thuật lại diễn biến.
- Giọng văn tự nhiên kiểu truyện convert/tiên hiệp mà fan Việt quen thuộc.
- KHÔNG dịch máy từng câu thoại. Hãy KỂ LẠI nội dung: chuyện gì đang xảy ra, ai làm gì, kết quả ra sao.
- Mở đầu cuốn hút, dẫn dắt người xem.

THUẬT NGỮ HÁN-VIỆT (bắt buộc dùng đúng):
- 宗 = Tông, 弟子 = đệ tử, 长老 = trưởng lão, 修为 = tu vi, 法力 = pháp lực
- 元婴 = Nguyên Anh, 金丹 = Kim Đan, 渡劫 = độ kiếp, 神识 = thần thức
- 施术人 = người thi thuật, 半妖化 = bán yêu hóa, 道友 = đạo hữu
- Nhân vật chính 韩立 = Hàn Lập. Dùng "hắn/y/Hàn Lập" cho nam, "nàng" cho nữ.
- Tên tông môn/người: phiên âm Hán-Việt (青云宗 = Thanh Vân Tông).

KỸ THUẬT:
- Mỗi câu NGẮN GỌN (≤ 16 từ) để hiển thị vừa 1-2 dòng caption.
- Câu nối tiếp nhau thành mạch kể liền.`;

function buildPrompt(transcript, targetSentences) {
  return `Dưới đây là nội dung lời thoại/diễn biến (tiếng Trung) của một tập phim hoạt hình tu tiên, theo thứ tự thời gian:

${transcript}

Hãy viết kịch bản THUYẾT MINH tiếng Việt kể lại tập này, khoảng ${targetSentences} câu, kể liên tục theo đúng diễn biến.

TRẢ VỀ DUY NHẤT một mảng JSON các câu, không markdown, không giải thích:
["Câu mở đầu...", "Câu tiếp theo...", ...]`;
}

function stripJson(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/**
 * @param {string} cnSrtPath  full transcript SRT (Chinese)
 * @param {number} videoDurationSec
 */
export async function generateRecap(cnSrtPath, videoDurationSec) {
  const cues = parseSRT(readFileSync(cnSrtPath, "utf8"));
  if (!cues.length) throw new Error("recap: empty transcript");

  // Build a compact time-ordered transcript for the LLM
  const transcript = cues.map(c => {
    const t = Math.round(c.start_ms / 1000);
    return `(${t}s) ${c.text}`;
  }).join("\n");

  // Size the script so spoken length ≈ video length.
  // avg VN caption sentence ≈ 10 words → ~4.3s spoken. Sentences ≈ dur / 4.3.
  const targetSentences = Math.max(8, Math.round(videoDurationSec / 4.3));

  log.info("recap", `generating ~${targetSentences} narration sentences for ${videoDurationSec}s video`);

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(transcript, targetSentences) }],
  });
  const res = await stream.finalMessage();
  const raw = res.content?.[0]?.text || "";

  let sentences;
  try { sentences = JSON.parse(stripJson(raw)); }
  catch { throw new Error(`recap: non-JSON output: ${raw.slice(0, 150)}`); }
  if (!Array.isArray(sentences) || !sentences.length) throw new Error("recap: empty script");

  sentences = sentences.map(s => String(s).trim()).filter(Boolean);
  const words = sentences.join(" ").split(/\s+/).length;
  log.info("recap", `→ ${sentences.length} sentences, ~${words} words (~${Math.round(words / WORDS_PER_SEC)}s spoken)`);

  return { sentences, target_sec: videoDurationSec };
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const srt = process.argv[2];
  const dur = parseInt(process.argv[3] || "200");
  if (!srt) { console.error("usage: recap.mjs <cn_srt> <video_dur_sec>"); process.exit(1); }
  generateRecap(srt, dur).then(r => {
    r.sentences.forEach((s, i) => console.log(`${i + 1}. ${s}`));
  });
}
