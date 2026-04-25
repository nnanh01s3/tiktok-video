/**
 * Test Veo 3 native audio + lip-sync hook (v4).
 *
 * Strategy: skip Gemini TTS entirely. Veo 3 standard tier renders MC speaking
 * the hook line with native audio + lip-sync. 8s clip = potentially the entire
 * "hook video" (or first segment of a longer composed video).
 *
 * Run: node scripts/test-hook-v4-veo3.mjs
 */
import "../src/env.js";
import { generateScripts } from "../src/shopee/veo_hook.mjs";
import { generateVideo } from "../src/veo.js";
import { readFileSync } from "fs";

const cache = JSON.parse(readFileSync("D:/tiktok/data/shopee/products_cache.json", "utf8"));
const item = cache.products.find(p => String(p.item_id) === "25834872656");
const b = item.batch_item_for_item_card_full || {};
const product = {
  itemId: String(item.item_id),
  name: b.name || "",
  price: Math.round((b.price || 0) / 100_000),
  sold: b.historical_sold || 0,
};

console.log("Testing Veo 3 native-audio hook for:", product.name);
console.log("");

// Step 1: Get Claude to generate veoHookPrompt + voiceoverScript
const scripts = await generateScripts(product, "urgent");
console.log("═══ Generated veoHookPrompt ═══");
console.log(scripts.veoHookPrompt);
console.log("");
console.log("═══ Generated voiceoverScript ═══");
console.log(scripts.voiceoverScript);
console.log("");

// Step 2: Call Veo 3 standard with NO image (let Veo design the scene + MC freely)
const outputPath = "D:/tiktok/data/shopee/_test_veo_hook/v4_veo3_lite.mp4";
console.log("Generating Veo 3.1 Lite clip (~$0.15, ~1-3 min)...");
const result = await generateVideo(scripts.veoHookPrompt, outputPath, {
  model: "lite",   // Veo 3.1 Lite — native audio + lip-sync, cheapest
  aspectRatio: "9:16",
});
console.log("");
console.log("✅ Done:", result);
console.log("Output:", outputPath);
