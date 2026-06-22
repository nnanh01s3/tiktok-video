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

QUY TẮC CAPTION:
- Dòng 1: Tiêu đề ngắn gọn 3-6 từ diễn tả nội dung video (KHÔNG lặp lại tên category)
  + VD: "Sức mạnh từ bên trong", "Khi nỗi sợ trở thành động lực", "Bài học ngàn năm còn đúng"
- Dòng 2 (xuống dòng): Mô tả hấp dẫn 1-2 câu + emoji + hashtags
- Ví dụ hoàn chỉnh:
  "Nghị lực thép\nKhông phải không ngã, mà là luôn biết đứng dậy 💪 #nghiluc #phatgiao #mandela"

QUY TẮC HOOK — TUYỆT ĐỐI KHÔNG LẶP:
- CẤM các mẫu câu hook sau (quá nhàm chán):
  + "Bạn có biết..."
  + "Bạn có bao giờ..."
  + "Có bao giờ bạn..."
  + "Bạn đã bao giờ..."
  + "Có bao nhiêu lần..."
  + Bất kỳ câu hỏi yes/no dạng "Bạn có [verb]..."
- THAY BẰNG các kiểu hook sáng tạo hơn:
  + Tuyên bố gây sốc: "Người ta nói sai hết về [chủ đề]."
  + Mâu thuẫn: "Càng cố gắng, bạn càng thất bại — và đó chính là bí mật."
  + Câu chuyện ngắn: "Năm 1945, một người đàn ông gầy gò bước lên bục..."
  + Trích dẫn trực tiếp: Mở đầu bằng chính câu quote mạnh nhất
  + Thách thức: "Thử đọc hết video này mà không thay đổi suy nghĩ."
  + Sự thật bất ngờ: "90% người giàu có một điểm chung duy nhất."
  + Hình ảnh mạnh: "Hãy tưởng tượng bạn đang đứng trước vực thẳm..."

QUY TẮC HÁN-VIỆT:
- Nếu câu nói gốc chứa từ Hán-Việt khó hiểu (ví dụ: "tri hành hợp nhất", "tinh tấn", "khí tiết"), PHẢI giải thích ngắn gọn trong kịch bản ngay sau khi trích dẫn
- Ví dụ: "Tri hành hợp nhất — nghĩa là hiểu biết và hành động phải đi đôi với nhau."
- Ví dụ: "Tinh tấn — tức là nỗ lực không ngừng nghỉ."
- KHÔNG bỏ qua, KHÔNG giả định người xem hiểu Hán-Việt
- Giải thích tự nhiên, không cứng nhắc, hòa vào mạch kể chuyện

QUY TẮC CẢNH QUAY (scenes) — HÌNH ẢNH PHẢI KHỚP VỚI NỘI DUNG:
- Mỗi quote sẽ được HIỂN THỊ dưới dạng text overlay trên hình nền
- Hình nền (scene) PHẢI minh họa CHÍNH XÁC nội dung quote đang hiển thị
- CÁCH LÀM ĐÚNG:
  + Đọc quote → xác định HÌNH ẢNH CỤ THỂ được nhắc đến hoặc ẩn dụ trong quote
  + Quote "Lá lành đùm lá rách" → hình lá xanh che chở lá héo trong mưa
  + Quote "Thời gian là vàng" → cát vàng chảy trong đồng hồ cát cổ
  + Quote "Tri hành hợp nhất" → người vừa đọc sách vừa thực hành (ví dụ: thợ mộc đọc bản vẽ rồi đẽo gỗ)
  + Quote về Trần Hưng Đạo → cảnh quân đội Việt cổ, sông Bạch Đằng
- CÁCH LÀM SAI (TRÁNH):
  + Quote cụ thể về chiến tranh → hình generic bình minh yên tĩnh
  + Quote về kỷ luật → hình chim bay trên biển (không liên quan)
  + Quote về lòng nhân ái → hình núi non hùng vĩ (generic)
  + Dùng hình "đẹp nhưng vô nghĩa" không liên quan đến nội dung
- MỖI cảnh phải KHÁC BIỆT về địa điểm, ánh sáng, tông màu
- Phải có sự tiến triển hình ảnh: cảnh 1 mờ/bình minh → cảnh cuối sáng rõ/rực rỡ
- ÁNH SÁNG phải SÁNG và ẤM ÁP (bright, warm, well-lit):
  + Ưu tiên: golden hour, morning light, soft daylight, warm sunbeams, luminous atmosphere
  + TRÁNH: dark/moody/night/rainy/foggy (trừ khi quote THẬT SỰ cần dark aesthetic)
  + Ngay cả cảnh "nghiêm trọng/kịch tính" cũng nên có bright accent lighting (candlelight, lantern glow, sunlit dust particles)
- Format: "Vertical 9:16 video. [mô tả cảnh CỤ THỂ matching quote content]. Bright cinematic lighting, warm tones. No text, no people talking. Cinematic, smooth camera movement."

QUY TẮC HOOK VIDEO (hookVeoPrompt) — Veo 3.1 với ÂM THANH tự nhiên:
- Tạo 1 prompt cho video MỞ ĐẦU 8 giây bằng Veo 3.1 (model có tạo ÂM THANH sống động)
- Cảnh phải THỂ HIỆN TRỰC TIẾP chủ đề chính xuyên suốt các câu nói:
  + Đọc TẤT CẢ quotes → xác định CHỦ ĐỀ CỐT LÕI → tạo cảnh BIỂU TƯỢNG cụ thể cho chủ đề đó
  + KHÔNG dùng cảnh generic (temple, sunset, mountain) nếu không liên quan trực tiếp
  + VÍ DỤ ĐÚNG: quotes về nghị lực → chiến binh đứng dậy sau trận chiến, KHÔNG phải cảnh bình minh đẹp
  + VÍ DỤ ĐÚNG: quotes về thời gian → đồng hồ cát khổng lồ với cát chảy, KHÔNG phải temple vô hồn
- ÂM THANH SỐNG ĐỘNG (ambient sound, KHÔNG phải nhạc nền):
  + BẮT BUỘC ghi rõ âm thanh trong prompt: "Sound of..." hoặc "Audio: ..."
  + Ưu tiên: tiếng thiên nhiên (sóng, gió, mưa, sấm), tiếng bước chân, tiếng nước chảy, tiếng thành phố — tạo immersive experience
  + Âm thanh phải ĐỒNG BỘ với hình ảnh và cảm xúc của chủ đề
- CHUYỂN ĐỘNG CAMERA dramatic và có kịch tính:
  + Bắt đầu close-up → pull back reveal toàn cảnh
  + Hoặc aerial descending vào chủ thể
  + Hoặc tracking shot xuyên qua cảnh
  + Hoặc dolly zoom tạo hiệu ứng vertigo
- ÁNH SÁNG của HOOK phải SÁNG ẤM cuốn hút ngay từ giây đầu:
  + Ưu tiên golden hour, warm morning light, luminous atmosphere, bright well-lit composition
  + Tránh tone đen tối toàn bộ khung hình; nếu dramatic, dùng warm accent lighting
- Format BẮT BUỘC:
  "Vertical 9:16 cinematic video, 8 seconds. [Mô tả cảnh CHI TIẾT liên quan trực tiếp đến chủ đề quotes]. Camera: [chuyển động camera cụ thể]. Sound: [âm thanh tự nhiên cụ thể, mô tả chi tiết]. Lighting: bright cinematic with warm tones. Mood: [cảm xúc]. Hyperrealistic, film grain, no text overlay, no speech, no background music."


Return JSON:
{
  "script": "Toàn bộ kịch bản thuyết minh tiếng Việt...",
  "caption": "Tiêu đề ngắn 3-6 từ (VD: 'Sức mạnh của nghị lực', 'Bài học từ thất bại')\\nMô tả hấp dẫn 1-2 câu + hashtags",
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
