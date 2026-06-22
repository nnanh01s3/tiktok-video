/**
 * Test Veo 3.1 Lite WITH product image reference (v5).
 *
 * Per user feedback: visual must match the actual product, not a generic
 * vacuum. Pass the prepared 1080x1920 JPG as image input so Veo uses the
 * real product as visual anchor.
 *
 * Run: node scripts/test-hook-v5-lite-with-image.mjs
 */
import "../src/env.js";
import { generateScripts, prepareImages } from "../src/shopee/veo_hook.mjs";
import { generateVideo } from "../src/veo.js";
import { readFileSync, mkdirSync } from "fs";

const cache = JSON.parse(readFileSync("D:/tiktok/data/shopee/products_cache.json", "utf8"));
const item = cache.products.find(p => String(p.item_id) === "25834872656");
const b = item.batch_item_for_item_card_full || {};
const product = {
  itemId: String(item.item_id),
  name: b.name || "",
  price: Math.round((b.price || 0) / 100_000),
  sold: b.historical_sold || 0,
  image: "https://down-vn.img.susercontent.com/file/" + b.image,
  _raw: item,
};

console.log("Testing Veo 3.1 Lite WITH product image for:", product.name);
console.log("");

const workDir = "D:/tiktok/data/shopee/_test_veo_hook/v5_workdir";
mkdirSync(workDir, { recursive: true });

// Step 1: download + pad product images to 1080x1920
console.log("Step 1: prepareImages...");
const images = await prepareImages(product, workDir);
console.log("  → got", images.length, "padded images, using img_0:", images[0]);
console.log("");

// Step 2: Claude generate Veo prompt + voiceover script
console.log("Step 2: generateScripts...");
const scripts = await generateScripts(product, "urgent");
console.log("═══ veoHookPrompt ═══");
console.log(scripts.veoHookPrompt);
console.log("");
console.log("═══ voiceoverScript ═══");
console.log(scripts.voiceoverScript);
console.log("");

// Step 3: Veo 3.1 Lite WITH image reference
const outputPath = "D:/tiktok/data/shopee/_test_veo_hook/v5_lite_with_image.mp4";
console.log("Step 3: Veo 3.1 Lite generation with product image...");
const result = await generateVideo(scripts.veoHookPrompt, outputPath, {
  model: "lite",          // Veo 3.1 Lite — native audio + lip-sync
  aspectRatio: "9:16",
  image: images[0],       // Product image as visual anchor
});
console.log("");
console.log("✅ Done:", result);
console.log("Output:", outputPath);
