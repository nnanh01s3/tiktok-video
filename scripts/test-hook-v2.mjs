/**
 * Test the updated Veo hook (v2: female voice, MC prompt, signature, info-dense 8s).
 * Picks one product, runs full pipeline (real Veo call), saves to /tmp.
 *
 * Run: node scripts/test-hook-v2.mjs
 */
import "../src/env.js";
import { generateVeoHookVideo } from "../src/shopee/veo_hook.mjs";
import { readFileSync } from "fs";

const cache = JSON.parse(readFileSync("D:/tiktok/data/shopee/products_cache.json", "utf8"));
// Find Máy Hút Bụi TAMASHIO 25834872656 (used in tonight's the_thao run, has CSV)
const item = cache.products.find(p => String(p.item_id) === "25834872656")
  || cache.products.find(p => !p.batch_item_for_item_card_full?.video_info_list?.length);

const b = item.batch_item_for_item_card_full || {};
const product = {
  itemId: String(item.item_id),
  name: b.name || "Test product",
  price: Math.round((b.price || 0) / 100_000),
  sold: b.historical_sold || 0,
  image: "https://down-vn.img.susercontent.com/file/" + b.image,
  _raw: item,
};

const outputPath = "D:/tiktok/data/shopee/_test_veo_hook/v2_test.mp4";
console.log("Testing with product:", product.itemId);
console.log("  name:  ", product.name);
console.log("  sold:  ", product.sold);
console.log("  price: ", product.price.toLocaleString("vi") + "đ");
console.log("");

const r = await generateVeoHookVideo(product, outputPath, {
  style: "urgent",       // → female Zephyr voice + energetic
  pageName: "Thể Thao & Outdoor",
});
console.log("\nResult:", r);
console.log("\nOutput file:", outputPath);
