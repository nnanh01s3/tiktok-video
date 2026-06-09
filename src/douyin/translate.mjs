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
    // Upgrade Haiku → Sonnet for translation: cultivation vocabulary needs
    // stronger reasoning than Haiku to avoid literal-character translation
    // mistakes (e.g., 爛骨頭 idiom → "xương rách" wrong, "đám lười nhác" right).
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8192,
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
