/**
 * AI caption generator for Reels pipeline.
 *
 * Replaces the legacy hardcoded 8-hook rotation in reels.mjs:makeCaption().
 * Each post gets a unique caption from Gemini 2.5 Flash, with fallback to
 * an expanded hook list if API fails (fail-open like the classifier).
 *
 * Cost: ~24 posts/day × ~150 tokens × $0.30/M = ~$0.001/day = $0.03/month.
 * Latency: +1-2s per call. Sequential within worker, parallel across pages.
 */
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM = `Bạn là content creator viết caption cho fanpage Facebook tiếng Việt.
Nhiệm vụ: viết caption ngắn cho video Reels dựa vào tiêu đề gốc + niche fanpage.

QUY TẮC BẮT BUỘC:
- 2-3 câu ngắn (tổng 100-280 ký tự, KHÔNG đếm hashtag)
- Tone tự nhiên, gần gũi, đa dạng — chọn 1 trong 4 phong cách phù hợp content:
  (a) Curiosity hook ("Bạn có biết...?", "Sự thật là...")
  (b) Empathy/observation ("Có những lúc...", "Ai cũng từng...")
  (c) Insight/teaser ("Đọc xong nhận ra...", "Điều ít ai chú ý...")
  (d) Casual/relate ("Tới đây mới biết...", "Thấy đúng quá luôn...")
- KHÔNG dùng các từ overused: "đỉnh", "đỉnh của đỉnh", "ghiền", "không xem là tiếc", "hóng từng ngày"
- KHÔNG có CTA: KHÔNG nhắc share/like/comment/follow/link
- KHÔNG copy hashtag từ tiêu đề gốc (vd: #schannel, #duongdereview — bỏ hết)
- Hashtag dòng cuối: 5-7 hashtag tiếng Việt mix Anh, theo niche; PHẢI kết thúc bằng #trendingvideo #trend
- KHÔNG giải thích, KHÔNG meta-comment — chỉ trả về caption thuần.

VÍ DỤ TỐT:
"Cứ tưởng cái máy nhỏ xíu này chỉ để decoration, ai dè dùng cả ngày không thấy mệt.
Mới biết một điều: tiện ích thật sự đôi khi nằm ở chỗ ít ai để ý.

#giadung #lifehack #meovathay #nhabep #fyp #trendingvideo #trend"

VÍ DỤ XẤU:
- "Xem xong là ghiền luôn!" (overused)
- "MUA NGAY tại link bio!" (CTA)
- "Đỉnh của đỉnh!" (overused)
- "#schannel #review" (copy hashtag từ source)`;

/**
 * @param {{title?: string, source_name?: string}} video
 * @param {string} niche - page key (shopee, gia_dung, ...)
 * @param {string} pageName - human-readable page name (Sưu Tầm Hàng Dị, ...)
 * @param {string} [topic] - optional topic description for context
 * @returns {Promise<string|null>} caption text, or null if API fails (caller fallback)
 */
export async function genReelsCaption(video, niche, pageName, topic = "") {
  const title = (video.title || "").slice(0, 200);
  if (!title) return null;

  const userPrompt = `FANPAGE: ${pageName} (niche: ${niche})
${topic ? `Chủ đề: ${topic.slice(0, 200)}\n` : ""}
TIÊU ĐỀ VIDEO GỐC: "${title}"

Viết caption phù hợp.`;

  try {
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: SYSTEM,
        temperature: 0.9, // higher = more variety
        maxOutputTokens: 800,
        // Disable thinking budget (2.5-flash thinks before outputting by
        // default — eats maxOutputTokens budget, cuts real content).
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const text = (res.text || res.response?.text?.() || "").trim();
    // Sanity check: must contain hashtag block
    if (!text || !text.includes("#trendingvideo")) {
      console.error(`[reels-caption] missing #trendingvideo, fallback`);
      return null;
    }
    return text;
  } catch (e) {
    console.error(`[reels-caption] Error: ${(e.message || String(e)).slice(0, 150)}`);
    return null;
  }
}
