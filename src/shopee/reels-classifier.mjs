/**
 * Reels content relevance classifier.
 *
 * Uses Gemini 2.5 Flash to score whether a video (title + source metadata)
 * matches a page's topic description. Fails open on API errors so outages
 * don't block the whole pipeline.
 */
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM = `Bạn là content moderator cho 1 fanpage Facebook. Nhiệm vụ: đánh giá video có đúng chủ đề fanpage không.

Trả về JSON EXACTLY theo schema:
{"match": true|false, "score": 0.0-1.0, "reason": "giải thích ngắn tiếng Việt"}

Quy tắc:
- score >= 0.7 → match=true (đúng chủ đề, có thể post)
- score < 0.7 → match=false (lệch chủ đề, bỏ qua)
- "reason" TỐI ĐA 20 từ, tiếng Việt
- Đọc kỹ phần "KHÔNG bao gồm" của chủ đề — video rơi vào các pattern đó phải match=false dù source có vẻ đúng niche`;

/**
 * @param {{id?: string, title?: string, duration?: number, source_name?: string}} video
 * @param {string} topic - PAGES[pageName].topic
 * @returns {Promise<{match: boolean, score: number, reason: string}>}
 */
export async function classifyRelevance(video, topic) {
  if (!topic) return { match: true, score: 0.5, reason: "no topic defined" };

  const prompt = `CHỦ ĐỀ FANPAGE: ${topic}

VIDEO CẦN ĐÁNH GIÁ:
- Title/caption: "${(video.title || "(no title)").slice(0, 300)}"
- Source: ${video.source_name || "unknown"}
- Duration: ${video.duration || "?"}s

Video này có đúng chủ đề fanpage không?`;

  try {
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM,
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });
    const text = res.text || res.response?.text?.() || "";
    const json = JSON.parse(text);
    const matched = Boolean(json.match);
    return {
      match: matched,
      score: typeof json.score === "number" ? json.score : (matched ? 0.75 : 0.25),
      reason: String(json.reason || "").slice(0, 200),
    };
  } catch (e) {
    // Fail-open: don't block pipeline on classifier error
    console.error(`[classifier] Error: ${(e.message || String(e)).slice(0, 150)}`);
    return { match: true, score: 0.5, reason: `classifier error: ${(e.message || "").slice(0, 80)}` };
  }
}
