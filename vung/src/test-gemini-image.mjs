/**
 * Smoke test: verify gemini-2.5-flash-image accessible via key pool.
 * Usage: node vung/src/test-gemini-image.mjs
 */
import "../../src/env.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { getClient } from "./gemini-keys.js";

const MODEL = "gemini-2.5-flash-image";
const OUTPUT_DIR = "D:/tiktok/vung/output/_test";
const OUTPUT_PATH = `${OUTPUT_DIR}/smoke.png`;

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

async function main() {
  console.log(`[Test] Checking model ${MODEL} via key pool...`);
  const handle = getClient("imagen");
  if (!handle) {
    console.error("[Test] ❌ No keys available for imagen");
    process.exit(1);
  }
  try {
    const res = await handle.client.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: "A cute cartoon bear in a forest, pixar 3D style, vibrant colors, 9:16 vertical. NO TEXT." }] }],
      config: { responseModalities: ["IMAGE"] },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData?.data) {
      console.error("[Test] ❌ Model returned no image");
      process.exit(1);
    }
    const buffer = Buffer.from(part.inlineData.data, "base64");
    writeFileSync(OUTPUT_PATH, buffer);
    console.log(`[Test] ✅ Success! ${OUTPUT_PATH} (${(buffer.length / 1024).toFixed(0)}KB)`);
  } catch (err) {
    console.error(`[Test] ❌ API error: ${err.message}`);
    process.exit(1);
  }
}

main();
