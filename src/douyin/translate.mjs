/**
 * Translate Chinese SRT cues to Vietnamese using Claude Haiku.
 */
import "../env.js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { parseSRT, serializeSRT } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SYSTEM_PROMPT = `Bạn là dịch giả chuyên dịch phụ đề video kể chuyện Douyin từ tiếng Trung sang tiếng Việt.

THỂ LOẠI: tu tiên / cổ trang / huyền huyễn (immortal cultivation, ancient sects, spiritual awakening).
Đây là thể loại quen thuộc với độc giả Việt qua truyện convert/dịch: Tu Chân, Tiên Hiệp, Đấu Phá, v.v.

QUY TẮC DỊCH TÊN/CHỨC DANH (HÁN-VIỆT — BẮT BUỘC):
- 宗 (zōng) = "Tông" (KHÔNG dịch "giáo phái"). Vd: 青雲宗 → "Thanh Vân Tông"
- 弟子 = "đệ tử". 雜役弟子 → "đệ tử tạp dịch" (KHÔNG "dạo tạp")
- 內門/外門 弟子 = "đệ tử nội môn / ngoại môn"
- 長老 = "trưởng lão". 掌門 = "chưởng môn". 師父 = "sư phụ". 師兄/師姐 = "sư huynh / sư tỷ"
- 真人 = "chân nhân". 仙人 = "tiên nhân". 道友 = "đạo hữu"
- Nhân xưng: dùng "ta/hắn/y/nàng/lão già" thay "tôi/anh ta/cô ta/ông già" cho ngữ cảnh cổ trang.

IDIOM/THÀNH NGỮ — TRÁNH DỊCH THEO MẶT CHỮ:
- 苟且 = "lay lắt" / "sống tạm bợ" / "đắp đổi qua ngày" (KHÔNG "lợp lẽ" hay "tạm bợ qua")
- 苟且一生 = "lay lắt sống một đời" / "tạm bợ một kiếp"
- 爛骨頭 = "đám lười nhác" / "lũ vô tích sự" (KHÔNG "xương rách" - đó là dịch chữ sai)
- 死挺著 = "cứ ì ra đó" / "lì ra"
- 太陽曬屁股 = "mặt trời đã rọi vào đít rồi" (giữ idiom hình ảnh, hợp văn nói)
- 寫照 = "hình ảnh chân thực" / "bức tranh"
- 階級地位 = "địa vị giai cấp"
- 雜糧飯 = "cơm tạp lương" / "cơm độn"
- 修煉 = "tu luyện". 突破 = "đột phá". 境界 = "cảnh giới". 渡劫 = "độ kiếp"
- 元神/元嬰 = "nguyên thần / nguyên anh". 金丹 = "kim đan"

VĂN PHONG:
- Tự nhiên, dễ đọc, giữ nhịp kể chuyện (KHÔNG cứng nhắc theo cấu trúc Trung văn).
- Cảm xúc giữ đúng tone gốc (đói khổ, tủi nhục, phẫn nộ, giác ngộ...).
- Câu ngắn vừa khung hình subtitle.

GIỚI HẠN KỸ THUẬT:
- Mỗi dòng VN ≤ 1.5× số ký tự CN (để fit subtitle timing).
- Giữ NGUYÊN số thứ tự cue và timestamps — không sửa.

OUTPUT:
- SRT hợp lệ, chỉ tiếng Việt, không markdown, không giải thích.
- Có dòng trống giữa các cue.`;

function buildPrompt(numberedLines, context) {
  return `Dịch các câu thoại tiếng Trung sau sang tiếng Việt.

${context ? `Bối cảnh: ${context}\n\n` : ""}Mỗi dòng có dạng [số] nội-dung-tiếng-Trung:
${numberedLines}

YÊU CẦU OUTPUT — RẤT QUAN TRỌNG:
- Trả về DUY NHẤT một mảng JSON, không markdown, không giải thích.
- Mỗi phần tử: {"n": <số dòng>, "t": "<bản dịch tiếng Việt>"}
- Phải có ĐỦ và ĐÚNG mọi số dòng từ 1 đến ${numberedLines.split("\n").length}, mỗi dòng đúng 1 phần tử. KHÔNG gộp, KHÔNG bỏ dòng nào (kể cả câu rất ngắn như "找死" → vẫn là 1 dòng riêng).
- Chỉ dịch phần nội dung; số dòng giữ nguyên để khớp timing.

Ví dụ: [{"n":1,"t":"Ban đầu..."},{"n":2,"t":"chồng lên..."}]`;
}

function stripJson(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

async function callClaude(numberedLines, context) {
  // Streaming required: with max_tokens 32k the SDK rejects non-streaming.
  const stream = anthropic.messages.stream({
    // Sonnet: cultivation vocabulary needs stronger reasoning than Haiku to
    // avoid literal-character mistakes (爛骨頭 → "đám lười nhác", not "xương rách").
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(numberedLines, context) }],
  });
  const res = await stream.finalMessage();
  if (res.stop_reason === "max_tokens") {
    throw new Error(`translate truncated at max_tokens (input too long)`);
  }
  return res.content?.[0]?.text || "";
}

/**
 * Index-based translation: send numbered Chinese lines, get back a JSON array
 * of {n, t}, then rebuild the VN SRT using the SOURCE timing keyed by index.
 *
 * Why: the old approach asked Claude to reproduce the whole SRT (numbers +
 * timestamps + text), and Claude occasionally merged two short adjacent cues,
 * dropping the count by 1 and failing strict validation. Decoupling timing
 * (always from source) from translation (text-by-index) makes timing perfect
 * and tolerant of minor index gaps (filled with the original text).
 */
export async function translateSRT(cn_srt_path, vn_srt_path, { context = "" } = {}) {
  const cnCues = parseSRT(readFileSync(cn_srt_path, "utf8"));
  if (!cnCues.length) throw new Error("translate: no cues in source SRT");

  const numbered = cnCues.map((c, i) => `[${i + 1}] ${c.text}`).join("\n");

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log.info("translate", `Claude attempt ${attempt}/2 (${cnCues.length} cues, index-based)`);
      const raw = await callClaude(numbered, context);

      let arr;
      try { arr = JSON.parse(stripJson(raw)); }
      catch { throw new Error(`non-JSON output: ${raw.slice(0, 120)}`); }
      if (!Array.isArray(arr)) throw new Error("output not a JSON array");

      // Map index → VN text
      const byN = new Map();
      for (const item of arr) {
        const n = parseInt(item?.n, 10);
        if (n >= 1 && n <= cnCues.length && typeof item.t === "string") byN.set(n, item.t.trim());
      }

      // Require most cues present; fill small gaps with the original CN text
      // rather than failing the whole segment.
      const missing = [];
      const vnCues = cnCues.map((c, i) => {
        const n = i + 1;
        const t = byN.get(n);
        if (t == null || t === "") { missing.push(n); return { ...c, text: c.text }; }
        return { ...c, text: t };
      });
      if (missing.length > cnCues.length * 0.15) {
        throw new Error(`too many untranslated cues: ${missing.length}/${cnCues.length}`);
      }
      if (missing.length) log.warn("translate", `${missing.length} cue(s) left as source (gaps: ${missing.slice(0, 8).join(",")})`);

      const ratios = vnCues.map((v, i) => v.text.length / Math.max(1, cnCues[i].text.length));
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      if (avg > 1.8) log.warn("translate", `VN/CN char_ratio=${avg.toFixed(2)} > 1.8 — sub may overflow`);

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
