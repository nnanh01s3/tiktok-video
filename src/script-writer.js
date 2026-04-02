/**
 * Script writer — uses Claude as VIDEO DIRECTOR.
 *
 * Claude acts as both scriptwriter AND scene director:
 *   - Writes narration script (Vietnamese)
 *   - Creates unique Veo scene prompts per quote (matched to content)
 *   - Ensures visual storytelling progression across slides
 *
 * This creates a tight connection between what is SAID and what is SHOWN.
 */
import Anthropic from "@anthropic-ai/sdk";

let _client;
function client() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Generate a video script from selected quotes (simple version, no scene directions).
 */
export async function writeScript(quotes, options = {}) {
  const style = options.style || "inspirational";
  const targetSeconds = options.targetSeconds || 75;
  const targetWords = Math.round(targetSeconds * 2.5);

  const quoteList = quotes.map((q, i) => {
    const author = q.author && q.author !== "Original" ? ` — ${q.author}` : "";
    const work = q.source_work ? ` (${q.source_work})` : "";
    return `${i + 1}. "${q.text}"${author}${work}`;
  }).join("\n");

  const response = await client().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Tạo kịch bản thuyết minh TikTok bằng TIẾNG VIỆT từ các câu nói sau. Phong cách: ${style}.

CÂU NÓI:
${quoteList}

QUY TẮC:
- Mục tiêu: ~${targetSeconds} giây (~${targetWords} từ ở tốc độ 2.5 từ/giây)
- Bắt đầu bằng HOOK (3 giây đầu phải gây chú ý ngay)
- Dệt các câu nói vào một câu chuyện mạch lạc — KHÔNG đọc lần lượt từng câu
- Thêm câu chuyển tiếp ngắn giữa các quote (1-2 câu tối đa)
- Kết thúc bằng câu kết mạnh mẽ, để lại suy nghĩ (KHÔNG kêu gọi follow/subscribe/like)
- Giọng: tự tin, sâu lắng, hơi kịch tính, truyền cảm hứng
- KHÔNG dùng hashtag trong kịch bản
- PHẢI viết hoàn toàn bằng tiếng Việt có dấu

Return JSON:
{
  "script": "Toàn bộ kịch bản thuyết minh bằng tiếng Việt...",
  "caption": "Caption TikTok tiếng Việt (1-2 câu, hấp dẫn, dưới 150 ký tự)",
  "hookLine": "Câu đầu tiên của kịch bản (hook)",
  "estimatedSeconds": number
}

Return ONLY the JSON. No markdown.`,
      },
    ],
  });

  const raw = response.content[0].text.trim();
  const json = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(json);
}

/**
 * Generate video script + scene directions for Veo (director mode).
 *
 * Claude acts as a video director — for each quote, it creates:
 *   - A segment of the narration script
 *   - A detailed Veo scene prompt that MATCHES the quote's meaning
 *   - Visual storytelling that progresses across slides
 *
 * @param {Array<{text: string, category: string}>} quotes
 * @param {Object} options
 * @returns {Promise<{script, caption, hookLine, estimatedSeconds, scenes: Array<{quoteIndex, veoPrompt, mood}>}>}
 */
export async function writeDirectorScript(quotes, options = {}) {
  const style = options.style || "inspirational";
  const targetSeconds = options.targetSeconds || 90;
  const targetWords = Math.round(targetSeconds * 2.5);

  const quoteList = quotes.map((q, i) => {
    const author = q.author && q.author !== "Original" ? ` — ${q.author}` : "";
    const work = q.source_work ? ` (${q.source_work})` : "";
    return `${i + 1}. "${q.text}"${author}${work} [Chủ đề: ${q.category}]`;
  }).join("\n");

  const response = await client().messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Bạn là ĐẠO DIỄN VIDEO cho kênh TikTok truyền cảm hứng tiếng Việt.

Từ các câu nói dưới đây, tạo KẾ HOẠCH VIDEO hoàn chỉnh gồm:
1. Kịch bản thuyết minh (tiếng Việt)
2. Mô tả cảnh quay CHI TIẾT cho từng quote (để tạo video AI)

CÂU NÓI:
${quoteList}

QUY TẮC KỊCH BẢN:
- Mục tiêu: ~${targetSeconds} giây (~${targetWords} từ ở tốc độ 2.5 từ/giây tiếng Việt)
- Bắt đầu bằng HOOK mạnh (3 giây đầu gây chú ý)
- Dệt các câu nói vào câu chuyện mạch lạc
- Kết thúc bằng câu kết mạnh mẽ, để lại suy nghĩ (KHÔNG kêu gọi follow/subscribe/like)
- Giọng: tự tin, sâu lắng, truyền cảm hứng
- PHẢI viết tiếng Việt có dấu đầy đủ

QUY TẮC CẢNH QUAY (scenes):
- Mỗi quote cần 1 mô tả cảnh quay KHÁC NHAU bằng tiếng Anh
- Cảnh phải LIÊN QUAN TRỰC TIẾP đến ý nghĩa của quote
- Ví dụ: quote về "vượt qua thất bại" → cảnh phoenix rising from ashes, NOT biển yên tĩnh
- Ví dụ: quote về "thời gian" → cảnh hourglass hoặc sunset timelapse, NOT rừng cây
- MỖI cảnh phải KHÁC BIỆT về địa điểm, ánh sáng, tông màu
- Phải có sự tiến triển hình ảnh: cảnh 1 tối/mơ hồ → cảnh cuối sáng/rõ ràng
- Format: "Vertical 9:16 video. [mô tả cảnh]. No text, no people talking. Cinematic, smooth camera movement."

QUY TẮC HOOK VIDEO (hookVeoPrompt) — Veo 3.1 với ÂM THANH tự nhiên:
- Tạo 1 prompt cho video MỞ ĐẦU 8 giây bằng Veo 3.1 (model có tạo ÂM THANH sống động)
- Cảnh phải THỂ HIỆN TRỰC TIẾP chủ đề chính xuyên suốt các câu nói:
  + Đọc TẤT CẢ quotes → xác định CHỦ ĐỀ CỐT LÕI → tạo cảnh BIỂU TƯỢNG cho chủ đề đó, có thể chuyển nhiều cảnh tương ứng với từng câu nói
- ÂM THANH SỐNG ĐỘNG (ambient sound, KHÔNG phải nhạc nền):
  + BẮT BUỘC ghi rõ âm thanh trong prompt: "Sound of..." hoặc "Audio: ..."
  + Ưu tiên: tiếng thiên nhiên (sóng, gió, mưa, sấm), tiếng bước chân, tiếng nước chảy, tiếng thành phố — tạo immersive experience
  + Âm thanh phải ĐỒNG BỘ với hình ảnh và cảm xúc của chủ đề
- CHUYỂN ĐỘNG CAMERA dramatic và có kịch tính:
  + Bắt đầu close-up → pull back reveal toàn cảnh
  + Hoặc aerial descending vào chủ thể
  + Hoặc tracking shot xuyên qua cảnh
  + Hoặc dolly zoom tạo hiệu ứng vertigo
- Format BẮT BUỘC:
  "Vertical 9:16 cinematic video, 8 seconds. [Mô tả cảnh CHI TIẾT liên quan trực tiếp đến chủ đề quotes]. Camera: [chuyển động camera cụ thể]. Sound: [âm thanh tự nhiên cụ thể, mô tả chi tiết]. Mood: [cảm xúc]. Hyperrealistic, film grain, no text overlay, no speech, no background music."


Return JSON:
{
  "script": "Toàn bộ kịch bản thuyết minh tiếng Việt...",
  "caption": "Caption TikTok tiếng Việt (dưới 150 ký tự)",
  "hookLine": "Câu đầu tiên (hook)",
  "estimatedSeconds": number,
  "hookVeoPrompt": "Vertical 9:16 cinematic video, 8 seconds. [detailed scene in English matching quote themes]. Camera: [specific movement]. Sound: [specific natural ambient sounds]. Mood: [emotion]. Hyperrealistic, film grain, no text overlay, no speech, no background music.",
  "scenes": [
    {
      "quoteIndex": 0,
      "veoPrompt": "Vertical 9:16 video. [mô tả cảnh chi tiết bằng tiếng Anh]...",
      "mood": "tên mood ngắn (vd: epic, serene, dramatic, hopeful)"
    }
  ]
}

Return ONLY the JSON. No markdown.`,
      },
    ],
  });

  const raw = response.content[0].text.trim();
  const json = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(json);
}
