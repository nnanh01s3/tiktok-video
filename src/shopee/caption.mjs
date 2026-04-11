/**
 * AI Caption Generator - dùng Claude để viết caption + hashtag tự nhiên
 * Dùng chung cho shopee_reup, tech_reup, baby_reup
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Gọi Claude để generate caption viral cho Facebook/TikTok
 * @param {string} videoTitle - Tiêu đề video gốc
 * @param {string} videoChannel - Kênh đăng video gốc
 * @param {string} pageName - Tên page đăng (VD: "SƯU TẦM HÀNG DỊ")
 * @param {string} niche - Niche của page (VD: "đồ gia dụng shopee", "công nghệ", "đồ cho bé")
 * @param {string} platform - "facebook" hoặc "tiktok"
 */
export async function genCaptionAI(videoTitle, videoChannel, pageName, niche, platform = "facebook") {
  const prompt = `Viết mô tả ngắn cho video sản phẩm Shopee.

Sản phẩm: "${videoTitle}"
Page: ${pageName} (${niche})

YÊU CẦU BẮT BUỘC:
- Chỉ 2-3 câu ngắn gọn, súc tích, gây tò mò
- Viết tự nhiên như người thật review, KHÔNG quảng cáo
- KHÔNG có CTA (comment/follow/mua ngay), KHÔNG nhắc link hay bio
- Cuối cùng thêm 1 dòng 6-8 hashtag phù hợp (mix tiếng Việt + Anh)

VÍ DỤ TỐT:
"Cái quạt mini này gió mạnh bất ngờ, pin 5000mAh dùng cả ngày không hết. Mùa hè năm nay khỏi lo nóng.
#quatmini #shopee #muasamonline #shopeefinds #quatcamtay #muahe"

Chỉ trả về caption thuần túy, không giải thích gì thêm.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // Haiku 4.5 - nhanh, rẻ, chất lượng tốt hơn
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API error ${response.status}: ${err.slice(0, 100)}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.log(`   ⚠️ AI caption failed: ${e.message.slice(0, 80)}, dùng fallback`);
    return null;
  }
}

/**
 * Fallback caption nếu AI fail
 */
export function genCaptionFallback(videoTitle, pageName, niche) {
  const orig = videoTitle.slice(0, 60);
  return `Mới tìm được "${orig}" trên Shopee, dùng thử thấy ổn hơn mình nghĩ.`;
}
