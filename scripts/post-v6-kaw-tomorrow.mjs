/**
 * One-shot post script: upload v6_kaw.mp4 to "Sưu Tầm Hàng Dị" page,
 * schedule for tomorrow 06:00 Vietnam time.
 *
 * Run: node scripts/post-v6-kaw-tomorrow.mjs
 */
import "../src/env.js";
import { createPoster } from "../src/social-poster.js";
import { PAGES } from "../src/shopee/config.mjs";
import { genCaptionAI, genCaptionFallback } from "../src/shopee/caption.mjs";
import { getShortLinkFromCsv } from "../src/shopee/short_link_lookup.mjs";
import { readFileSync, writeFileSync, existsSync } from "fs";

const VIDEO_PATH = "D:/tiktok/data/shopee/_test_veo_hook/v6_kaw.mp4";
const PAGE_KEY = "shopee";
const ITEM_ID = "26835798547";
const PRODUCT_NAME = "Áo Điều Hòa KAW – Làm Mát Cơ Thể, Quạt Gió 2 Chiều, Pin Sạc Dài Lâu";
const SHOP_NAME = "Shopee";

if (!existsSync(VIDEO_PATH)) {
  console.error("Video not found:", VIDEO_PATH);
  process.exit(1);
}

const PAGE = PAGES[PAGE_KEY];
const poster = createPoster(PAGE);

// Compute target = tomorrow 06:00 Vietnam time (system clock = SEAST = UTC+7)
const target = new Date();
target.setDate(target.getDate() + 1);
target.setHours(6, 0, 0, 0);
const scheduledAt = target.toISOString().replace(/\.\d{3}Z$/, ".000Z");
const minutesFromNow = Math.round((target.getTime() - Date.now()) / 60_000);

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Post v6_kaw.mp4 → Sưu Tầm Hàng Dị (FB)");
console.log("═══════════════════════════════════════════════════════════════");
console.log("Now:        ", new Date().toLocaleString("vi-VN"));
console.log("Target:     ", target.toLocaleString("vi-VN"), `(in ${minutesFromNow} min)`);
console.log("Page:       ", PAGE.name, `(${PAGE.pfmId})`);
console.log("Video:      ", VIDEO_PATH);
console.log("");

// 1. Caption
const { platform, niche, pageName } = PAGE.caption;
let caption = await genCaptionAI(PRODUCT_NAME, SHOP_NAME, pageName, niche, platform);
if (!caption) caption = genCaptionFallback(PRODUCT_NAME, pageName, niche);

const shortLink = getShortLinkFromCsv(ITEM_ID);
if (!shortLink) {
  console.error("FATAL: no CSV short link for", ITEM_ID);
  process.exit(1);
}
const captionWithLink = `${caption}\n\n🛒 Mua ngay: ${shortLink}`;
console.log("Caption:");
console.log("---");
console.log(captionWithLink);
console.log("---\n");

// 2. Upload
console.log("Uploading to PostForMe...");
const mediaRef = await poster.upload(VIDEO_PATH);
console.log("  ✅ mediaRef:", mediaRef.slice(0, 60));

// 3. Schedule FB
console.log("Scheduling FB post...");
const result = await poster.scheduleFacebook({ mediaRef, caption: captionWithLink, scheduledAt });
const fbPostId = result.postId || result.postIds?.[0];
console.log("  ✅ FB scheduled:", scheduledAt, "| Post ID:", fbPostId);

// 4. Update state.json (dedup)
const STATE_FILE = "D:/tiktok/data/shopee/shopee/state.json";
const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
state.used_shopee_ids = [...new Set([...state.used_shopee_ids, ITEM_ID])];
state.posts_today = state.posts_today || [];
state.posts_today.push({
  fbPostId,
  shopeeItemId: ITEM_ID,
  productName: PRODUCT_NAME.slice(0, 100),
  affiliateLink: null,
  isVeoHook: true,
  veoTier: "lite",
  at: new Date().toISOString(),
  scheduledAt,
});
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
console.log("  ✅ state.json updated (lifetime count:", state.used_shopee_ids.length, "items)");

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  DONE — kiểm tra https://app.postforme.dev/ scheduled queue");
console.log("═══════════════════════════════════════════════════════════════");
