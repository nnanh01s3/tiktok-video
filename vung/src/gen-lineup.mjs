/**
 * Generate a character lineup reference showing all 4 characters
 * side-by-side at correct relative heights.
 *
 * This lineup is injected into EVERY scene as size reference.
 * Output: vung/nhan_vat/canonical/lineup.png
 */
import "../../src/env.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { getClient, markKeyExhausted } from "./gemini-keys.js";

const MODEL = "gemini-2.5-flash-image";
const OUTPUT_DIR = "D:/tiktok/vung/nhan_vat/canonical";
const OUTPUT_PATH = `${OUTPUT_DIR}/lineup.png`;

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const PROMPT = [
  "A character lineup height comparison chart showing 4 cartoon animal characters standing side by side on a flat ground line.",
  "From left to right:",
  "1. Momo: a small slim monkey, light brown fur, cream belly, big eyes, long curved tail. Height: SHORT (about 60% of the bear).",
  "2. Tiko: a small wise turtle, green shell with hex pattern, round reddish-brown glasses. Height: SHORTEST (about 40% of the bear).",
  "3. Lala: a stylish female fox, orange fur, white chest and fluffy tail with white tip, pointed ears with dark tips, confident pose. Height: MEDIUM (about 70% of the bear).",
  "4. Bobo: a chubby large bear, brown fur, big cream belly, small eyes, big nose, friendly grin. Height: TALLEST (the biggest character).",
  "All 4 characters standing on the same ground line to clearly show their height differences.",
  "No clothing on any character, natural animal bodies only.",
  "White clean background, centered composition.",
  "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
  "9:16 vertical aspect ratio.",
  "NO TEXT, NO LETTERS, NO NUMBERS, NO WATERMARKS, NO HEIGHT MARKERS, NO GRID LINES.",
  "Negative: realistic, scary, dark, humans, people, clothing, text, numbers, rulers, measurement lines.",
].join(" ");

async function main() {
  if (existsSync(OUTPUT_PATH)) {
    console.log(`[Lineup] File đã tồn tại. Xóa để render lại.`);
    return;
  }

  console.log(`[Lineup] Đang sinh lineup reference...`);
  console.log(`[Lineup] Prompt: "${PROMPT.slice(0, 120)}..."`);

  const maxAttempts = 15;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = getClient("imagen");
    if (!handle) throw new Error("Hết key cho imagen");
    try {
      const res = await handle.client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: PROMPT }] }],
        config: { responseModalities: ["IMAGE"] },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part?.inlineData?.data) throw new Error("Model trả về không có hình");
      const buffer = Buffer.from(part.inlineData.data, "base64");
      writeFileSync(OUTPUT_PATH, buffer);
      console.log(`[Lineup] ✅ Saved: ${OUTPUT_PATH} (${(buffer.length / 1024).toFixed(0)}KB)`);
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "").toLowerCase();
      if (err?.status === 429 || msg.includes("quota") || msg.includes("resource_exhausted")) {
        markKeyExhausted(handle.keyId, "imagen");
        continue;
      }
      if (msg.includes("returned no") || msg.includes("503") || msg.includes("unavailable")) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("Failed after max attempts");
}

main().catch((err) => { console.error("❌", err.message); process.exit(1); });
