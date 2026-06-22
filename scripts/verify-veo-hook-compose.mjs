/**
 * End-to-end smoke test for veo_hook with mock-veo (no Veo quota spent).
 * Picks the first cached product without a video and runs the full pipeline.
 *
 * Run: node scripts/verify-veo-hook-compose.mjs
 */
import { generateVeoHookVideo } from "../src/shopee/veo_hook.mjs";
import { readFileSync, existsSync, statSync } from "fs";

const cache = JSON.parse(readFileSync("D:/tiktok/data/shopee/products_cache.json", "utf8"));
const item = cache.products.find(p => !p.batch_item_for_item_card_full?.video_info_list?.length);
if (!item) {
  console.error("No no-video product in cache to test with");
  process.exit(1);
}
const b = item.batch_item_for_item_card_full || {};
const product = {
  itemId: String(item.item_id),
  name: b.name || "Test product",
  price: Math.round((b.price || 0) / 100_000),
  image: "https://down-vn.img.susercontent.com/file/" + b.image,
  _raw: item,
};

const outputPath = "D:/tiktok/data/shopee/_test_veo_hook/verify_final.mp4";
console.log("Testing with product:", product.itemId, product.name?.slice(0, 50));

const r = await generateVeoHookVideo(product, outputPath, { mockVeo: true, cleanup: false });
console.log("Result:", r);

let pass = true;
if (!existsSync(outputPath)) { pass = false; console.error("FAIL: output missing"); }
else {
  const sz = statSync(outputPath).size;
  if (sz < 500_000) { pass = false; console.error(`FAIL: output too small (${sz} bytes)`); }
  else console.log(`PASS: ${(sz / 1024 / 1024).toFixed(1)}MB`);
  if (r.duration < 55 || r.duration > 75) { pass = false; console.error(`FAIL: duration ${r.duration}s out of [55,75]`); }
  else console.log(`PASS: duration ${r.duration}s`);
}

process.exit(pass ? 0 : 1);
