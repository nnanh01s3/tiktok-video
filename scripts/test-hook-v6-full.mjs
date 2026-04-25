/**
 * Test v6 full pipeline: Veo Lite + image + native audio +
 * Gemini TTS extended + slideshow + auto-loop + overlays + signature.
 *
 * Run: node scripts/test-hook-v6-full.mjs
 */
import "../src/env.js";
import { generateVeoHookVideo } from "../src/shopee/veo_hook.mjs";
import { readFileSync } from "fs";

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

const outputPath = "D:/tiktok/data/shopee/_test_veo_hook/v6_full.mp4";
console.log("v6 full test:", product.itemId, product.name);
console.log("");

const r = await generateVeoHookVideo(product, outputPath, {
  style: "urgent",
  pageName: "Thể Thao & Outdoor",
  targetDuration: 35,
  cleanup: false,  // keep intermediates so we can debug if needed
});
console.log("\n✅", r);
